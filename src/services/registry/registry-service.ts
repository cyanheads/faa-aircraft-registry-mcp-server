/**
 * @fileoverview Registry service — the read path over the on-disk FAA SQLite
 * mirror. Owns query, the MASTER→ACFTREF→ENGINE join (resolved at ingest), coded-
 * field decode, and the single owner-PII redaction chokepoint. Built on the
 * framework MirrorService; the index is the source of truth at runtime, so a cold
 * (never-initialized) mirror surfaces a loud `ServiceUnavailable` rather than an
 * empty result — there is no live API to fall back to.
 * @module services/registry/registry-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  defineMirror,
  type Mirror,
  type QueryFilter,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import {
  decodeAircraftCategory,
  decodeAirworthinessClass,
  decodeBuilderCert,
  decodeFractionalOwner,
  decodeRegion,
  decodeStatusCode,
  decodeTypeAircraft,
  decodeTypeEngine,
  decodeTypeRegistrant,
  decodeTypeReservation,
} from './decode.js';
import { createFaaIngester } from './ingest.js';
import {
  cleanField,
  displayNNumber,
  isValidAircraftCode,
  isValidNNumber,
  normalizeNNumber,
  toFtsMatch,
} from './normalize.js';
import {
  AIRCRAFT_REF_FTS,
  AIRCRAFT_REF_FTS_COLUMNS,
  AIRCRAFT_REF_TABLE,
  DEREG_TABLE,
  MAKE_MODEL_FTS_COLUMNS,
  OWNER_FTS_COLUMNS,
  RESERVED_TABLE,
  registrationStoreSpec,
} from './schema.js';
import {
  type AircraftTypeRecord,
  type AircraftTypeSearchFilters,
  type AircraftTypeSummary,
  type CodedValue,
  compact,
  type OwnerDetail,
  type RegistrationRecord,
  type RegistrationSearchFilters,
  type RegistrationStatusResult,
  type RegistrationSummary,
  type Row,
  type SearchPage,
} from './types.js';

/** Server config slice the registry service needs. */
export interface RegistryServiceOptions {
  databaseUrl: string;
  mirrorPath: string;
  redactOwnerPii: boolean;
}

/** Build a `CodedValue` from a raw code + decoder, omitting absent codes. */
function coded(
  code: string | null | undefined,
  decoder: (c?: string | null) => string | undefined,
): CodedValue | undefined {
  const cleaned = cleanField(code ?? undefined);
  if (!cleaned) return;
  const label = decoder(cleaned);
  return label ? { code: cleaned, label } : { code: cleaned };
}

/** Read a string column from a raw row, normalized to `string | undefined`. */
function str(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? cleanField(value) : undefined;
}

