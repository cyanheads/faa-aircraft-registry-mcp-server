/**
 * @fileoverview The FAA registry ingester — the one irreducibly per-source part
 * of the mirror. Downloads `ReleasableAircraft.zip`, reads the entries, parses
 * the reference files (ACFTREF/ENGINE) and the status files (DEREG/RESERVED),
 * then streams the pre-joined `registration` rows (MASTER-1…MASTER-9) as mirror
 * pages with decoded make/model/engine labels resolved from the reference maps.
 *
 * The FAA daily ZIP is a full snapshot, not a delta — so both `init` and
 * `refresh` perform a full rebuild. The ingester wipes the primary and auxiliary
 * tables at the start of a run (via the raw handle) so a record that disappeared
 * from MASTER (e.g. deregistered) does not linger, then repopulates everything.
 * @module services/registry/ingest
 */

import type { MirrorRow, SqliteHandle, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { type CsvRow, parseCsv } from './csv.js';
import { cleanField, normalizeNNumber, parseFaaDate, parseIntField } from './normalize.js';
import {
  AIRCRAFT_REF_FTS,
  AIRCRAFT_REF_TABLE,
  DEREG_TABLE,
  ENGINE_REF_TABLE,
  ensureAuxiliaryTables,
  REGISTRATION_TABLE,
  RESERVED_TABLE,
} from './schema.js';
import { readZipEntries } from './zip.js';

/** How many MASTER parts the FAA splits the registration master across. */
const MASTER_PART_COUNT = 9;
/** Rows per yielded mirror page — bounds the per-transaction batch. */
const PAGE_SIZE = 5000;

/** A minimal engine reference, kept in memory for the MASTER join. */
interface EngineRef {
  engineTypeCode: string | undefined;
  mfr: string | undefined;
  model: string | undefined;
}

/** A minimal aircraft reference, kept in memory for the MASTER join. */
interface AircraftRef {
  aircraftTypeCode: string | undefined;
  engineTypeCode: string | undefined;
  mfr: string | undefined;
  model: string | undefined;
}

/** Resolve a ZIP entry by case-insensitive base name. */
function findEntry(
  entries: { name: string; data: Buffer }[],
  baseName: string,
): Buffer | undefined {
  const target = baseName.toLowerCase();
  const hit = entries.find((e) => {
    const base = e.name.split('/').pop()?.toLowerCase() ?? '';
    return base === target;
  });
  return hit?.data;
}

/** Pick the first present value across candidate header keys (FAA naming drift). */
function pick(row: CsvRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return;
}

/** Truncate the primary and auxiliary tables for a clean full rebuild. */
function wipeTables(handle: SqliteHandle): void {
  handle.transaction(() => {
    for (const table of [
      REGISTRATION_TABLE,
      AIRCRAFT_REF_TABLE,
      AIRCRAFT_REF_FTS,
      ENGINE_REF_TABLE,
      DEREG_TABLE,
      RESERVED_TABLE,
    ]) {
      handle.exec(`DELETE FROM ${table};`);
    }
  });
}

/** Parse ENGINE.txt into an in-memory map and populate the engine_ref table. */
function ingestEngines(handle: SqliteHandle, content: string): Map<string, EngineRef> {
  const map = new Map<string, EngineRef>();
  const insert = handle.prepare(
    `INSERT OR REPLACE INTO ${ENGINE_REF_TABLE}
       (code, mfr, model, engine_type_code, horsepower, thrust)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  handle.transaction(() => {
    for (const row of parseCsv(content)) {
      const code = cleanField(pick(row, 'CODE'));
      if (!code) continue;
      const mfr = cleanField(pick(row, 'MFR', 'MANUFACTURER'));
      const model = cleanField(pick(row, 'MODEL'));
      const engineTypeCode = cleanField(pick(row, 'TYPE', 'TYPE-ENG', 'TYPE ENG'));
      map.set(code, { mfr, model, engineTypeCode });
      insert.run(
        code,
        mfr ?? null,
        model ?? null,
        engineTypeCode ?? null,
        parseIntField(pick(row, 'HORSEPOWER', 'HP')) ?? null,
        parseIntField(pick(row, 'THRUST')) ?? null,
      );
    }
  });
  return map;
}

/** Parse ACFTREF.txt into an in-memory map and populate aircraft_ref + its FTS. */
function ingestAircraftRef(handle: SqliteHandle, content: string): Map<string, AircraftRef> {
  const map = new Map<string, AircraftRef>();
  const insert = handle.prepare(
    `INSERT OR REPLACE INTO ${AIRCRAFT_REF_TABLE}
       (code, mfr, model, aircraft_type_code, engine_type_code, category_code,
        builder_cert_code, num_engines, num_seats, weight_class, cruise_speed,
        tc_data_sheet, tc_data_holder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = handle.prepare(
    `INSERT INTO ${AIRCRAFT_REF_FTS} (code, mfr, model) VALUES (?, ?, ?)`,
  );
  handle.transaction(() => {
    for (const row of parseCsv(content)) {
      const code = cleanField(pick(row, 'CODE'));
      if (!code) continue;
      const mfr = cleanField(pick(row, 'MFR', 'MANUFACTURER'));
      const model = cleanField(pick(row, 'MODEL'));
      const aircraftTypeCode = cleanField(pick(row, 'TYPE-ACFT', 'TYPE ACFT', 'TYPE-AIRCRAFT'));
      const engineTypeCode = cleanField(pick(row, 'TYPE-ENG', 'TYPE ENG', 'TYPE-ENGINE'));
      map.set(code, { mfr, model, aircraftTypeCode, engineTypeCode });
      insert.run(
        code,
        mfr ?? null,
        model ?? null,
        aircraftTypeCode ?? null,
        engineTypeCode ?? null,
        cleanField(pick(row, 'AC-CAT', 'AC CAT')) ?? null,
        cleanField(pick(row, 'BUILD-CERT-IND', 'BUILD CERT IND')) ?? null,
        parseIntField(pick(row, 'NO-ENG', 'NO ENG')) ?? null,
        parseIntField(pick(row, 'NO-SEATS', 'NO SEATS')) ?? null,
        cleanField(pick(row, 'AC-WEIGHT', 'AC WEIGHT')) ?? null,
        parseIntField(pick(row, 'SPEED')) ?? null,
        cleanField(pick(row, 'TC-DATA-SHEET', 'TC DATA SHEET')) ?? null,
        cleanField(pick(row, 'TC-DATA-HOLDER', 'TC DATA HOLDER')) ?? null,
      );
      insertFts.run(code, mfr ?? '', model ?? '');
    }
  });
  return map;
}

/** Parse DEREG.txt and populate the dereg table (both address blocks retained). */
function ingestDereg(handle: SqliteHandle, content: string): number {
  const insert = handle.prepare(
    `INSERT INTO ${DEREG_TABLE}
       (n_number, serial_number, mfr_mdl_code, status_code, cancel_date, mode_s_code_hex,
        owner_name, street, street2, city, state, zip,
        physical_address, physical_address2, physical_city, physical_state,
        physical_zip, physical_county, physical_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  handle.transaction(() => {
    for (const row of parseCsv(content)) {
      const nRaw = pick(row, 'N-NUMBER', 'N NUMBER');
      if (!cleanField(nRaw)) continue;
      const nNumber = normalizeNNumber(nRaw ?? '');
      insert.run(
        nNumber,
        cleanField(pick(row, 'SERIAL-NUMBER', 'SERIAL NUMBER')) ?? null,
        cleanField(pick(row, 'MFR-MDL-CODE', 'MFR MDL CODE')) ?? null,
        cleanField(pick(row, 'STATUS-CODE', 'STATUS CODE')) ?? null,
        parseFaaDate(pick(row, 'CANCEL-DATE', 'CANCEL DATE')) ?? null,
        cleanField(pick(row, 'MODE S CODE HEX', 'MODE-S-CODE-HEX')) ?? null,
        cleanField(pick(row, 'NAME')) ?? null,
        cleanField(pick(row, 'STREET-MAIL', 'STREET')) ?? null,
        cleanField(pick(row, 'STREET2-MAIL', 'STREET2', 'STREET 2')) ?? null,
        cleanField(pick(row, 'CITY-MAIL', 'CITY')) ?? null,
        cleanField(pick(row, 'STATE-ABBREV-MAIL', 'STATE')) ?? null,
        cleanField(pick(row, 'ZIP-CODE-MAIL', 'ZIP CODE', 'ZIP')) ?? null,
        cleanField(pick(row, 'STREET-PHYSICAL', 'PHYSICAL ADDRESS', 'PHYSICAL-ADDRESS')) ?? null,
        cleanField(pick(row, 'STREET2-PHYSICAL', '2ND PHYSICAL ADDRESS', 'PHYSICAL ADDRESS2')) ??
          null,
        cleanField(pick(row, 'CITY-PHYSICAL', 'PHYSICAL CITY', 'PHYSICAL-CITY')) ?? null,
        cleanField(pick(row, 'STATE-ABBREV-PHYSICAL', 'PHYSICAL STATE', 'PHYSICAL-STATE')) ?? null,
        cleanField(pick(row, 'ZIP-CODE-PHYSICAL', 'PHYSICAL ZIP', 'PHYSICAL-ZIP')) ?? null,
        cleanField(pick(row, 'COUNTY-PHYSICAL', 'PHYSICAL COUNTY', 'PHYSICAL-COUNTY')) ?? null,
        cleanField(pick(row, 'COUNTRY-PHYSICAL', 'PHYSICAL COUNTRY', 'PHYSICAL-COUNTRY')) ?? null,
      );
      count++;
    }
  });
  return count;
}

/** Parse RESERVED.txt and populate the reserved table. */
function ingestReserved(handle: SqliteHandle, content: string): number {
  const insert = handle.prepare(
    `INSERT INTO ${RESERVED_TABLE}
       (n_number, registrant, street, street2, city, state, zip,
        type_reservation_code, reserve_date, expiration_notice_date, purge_date, n_number_for_change)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  handle.transaction(() => {
    for (const row of parseCsv(content)) {
      const nRaw = pick(row, 'N-NUMBER', 'N NUMBER');
      if (!cleanField(nRaw)) continue;
      const nNumber = normalizeNNumber(nRaw ?? '');
      insert.run(
        nNumber,
        cleanField(pick(row, 'REGISTRANT', 'NAME')) ?? null,
        cleanField(pick(row, 'STREET')) ?? null,
        cleanField(pick(row, 'STREET2', 'STREET 2')) ?? null,
        cleanField(pick(row, 'CITY')) ?? null,
        cleanField(pick(row, 'STATE')) ?? null,
        cleanField(pick(row, 'ZIP CODE', 'ZIP')) ?? null,
        cleanField(pick(row, 'TR', 'TYPE RESERVATION', 'TYPE-RESERVATION')) ?? null,
        parseFaaDate(pick(row, 'RSV DATE', 'RSV-DATE', 'RESERVE DATE')) ?? null,
        parseFaaDate(pick(row, 'EXP DATE', 'EXP-DATE', 'EXPIRATION DATE')) ?? null,
        parseFaaDate(pick(row, 'PURGE DATE', 'PURGE-DATE')) ?? null,
        cleanField(pick(row, 'N-NUM-CHG', 'N NUM CHG', 'N-NUMBER-FOR-CHANGE')) ?? null,
      );
      count++;
    }
  });
  return count;
}

/**
 * The CERTIFICATION field is a 10-char compound: char 1 is the airworthiness
 * class, chars 2–10 are class-dependent approved-operation sub-codes. Split it
 * into the class char and the raw operations string.
 */
function splitCertification(raw: string | undefined): {
  airworthinessClass?: string;
  approvedOperationsRaw?: string;
} {
  const cleaned = cleanField(raw);
  if (!cleaned) return {};
  const airworthinessClass = cleaned.slice(0, 1);
  const approvedOperationsRaw = cleanField(cleaned.slice(1));
  return {
    ...(airworthinessClass ? { airworthinessClass } : {}),
    ...(approvedOperationsRaw ? { approvedOperationsRaw } : {}),
  };
}

/** Collect the 1–5 OTHER NAMES columns into a JSON array string (or null). */
function collectOtherNames(row: CsvRow): string | null {
  const names: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const value = cleanField(
      pick(row, `OTHER NAMES(${i})`, `OTHER NAMES ${i}`, `OTHER-NAMES-${i}`),
    );
    if (value) names.push(value);
  }
  return names.length > 0 ? JSON.stringify(names) : null;
}

/** Map one MASTER row to a pre-joined `registration` mirror row, or null if no N-number. */
function masterRowToRecord(
  row: CsvRow,
  aircraftRefs: Map<string, AircraftRef>,
  engineRefs: Map<string, EngineRef>,
): MirrorRow | null {
  const nRaw = pick(row, 'N-NUMBER', 'N NUMBER');
  if (!cleanField(nRaw)) return null;
  const nNumber = normalizeNNumber(nRaw ?? '');

  const mfrMdlCode = cleanField(pick(row, 'MFR MDL CODE', 'MFR-MDL-CODE'));
  const engMfrMdlCode = cleanField(pick(row, 'ENG MFR MDL', 'ENG-MFR-MDL', 'ENG MFR MDL CODE'));
  const aircraftRef = mfrMdlCode ? aircraftRefs.get(mfrMdlCode) : undefined;
  const engineRef = engMfrMdlCode ? engineRefs.get(engMfrMdlCode) : undefined;

  const cert = splitCertification(pick(row, 'CERTIFICATION', 'CERT'));

  return {
    n_number: nNumber,
    serial_number: cleanField(pick(row, 'SERIAL NUMBER', 'SERIAL-NUMBER')) ?? null,
    mfr_mdl_code: mfrMdlCode ?? null,
    eng_mfr_mdl_code: engMfrMdlCode ?? null,
    make: aircraftRef?.mfr ?? null,
    model: aircraftRef?.model ?? null,
    aircraft_type_code: aircraftRef?.aircraftTypeCode ?? null,
    engine_type_code: engineRef?.engineTypeCode ?? aircraftRef?.engineTypeCode ?? null,
    engine_make: engineRef?.mfr ?? null,
    engine_model: engineRef?.model ?? null,
    year_mfr: parseIntField(pick(row, 'YEAR MFR', 'YEAR-MFR')) ?? null,
    type_registrant_code: cleanField(pick(row, 'TYPE REGISTRANT', 'TYPE-REGISTRANT')) ?? null,
    owner_name: cleanField(pick(row, 'NAME')) ?? null,
    street: cleanField(pick(row, 'STREET')) ?? null,
    street2: cleanField(pick(row, 'STREET2', 'STREET 2')) ?? null,
    city: cleanField(pick(row, 'CITY')) ?? null,
    state: cleanField(pick(row, 'STATE')) ?? null,
    zip: cleanField(pick(row, 'ZIP CODE', 'ZIP')) ?? null,
    region_code: cleanField(pick(row, 'REGION')) ?? null,
    county: cleanField(pick(row, 'COUNTY')) ?? null,
    country: cleanField(pick(row, 'COUNTRY')) ?? null,
    last_action_date: parseFaaDate(pick(row, 'LAST ACTION DATE', 'LAST-ACTION-DATE')) ?? null,
    cert_issue_date: parseFaaDate(pick(row, 'CERT ISSUE DATE', 'CERT-ISSUE-DATE')) ?? null,
    airworthiness_class_code: cert.airworthinessClass ?? null,
    approved_operations_raw: cert.approvedOperationsRaw ?? null,
    status_code: cleanField(pick(row, 'STATUS CODE', 'STATUS-CODE')) ?? null,
    mode_s_code_octal: cleanField(pick(row, 'MODE S CODE', 'MODE-S-CODE')) ?? null,
    mode_s_code_hex: cleanField(pick(row, 'MODE S CODE HEX', 'MODE-S-CODE-HEX')) ?? null,
    fractional_owner: cleanField(pick(row, 'FRACT OWNER', 'FRACT-OWNER')) ?? null,
    airworthiness_date: parseFaaDate(pick(row, 'AIR WORTH DATE', 'AIR-WORTH-DATE')) ?? null,
    other_names: collectOtherNames(row),
    expiration_date: parseFaaDate(pick(row, 'EXPIRATION DATE', 'EXPIRATION-DATE')) ?? null,
    unique_id: cleanField(pick(row, 'UNIQUE ID', 'UNIQUE-ID')) ?? null,
    kit_mfr: cleanField(pick(row, 'KIT MFR', 'KIT-MFR')) ?? null,
    kit_model: cleanField(pick(row, 'KIT MODEL', 'KIT-MODEL')) ?? null,
  };
}

/**
 * Identifying User-Agent for the FAA download. The registry endpoint (Akamai-
 * fronted) returns 403 to requests sent with no User-Agent or a generic `curl/*`
 * agent, so a plain identifying agent is required for the bulk ZIP to download at
 * all. Names the project (no parenthetical/URL — the WAF rejects those) so the FAA
 * can attribute the traffic; the runtime default `fetch` sends no UA and is blocked.
 */
const DOWNLOAD_USER_AGENT = 'faa-aircraft-registry-mcp-server';

/** Download the FAA ZIP into a buffer. */
async function downloadZip(url: string, signal: AbortSignal): Promise<Buffer> {
  logger.info(`Downloading FAA registry archive from ${url}`);
  const response = await fetch(url, {
    signal,
    headers: { 'User-Agent': DOWNLOAD_USER_AGENT, Accept: '*/*' },
  });
  if (!response.ok) {
    throw new Error(
      `FAA registry download failed: HTTP ${response.status} from ${url}. ` +
        'The FAA endpoint rejects requests without an identifying User-Agent; if this persists ' +
        'the registry URL or its access policy may have changed (override with FAA_DATABASE_URL).',
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Build the FAA registry ingester. The returned generator wipes the tables, loads
 * the reference + status files, then streams pre-joined `registration` pages from
 * all nine MASTER parts. It closes over a `getHandle` accessor so it can populate
 * the auxiliary tables (which the framework's `query()` does not manage).
 *
 * @param getHandle - Accessor for the mirror's opened raw SQLite handle.
 * @param sourceUrl - URL of `ReleasableAircraft.zip`.
 */
export function createFaaIngester(
  getHandle: () => Promise<SqliteHandle>,
  sourceUrl: string,
): (ctx: SyncContext) => AsyncGenerator<SyncPage> {
  return async function* sync({ mode, signal }: SyncContext): AsyncGenerator<SyncPage> {
    const buffer = await downloadZip(sourceUrl, signal);
    const entries = readZipEntries(buffer);
    logger.info(`FAA archive extracted: ${entries.length} entries (mode: ${mode})`);

    const handle = await getHandle();
    // The framework's migration runner skips migrations on a fresh DB, so the
    // auxiliary tables may not exist yet on a cold init. Create them idempotently
    // before wiping/populating so the first run can't hit "no such table".
    ensureAuxiliaryTables(handle);
    wipeTables(handle);

    const engineContent = findEntry(entries, 'ENGINE.txt');
    const engineRefs = engineContent
      ? ingestEngines(handle, engineContent.toString('latin1'))
      : new Map<string, EngineRef>();
    logger.info(`Ingested ${engineRefs.size} engine reference rows`);

    const acftContent = findEntry(entries, 'ACFTREF.txt');
    const aircraftRefs = acftContent
      ? ingestAircraftRef(handle, acftContent.toString('latin1'))
      : new Map<string, AircraftRef>();
    logger.info(`Ingested ${aircraftRefs.size} aircraft reference rows`);

    const deregContent = findEntry(entries, 'DEREG.txt');
    const deregCount = deregContent ? ingestDereg(handle, deregContent.toString('latin1')) : 0;
    logger.info(`Ingested ${deregCount} deregistered rows`);

    const reservedContent = findEntry(entries, 'RESERVED.txt');
    const reservedCount = reservedContent
      ? ingestReserved(handle, reservedContent.toString('latin1'))
      : 0;
    logger.info(`Ingested ${reservedCount} reserved rows`);

    // Stream the nine MASTER parts as registration pages. A missing part is
    // skipped (the FAA may publish fewer than nine in some releases), but at
    // least one must be present or the rebuild produced an empty primary table.
    let masterPartsFound = 0;
    let page: MirrorRow[] = [];
    let totalRecords = 0;

    for (let part = 1; part <= MASTER_PART_COUNT; part++) {
      if (signal.aborted) return;
      const content = findEntry(entries, `MASTER-${part}.txt`);
      if (!content) continue;
      masterPartsFound++;
      for (const row of parseCsv(content.toString('latin1'))) {
        const record = masterRowToRecord(row, aircraftRefs, engineRefs);
        if (!record) continue;
        page.push(record);
        if (page.length >= PAGE_SIZE) {
          totalRecords += page.length;
          yield { records: page };
          page = [];
        }
      }
    }

    if (masterPartsFound === 0) {
      // Fall back to a legacy single MASTER.txt only if the split parts are
      // entirely absent — surfaces loudly rather than silently empty.
      const legacy = findEntry(entries, 'MASTER.txt');
      if (legacy) {
        masterPartsFound = 1;
        for (const row of parseCsv(legacy.toString('latin1'))) {
          const record = masterRowToRecord(row, aircraftRefs, engineRefs);
          if (!record) continue;
          page.push(record);
          if (page.length >= PAGE_SIZE) {
            totalRecords += page.length;
            yield { records: page };
            page = [];
          }
        }
      }
    }

    if (page.length > 0) {
      totalRecords += page.length;
      yield { records: page };
    }

    if (masterPartsFound === 0) {
      throw new Error(
        'FAA archive contained no MASTER parts (MASTER-1.txt…MASTER-9.txt or MASTER.txt). ' +
          'The registry layout may have changed — verify against the live ZIP.',
      );
    }
    logger.info(
      `FAA registration ingest complete: ${totalRecords} records across ${masterPartsFound} MASTER part(s)`,
    );
  };
}
