/**
 * @fileoverview The FAA registry ingester — the one irreducibly per-source part
 * of the mirror. Downloads `ReleasableAircraft.zip`, opens the archive, and reads
 * each entry on demand — one decompressed file resident at a time — parsing the
 * reference files (ACFTREF/ENGINE) and the status files (DEREG/RESERVED), then
 * streaming the pre-joined `registration` rows (MASTER-1…MASTER-9, or a single
 * legacy MASTER.txt) as mirror pages with decoded make/model/engine labels
 * resolved from the reference maps.
 *
 * Peak memory is bounded by the largest single file, not the sum of all of them.
 * Four levers, in order of measured impact: entries are inflated lazily (one file
 * resident at a time), with zlib's output sized to the known length so it never
 * transiently doubles its buffer; a synchronous GC hint runs on each batch
 * boundary so the parse churn doesn't ratchet the heap (and thus RSS) up toward
 * the total processed size; each file is parsed as a line stream (never a
 * whole-file decode); and the auxiliary inserts are chunked into bounded
 * transactions. Together they keep the rebuild within a fixed budget as the
 * dataset grows.
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
import { openZipArchive, type ZipArchive } from './zip.js';

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

/**
 * Best-effort synchronous full-GC hint, called on each insert-batch and MASTER-page
 * boundary. The rebuild churns through ~1 GB of short-lived parse garbage; a long
 * synchronous ingest loop never yields for the runtime's own collector, so the JSC
 * heap — and thus RSS, a high-water mark that never shrinks back — otherwise
 * ratchets up toward the *total* processed size rather than the live working set.
 * Collecting at each batch boundary caps the high-water near the live set (the
 * single largest lever on peak RSS, alongside sizing the inflate to avoid zlib's
 * doubling transient). A no-op when the runtime exposes no GC hook — correctness
 * never depends on it, only the memory ceiling does. Bun exposes `Bun.gc`; Node
 * exposes `global.gc` only under `--expose-gc`.
 */
const reclaimMemory: () => void = (() => {
  const runtime = globalThis as { Bun?: { gc(synchronous: boolean): void }; gc?: () => void };
  if (runtime.Bun) return () => runtime.Bun?.gc(true);
  if (runtime.gc) return () => runtime.gc?.();
  return () => {};
})();

/**
 * Apply `onRow` to every parsed row of `content`, committing every {@link PAGE_SIZE}
 * rows in a bounded transaction — mirroring the MASTER pass's paging so no single
 * auxiliary-table transaction spans an entire large file (which grows the WAL by
 * the whole table before one checkpoint). The pending batch is itself capped at
 * {@link PAGE_SIZE} rows, so it adds only a small, fixed transient.
 */