/** Read a numeric column from a raw row. */
function num(row: Row, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Read a numeric FAA spec column where the FAA encodes a blank/unknown value as
 * `0` — cruise speed, year manufactured, seats. Maps that `0` to `undefined` so a
 * permissible blank renders as absent, never as a fabricated real value (e.g. a
 * "0 mph" cruise or a "year 0" aircraft). NOT for `num_engines`, where `0` is a
 * legitimate value on unpowered aircraft (gliders, balloons) — use {@link num}.
 */
function numZeroAsBlank(row: Row, key: string): number | undefined {
  const value = num(row, key);
  return value === 0 ? undefined : value;
}

export class RegistryService {
  private readonly mirror: Mirror;
  private readonly redactOwnerPii: boolean;

  constructor(options: RegistryServiceOptions) {
    this.redactOwnerPii = options.redactOwnerPii;
    const store = sqliteMirrorStore(registrationStoreSpec(options.mirrorPath));
    this.mirror = defineMirror({
      name: 'faa-registry',
      store,
      sync: createFaaIngester(() => store.raw(), options.databaseUrl),
    });
  }

  /** Whether owner-name search is permitted (false when PII is redacted). */
  get ownerSearchEnabled(): boolean {
    return !this.redactOwnerPii;
  }

  /** The underlying mirror — exposed for the lifecycle CLI and scheduler. */
  get mirrorInstance(): Mirror {
    return this.mirror;
  }

  /**
   * Assert the mirror has completed at least one full init AND currently holds
   * records. A cold index is a hard failure — there is no live API fallback for
   * this server.
   *
   * `mirror.ready()` reflects only the last sync's completion marker, which
   * survives an interrupted rebuild: the ingester wipes the primary table before
   * reloading it, so a crash/OOM mid-rebuild leaves an empty `registration` table
   * while a prior run's `completedAt` still reports ready. Without the row-count
   * gate every lookup/search/status query returns empty with `isSuccess: true`
   * instead of the loud `ServiceUnavailable` this server promises. The durable
   * fix — an atomic stage-and-swap in the framework MirrorService so a rebuild is
   * never observably empty — is tracked in cyanheads/mcp-ts-core#286.
   */
  private async assertReady(): Promise<void> {
    if (!(await this.mirror.ready())) {
      throw serviceUnavailable(
        'The FAA registry index has not been built yet. Run the mirror:init script to download and index the registry before querying.',
        { reason: 'mirror_not_ready' },
      );
    }
    if ((await this.mirror.store.count()) === 0) {
      throw serviceUnavailable(
        'The FAA registry index is present but empty — a rebuild was likely interrupted before it finished loading. Re-run the mirror:init (or mirror:refresh) script to rebuild the index.',
        { reason: 'mirror_empty' },
      );
    }
  }

  /**
   * Reject a malformed N-number before it becomes a misleading not-found/unknown
   * answer. Shared by lookupRegistration + getRegistrationStatus (and, through
   * lookupRegistration, the resource). Carries the contract `reason` on the wire
   * and the tool's `recovery` hint when the caller declared the matching reason.
   */
  private failInvalidNNumber(input: string, ctx: Context): never {
    throw validationError(
      `"${input}" is not a valid US N-number. Expected 1–5 characters after an optional leading "N": a leading digit 1–9, then digits, optionally ending in one or two letters (I and O are not used). Example: N172SP.`,
      { reason: 'invalid_n_number', ...ctx.recoveryFor('invalid_n_number') },
    );
  }

  /** Reject a malformed manufacturer/model/series code before querying. */
  private failInvalidCode(input: string, ctx: Context): never {
    throw validationError(
      `"${input}" is not a valid manufacturer/model/series code. Expected 6–7 uppercase alphanumeric characters (e.g. "2072714"). Discover codes with faa_search_aircraft_types.`,
      { reason: 'invalid_code', ...ctx.recoveryFor('invalid_code') },
    );
  }

  /** Lookup one active registration by N-number, fully decoded and joined. */
  async lookupRegistration(
    nNumberInput: string,
    ctx: Context,
  ): Promise<RegistrationRecord | undefined> {
    await this.assertReady();
    const nNumber = normalizeNNumber(nNumberInput);
    if (!isValidNNumber(nNumber)) this.failInvalidNNumber(nNumberInput, ctx);
    ctx.log.debug('Looking up registration', { nNumber });
    const rows = await this.mirror.getByIds([nNumber]);
    const row = rows[0];
    if (!row) return;
    return this.toRegistrationRecord(row);
  }

  /** Decode a 7-char manufacturer/model/series code to aircraft specs. */
  async getAircraftType(codeInput: string, ctx: Context): Promise<AircraftTypeRecord | undefined> {
    await this.assertReady();
    const code = codeInput.trim().toUpperCase();
    if (!isValidAircraftCode(code)) this.failInvalidCode(codeInput, ctx);
    ctx.log.debug('Looking up aircraft type', { code });
    const handle = await this.mirror.raw();
    const row = handle.prepare<Row>(`SELECT * FROM ${AIRCRAFT_REF_TABLE} WHERE code = ?`).get(code);
    if (!row) return;
    return this.toAircraftTypeRecord(row);
  }

  /** Search active registrations by owner/make-model/state/type/Mode S code. */
  async searchRegistrations(
    filters: RegistrationSearchFilters,
    ctx: Context,
  ): Promise<SearchPage<RegistrationSummary>> {
    await this.assertReady();
    const structured: QueryFilter[] = [];
    const matchTerms: string[] = [];
    /**
     * A free-text filter whose tokens all escape away (e.g. `"""`) can never
     * match. Short-circuit to an empty page rather than dropping the term, which
     * would silently widen the search to every row.
     */
    let unmatchable = false;
    const pushMatch = (text: string, columns: readonly string[]): void => {
      const clause = toFtsMatch(text, columns);
      if (clause) matchTerms.push(clause);
      else unmatchable = true;
    };

    if (filters.makeModel) pushMatch(filters.makeModel, MAKE_MODEL_FTS_COLUMNS);
    if (filters.ownerName && this.ownerSearchEnabled)
      pushMatch(filters.ownerName, OWNER_FTS_COLUMNS);
    if (filters.state)
      structured.push({ column: 'state', op: 'eq', value: filters.state.trim().toUpperCase() });
    if (filters.aircraftType) {
      structured.push({
        column: 'aircraft_type_code',
        op: 'eq',
        value: filters.aircraftType.trim().toUpperCase(),
      });
    }
    if (filters.modeSCode) {
      structured.push({
        column: 'mode_s_code_hex',
        op: 'eq',
        value: filters.modeSCode.trim().toUpperCase(),
      });
    }

    const match = matchTerms.length > 0 ? matchTerms.join(' AND ') : undefined;
    ctx.log.debug('Searching registrations', {
      match,
      structured: structured.length,
      limit: filters.limit,
      offset: filters.offset,
      unmatchable,
    });

    if (unmatchable) return { items: [], truncated: false, cap: filters.limit, totalCount: 0 };

    const result = await this.mirror.query({
      ...(match ? { match } : {}),
      ...(structured.length > 0 ? { filters: structured } : {}),
      limit: filters.limit,
      offset: filters.offset,
    });

    const items = result.rows.map((row) => this.toRegistrationSummary(row));
    return {
      items,
      truncated: filters.offset + items.length < result.total,
      cap: filters.limit,
      totalCount: result.total,
    };
  }

  /** Search the aircraft reference table via its FTS index + optional filters. */
  async searchAircraftTypes(
    filters: AircraftTypeSearchFilters,
    ctx: Context,
  ): Promise<SearchPage<AircraftTypeSummary>> {
    await this.assertReady();
    const handle = await this.mirror.raw();
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filters.query) {
      const clause = toFtsMatch(filters.query, AIRCRAFT_REF_FTS_COLUMNS);
      // A query that escapes to nothing can never match — see searchRegistrations.
      if (!clause) return { items: [], truncated: false, cap: filters.limit, totalCount: 0 };
      where.push(
        `code IN (SELECT code FROM ${AIRCRAFT_REF_FTS} WHERE ${AIRCRAFT_REF_FTS} MATCH ?)`,
      );
      params.push(clause);
    }
    if (filters.aircraftType) {
      where.push('aircraft_type_code = ?');
      params.push(filters.aircraftType.trim().toUpperCase());
    }
    if (filters.category) {
      where.push('category_code = ?');
      params.push(filters.category.trim().toUpperCase());
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    ctx.log.debug('Searching aircraft types', {
      conditions: where.length,
      limit: filters.limit,
      offset: filters.offset,
    });

    const countRow = handle
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${AIRCRAFT_REF_TABLE} ${whereSql}`)
      .get(...params);
    const total = countRow?.n ?? 0;

    // `code` (the primary key) breaks ties on mfr+model — without it the order of
    // equal-key rows is unspecified, so paged calls could repeat or skip rows.
    const rows = handle
      .prepare<Row>(
        `SELECT * FROM ${AIRCRAFT_REF_TABLE} ${whereSql} ORDER BY mfr, model, code LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit, filters.offset);

    const items = rows.map((row) => this.toAircraftTypeSummary(row));
    return {
      items,
      truncated: filters.offset + items.length < total,
      cap: filters.limit,
      totalCount: total,
    };
  }

  /**
   * Resolve registration + airworthiness status across all three status files in
   * priority order — active (MASTER) wins, then deregistered, then reserved.
   * Returns a discriminated `recordType`; an unmatched number is a valid
   * `'unknown'` answer, not an error.
   */
  async getRegistrationStatus(
    nNumberInput: string,
    ctx: Context,
  ): Promise<RegistrationStatusResult> {
    await this.assertReady();
    const nNumber = normalizeNNumber(nNumberInput);
    if (!isValidNNumber(nNumber)) this.failInvalidNNumber(nNumberInput, ctx);
    const nNumberDisplay = displayNNumber(nNumber);
    ctx.log.debug('Resolving registration status', { nNumber });

    const active = await this.mirror.getByIds([nNumber]);
    if (active[0]) {
      const row = active[0];
      return compact<Extract<RegistrationStatusResult, { recordType: 'active' }>>({
        recordType: 'active',
        nNumber,
        nNumberDisplay,
        status: coded(str(row, 'status_code'), decodeStatusCode),
        airworthinessClass: coded(str(row, 'airworthiness_class_code'), decodeAirworthinessClass),
        certIssueDate: str(row, 'cert_issue_date'),
        expirationDate: str(row, 'expiration_date'),
        airworthinessDate: str(row, 'airworthiness_date'),
      });
    }

    const handle = await this.mirror.raw();

    const dereg = handle
      .prepare<Row>(
        `SELECT * FROM ${DEREG_TABLE} WHERE n_number = ? ORDER BY cancel_date DESC LIMIT 1`,
      )
      .get(nNumber);
    if (dereg) {
      return compact<Extract<RegistrationStatusResult, { recordType: 'deregistered' }>>({
        recordType: 'deregistered',
        nNumber,
        nNumberDisplay,
        status: coded(str(dereg, 'status_code'), decodeStatusCode),
        cancelDate: str(dereg, 'cancel_date'),
        serialNumber: str(dereg, 'serial_number'),
        manufacturerModelCode: str(dereg, 'mfr_mdl_code'),
        modeSCodeHex: str(dereg, 'mode_s_code_hex'),
      });
    }

    const reserved = handle
      .prepare<Row>(
        `SELECT * FROM ${RESERVED_TABLE} WHERE n_number = ? ORDER BY reserve_date DESC LIMIT 1`,
      )
      .get(nNumber);
    if (reserved) {
      return compact<Extract<RegistrationStatusResult, { recordType: 'reserved' }>>({
        recordType: 'reserved',
        nNumber,
        nNumberDisplay,
        typeReservation: coded(str(reserved, 'type_reservation_code'), decodeTypeReservation),
        reserveDate: str(reserved, 'reserve_date'),
        expirationNoticeDate: str(reserved, 'expiration_notice_date'),
        purgeDate: str(reserved, 'purge_date'),
        nNumberForChange: str(reserved, 'n_number_for_change'),
      });
    }

    return { recordType: 'unknown', nNumber, nNumberDisplay };
  }

  // --- Row → domain mappers (decode + redaction applied here) ---

  /** Map a `registration` row to a full decoded record, redacting owner PII. */
  private toRegistrationRecord(row: Row): RegistrationRecord {
    const nNumber = String(row.n_number);
    const record = compact<RegistrationRecord>({
      nNumber,
      nNumberDisplay: displayNNumber(nNumber),
      ownerRedacted: this.redactOwnerPii,
      fractionalOwner: decodeFractionalOwner(str(row, 'fractional_owner')),
      serialNumber: str(row, 'serial_number'),
      manufacturerModelCode: str(row, 'mfr_mdl_code'),
      engineManufacturerModelCode: str(row, 'eng_mfr_mdl_code'),
      make: str(row, 'make'),
      model: str(row, 'model'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      engineType: coded(str(row, 'engine_type_code'), decodeTypeEngine),
      engineMake: str(row, 'engine_make'),
      engineModel: str(row, 'engine_model'),
      yearManufactured: numZeroAsBlank(row, 'year_mfr'),
      region: coded(str(row, 'region_code'), decodeRegion),
      lastActionDate: str(row, 'last_action_date'),
      certIssueDate: str(row, 'cert_issue_date'),
      airworthinessClass: coded(str(row, 'airworthiness_class_code'), decodeAirworthinessClass),
      approvedOperationsRaw: str(row, 'approved_operations_raw'),
      status: coded(str(row, 'status_code'), decodeStatusCode),
      airworthinessDate: str(row, 'airworthiness_date'),
      expirationDate: str(row, 'expiration_date'),
      modeSCodeOctal: str(row, 'mode_s_code_octal'),
      modeSCodeHex: str(row, 'mode_s_code_hex'),
      uniqueId: str(row, 'unique_id'),
      kitManufacturer: str(row, 'kit_mfr'),
      kitModel: str(row, 'kit_model'),
      owner: this.redactOwnerPii ? undefined : this.buildOwnerDetail(row),
    });
    return record;
  }

  /** Build the owner block from a registration row (PII — caller gates this). */
  private buildOwnerDetail(row: Row): OwnerDetail | undefined {
    const otherNames = this.parseOtherNames(str(row, 'other_names'));
    const detail = compact<OwnerDetail>({
      name: str(row, 'owner_name'),
      street: str(row, 'street'),
      street2: str(row, 'street2'),
      city: str(row, 'city'),
      state: str(row, 'state'),
      zip: str(row, 'zip'),
      county: str(row, 'county'),
      country: str(row, 'country'),
      typeRegistrant: coded(str(row, 'type_registrant_code'), decodeTypeRegistrant),
      otherNames: otherNames.length > 0 ? otherNames : undefined,
    });
    return Object.keys(detail).length > 0 ? detail : undefined;
  }

  /** Parse the JSON `other_names` column into a string array. */
  private parseOtherNames(value: string | undefined): string[] {
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Map a `registration` row to a search summary, redacting owner name. */
  private toRegistrationSummary(row: Row): RegistrationSummary {
    const nNumber = String(row.n_number);
    return compact<RegistrationSummary>({
      nNumber,
      nNumberDisplay: displayNNumber(nNumber),
      ownerRedacted: this.redactOwnerPii,
      make: str(row, 'make'),
      model: str(row, 'model'),
      yearManufactured: numZeroAsBlank(row, 'year_mfr'),
      state: str(row, 'state'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      status: coded(str(row, 'status_code'), decodeStatusCode),
      modeSCodeHex: str(row, 'mode_s_code_hex'),
      ownerName: this.redactOwnerPii ? undefined : str(row, 'owner_name'),
    });
  }

  /** Map an `aircraft_ref` row to a full decoded record. */
  private toAircraftTypeRecord(row: Row): AircraftTypeRecord {
    return compact<AircraftTypeRecord>({
      code: String(row.code),
      manufacturer: str(row, 'mfr'),
      model: str(row, 'model'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      engineType: coded(str(row, 'engine_type_code'), decodeTypeEngine),
      category: coded(str(row, 'category_code'), decodeAircraftCategory),
      builderCertification: coded(str(row, 'builder_cert_code'), decodeBuilderCert),
      // num_engines keeps a literal 0 — a real value for unpowered aircraft (gliders, balloons), not a blank sentinel.
      numberOfEngines: num(row, 'num_engines'),
      numberOfSeats: numZeroAsBlank(row, 'num_seats'),
      weightClass: str(row, 'weight_class'),
      cruiseSpeedMph: numZeroAsBlank(row, 'cruise_speed'),
      typeCertificateDataSheet: str(row, 'tc_data_sheet'),
      typeCertificateDataHolder: str(row, 'tc_data_holder'),
    });
  }

  /** Map an `aircraft_ref` row to a search summary. */
  private toAircraftTypeSummary(row: Row): AircraftTypeSummary {
    return compact<AircraftTypeSummary>({
      code: String(row.code),
      manufacturer: str(row, 'mfr'),
      model: str(row, 'model'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      category: coded(str(row, 'category_code'), decodeAircraftCategory),
      // num_engines keeps a literal 0 — a real value for unpowered aircraft (gliders, balloons), not a blank sentinel.
      numberOfEngines: num(row, 'num_engines'),
      numberOfSeats: numZeroAsBlank(row, 'num_seats'),
    });
  }
}

// --- Init/accessor pattern ---

let _service: RegistryService | undefined;

/** Initialize the registry service. Call once in `createApp`'s `setup()`. */
export function initRegistryService(options: RegistryServiceOptions): RegistryService {
  _service = new RegistryService(options);
  return _service;
}

/** Access the initialized registry service. */
export function getRegistryService(): RegistryService {
  if (!_service) {
    throw new Error('RegistryService not initialized — call initRegistryService() in setup().');
  }
  return _service;
}

/** Reset the singleton — test-only. */
export function resetRegistryService(): void {
  _service = undefined;
}