function ingestBatched(handle: SqliteHandle, content: Buffer, onRow: (row: CsvRow) => void): void {
  let batch: CsvRow[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    handle.transaction(() => {
      for (const row of batch) onRow(row);
    });
    batch = [];
    reclaimMemory();
  };
  for (const row of parseCsv(content)) {
    batch.push(row);
    if (batch.length >= PAGE_SIZE) flush();
  }
  flush();
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
function ingestEngines(handle: SqliteHandle, content: Buffer | undefined): Map<string, EngineRef> {
  const map = new Map<string, EngineRef>();
  if (!content) return map;
  const insert = handle.prepare(
    `INSERT OR REPLACE INTO ${ENGINE_REF_TABLE}
       (code, mfr, model, engine_type_code, horsepower, thrust)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ingestBatched(handle, content, (row) => {
    const code = cleanField(pick(row, 'CODE'));
    if (!code) return;
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
  });
  return map;
}

/** Parse ACFTREF.txt into an in-memory map and populate aircraft_ref + its FTS. */
function ingestAircraftRef(
  handle: SqliteHandle,
  content: Buffer | undefined,
): Map<string, AircraftRef> {
  const map = new Map<string, AircraftRef>();
  if (!content) return map;
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
  ingestBatched(handle, content, (row) => {
    const code = cleanField(pick(row, 'CODE'));
    if (!code) return;
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
  });
  return map;
}

/** Parse DEREG.txt and populate the dereg table (both address blocks retained). */
function ingestDereg(handle: SqliteHandle, content: Buffer | undefined): number {
  if (!content) return 0;
  const insert = handle.prepare(
    `INSERT INTO ${DEREG_TABLE}
       (n_number, serial_number, mfr_mdl_code, status_code, cancel_date, mode_s_code_hex,
        owner_name, street, street2, city, state, zip,
        physical_address, physical_address2, physical_city, physical_state,
        physical_zip, physical_county, physical_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  ingestBatched(handle, content, (row) => {
    const nRaw = pick(row, 'N-NUMBER', 'N NUMBER');
    if (!cleanField(nRaw)) return;
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
  });
  return count;
}

/** Parse RESERVED.txt and populate the reserved table. */
function ingestReserved(handle: SqliteHandle, content: Buffer | undefined): number {
  if (!content) return 0;
  const insert = handle.prepare(
    `INSERT INTO ${RESERVED_TABLE}
       (n_number, registrant, street, street2, city, state, zip,
        type_reservation_code, reserve_date, expiration_notice_date, purge_date, n_number_for_change)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  ingestBatched(handle, content, (row) => {
    const nRaw = pick(row, 'N-NUMBER', 'N NUMBER');
    if (!cleanField(nRaw)) return;
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
 * Yield each MASTER source buffer one at a time — the split parts
 * (MASTER-1.txt…MASTER-9.txt) when the archive ships them, else the single legacy
 * MASTER.txt. Each buffer is inflated on demand as the generator advances, so only
 * one MASTER file is decompressed and resident at a time.
 */
function* masterSources(archive: ZipArchive): Generator<Buffer> {
  let splitPartsFound = 0;
  for (let part = 1; part <= MASTER_PART_COUNT; part++) {
    const content = archive.readEntry(`MASTER-${part}.txt`);
    if (content) {
      splitPartsFound++;
      yield content;
    }
  }
  // Fall back to a legacy single MASTER.txt only when no split parts are present.
  if (splitPartsFound === 0) {
    const legacy = archive.readEntry('MASTER.txt');
    if (legacy) yield legacy;
  }
}

/**
 * Build the FAA registry ingester. The returned generator wipes the tables, loads
 * the reference + status files, then streams pre-joined `registration` pages from
 * the MASTER file(s). It closes over a `getHandle` accessor so it can populate the
 * auxiliary tables (which the framework's `query()` does not manage).
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
    const archive = openZipArchive(buffer);
    logger.info(`FAA archive opened: ${archive.entryNames.length} entries (mode: ${mode})`);

    const handle = await getHandle();
    // The framework's migration runner skips migrations on a fresh DB, so the
    // auxiliary tables may not exist yet on a cold init. Create them idempotently
    // before wiping/populating so the first run can't hit "no such table".
    ensureAuxiliaryTables(handle);
    wipeTables(handle);

    // Each reference/status entry is inflated on demand, consumed, then dropped
    // before the next is read — so at most one decompressed file (plus the small
    // in-memory ref maps) is resident, and peak scales with the largest file.
    const engineRefs = ingestEngines(handle, archive.readEntry('ENGINE.txt'));
    logger.info(`Ingested ${engineRefs.size} engine reference rows`);

    const aircraftRefs = ingestAircraftRef(handle, archive.readEntry('ACFTREF.txt'));
    logger.info(`Ingested ${aircraftRefs.size} aircraft reference rows`);

    const deregCount = ingestDereg(handle, archive.readEntry('DEREG.txt'));
    logger.info(`Ingested ${deregCount} deregistered rows`);

    const reservedCount = ingestReserved(handle, archive.readEntry('RESERVED.txt'));
    logger.info(`Ingested ${reservedCount} reserved rows`);

    // Stream the MASTER file(s) as registration pages — the split parts if the
    // archive ships them, else the single legacy MASTER.txt (see masterSources).
    // At least one must be present, or the rebuild produced an empty primary table.
    let masterPartsFound = 0;
    let page: MirrorRow[] = [];
    let totalRecords = 0;

    for (const content of masterSources(archive)) {
      if (signal.aborted) return;
      masterPartsFound++;
      for (const row of parseCsv(content)) {
        const record = masterRowToRecord(row, aircraftRefs, engineRefs);
        if (!record) continue;
        page.push(record);
        if (page.length >= PAGE_SIZE) {
          totalRecords += page.length;
          yield { records: page };
          page = [];
          reclaimMemory();
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
