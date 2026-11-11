/**
 * @fileoverview Registry service — the read path over the on-disk FAA SQLite
 * mirror. Reads lookup, status and search results in one SQLite snapshot per
 * request, applying manufacturer and owner redaction before results are exposed.
 * @module services/registry/registry-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { Mirror, SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import {
  decodeAircraftCategory,
  decodeAirworthinessClass,
  decodeApprovedOperations,
  decodeBuilderCert,
  decodeFractionalOwner,
  decodeRegion,
  decodeStatusCode,
  decodeTypeAircraft,
  decodeTypeEngine,
  decodeTypeRegistrant,
  decodeTypeReservation,
  decodeWeightClass,
} from './decode.js';
import {
  cleanField,
  displayNNumber,
  isValidAircraftCode,
  isValidNNumber,
  normalizeNNumber,
} from './normalize.js';
import { createRegistryMirror } from './registry-mirror.js';
import {
  REGISTRATION_REFERENCE_JOIN,
  readAircraftTypes,
  readRegistrations,
  visibleManufacturer,
} from './registry-search.js';
import { type RegistrySnapshot, withRegistrySnapshot } from './registry-snapshot.js';
import {
  AIRCRAFT_REF_TABLE,
  DEREG_TABLE,
  ENGINE_REF_TABLE,
  REGISTRATION_TABLE,
  RESERVED_TABLE,
} from './schema.js';
import {
  type AircraftTypeRecord,
  type AircraftTypeSearchFilters,
  type AircraftTypeSummary,
  type CancellationRecord,
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

type SnapshotObserver = (snapshot: RegistrySnapshot) => void;

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
    this.mirror = createRegistryMirror(options);
  }

  /** Whether owner-name search is permitted (false when PII is redacted). */
  get ownerSearchEnabled(): boolean {
    return !this.redactOwnerPii;
  }

  /** The underlying mirror — exposed for the lifecycle CLI and scheduler. */
  get mirrorInstance(): Mirror {
    return this.mirror;
  }

  private async read<T>(
    query: (handle: SqliteHandle) => T,
    onSnapshot: SnapshotObserver | undefined,
  ): Promise<T> {
    const handle = await this.mirror.raw();
    return withRegistrySnapshot(handle, (snapshot) => {
      const result = query(handle);
      onSnapshot?.(snapshot);
      return result;
    });
  }

  /**
   * Reject a malformed N-number before it becomes a misleading not-found/unknown
   * answer. Shared by lookupRegistration + getRegistrationStatus (and, through
   * lookupRegistration, the resource). Carries the contract `reason` on the wire;
   * the framework fills the declaring tool's or resource's `recovery` hint.
   */
  private failInvalidNNumber(input: string): never {
    throw validationError(
      `"${input}" is not a valid US N-number. Expected 1–5 characters after an optional leading "N": a leading digit 1–9, then digits, optionally ending in one or two letters (I and O are not used). Example: N172SP.`,
      { reason: 'invalid_n_number' },
    );
  }

  /** Reject a malformed manufacturer/model/series code before querying. */
  private failInvalidCode(input: string): never {
    throw validationError(
      `"${input}" is not a valid manufacturer/model/series code. Expected 6–7 uppercase alphanumeric characters (e.g. "2072714"). Discover codes with faa_search_aircraft_types.`,
      { reason: 'invalid_code' },
    );
  }

  /** Lookup one active registration by N-number, fully decoded and joined. */
  lookupRegistration(
    nNumberInput: string,
    ctx: Context,
    onSnapshot?: SnapshotObserver,
  ): Promise<RegistrationRecord | undefined> {
    return this.read((handle) => {
      const nNumber = normalizeNNumber(nNumberInput);
      if (!isValidNNumber(nNumber)) this.failInvalidNNumber(nNumberInput);
      ctx.log.debug('Looking up registration', { nNumber });
      const row = handle
        .prepare<Row>(
          `SELECT r.*, ${visibleManufacturer('r.make', this.redactOwnerPii)} AS visible_make,
                ref.mfr AS reference_make,
                ${visibleManufacturer('ref.mfr', this.redactOwnerPii)} AS visible_reference_make,
                engine.horsepower, engine.thrust
           FROM ${REGISTRATION_TABLE} AS r ${REGISTRATION_REFERENCE_JOIN}
           LEFT JOIN ${ENGINE_REF_TABLE} AS engine ON engine.code = r.eng_mfr_mdl_code
          WHERE r.n_number = ?`,
        )
        .get(nNumber);
      return row ? this.toRegistrationRecord(row) : undefined;
    }, onSnapshot);
  }

  /** Decode a 6–7-character manufacturer/model/series code to aircraft specs. */
  getAircraftType(
    codeInput: string,
    ctx: Context,
    onSnapshot?: SnapshotObserver,
  ): Promise<AircraftTypeRecord | undefined> {
    return this.read((handle) => {
      const code = codeInput.trim().toUpperCase();
      if (!isValidAircraftCode(code)) this.failInvalidCode(codeInput);
      ctx.log.debug('Looking up aircraft type', { code });
      const row = handle
        .prepare<Row>(
          `SELECT ref.*, ${visibleManufacturer('ref.mfr', this.redactOwnerPii)} AS visible_make
           FROM ${AIRCRAFT_REF_TABLE} AS ref WHERE ref.code = ?`,
        )
        .get(code);
      return row ? this.toAircraftTypeRecord(row) : undefined;
    }, onSnapshot);
  }

  /** Search active registrations by owner/make-model/state/type/Mode S code. */
  searchRegistrations(
    filters: RegistrationSearchFilters,
    ctx: Context,
    onSnapshot?: SnapshotObserver,
  ): Promise<SearchPage<RegistrationSummary>> {
    return this.read((handle) => {
      const code = filters.manufacturerModelCode?.trim().toUpperCase();
      if (code && !isValidAircraftCode(code)) this.failInvalidCode(code);
      ctx.log.debug('Searching registrations', { limit: filters.limit, offset: filters.offset });
      const page = readRegistrations(handle, filters, this.redactOwnerPii, code);
      return { ...page, items: page.items.map((row) => this.toRegistrationSummary(row)) };
    }, onSnapshot);
  }

  /** Search the aircraft reference table via its FTS index + optional filters. */
  searchAircraftTypes(
    filters: AircraftTypeSearchFilters,
    ctx: Context,
    onSnapshot?: SnapshotObserver,
  ): Promise<SearchPage<AircraftTypeSummary>> {
    return this.read((handle) => {
      ctx.log.debug('Searching aircraft types', { limit: filters.limit, offset: filters.offset });
      const page = readAircraftTypes(handle, filters, this.redactOwnerPii);
      return { ...page, items: page.items.map((row) => this.toAircraftTypeSummary(row)) };
    }, onSnapshot);
  }

  /**
   * Resolve registration + airworthiness status across all three status files in
   * priority order — active (MASTER), reserved, then deregistered.
   * Returns a discriminated `recordType`; an unmatched number is a valid
   * `'unknown'` answer. Cancellation history follows the number across assignments.
   */
  getRegistrationStatus(
    nNumberInput: string,
    ctx: Context,
    onSnapshot?: SnapshotObserver,
  ): Promise<RegistrationStatusResult> {
    return this.read((handle) => {
      const nNumber = normalizeNNumber(nNumberInput);
      if (!isValidNNumber(nNumber)) this.failInvalidNNumber(nNumberInput);
      ctx.log.debug('Resolving registration status', { nNumber });
      return this.readRegistrationStatus(handle, nNumber);
    }, onSnapshot);
  }

  private readRegistrationStatus(handle: SqliteHandle, nNumber: string): RegistrationStatusResult {
    const history = handle
      .prepare<Row>(
        `SELECT d.cancel_date, d.serial_number, d.mfr_mdl_code, d.status_code,
              d.export_country, d.year_mfr, d.mode_s_code_hex, ref.model,
              ${visibleManufacturer('ref.mfr', this.redactOwnerPii)} AS visible_make
         FROM ${DEREG_TABLE} AS d
         LEFT JOIN ${AIRCRAFT_REF_TABLE} AS ref ON ref.code = d.mfr_mdl_code
        WHERE d.n_number = ?
        ORDER BY NULLIF(d.cancel_date, '') DESC, d.rowid`,
      )
      .all(nNumber);
    const cancellations = history.map((row) =>
      compact<CancellationRecord>({
        cancelDate: str(row, 'cancel_date'),
        serialNumber: str(row, 'serial_number'),
        manufacturerModelCode: str(row, 'mfr_mdl_code'),
        make: str(row, 'visible_make'),
        model: str(row, 'model'),
        exportCountry: str(row, 'export_country'),
        status: coded(str(row, 'status_code'), decodeStatusCode),
      }),
    );
    const current = {
      nNumber,
      nNumberDisplay: displayNNumber(nNumber),
      cancellations: cancellations.length > 0 ? cancellations : undefined,
    };

    const active = handle
      .prepare<Row>(
        `SELECT status_code, airworthiness_class_code, cert_issue_date, expiration_date, airworthiness_date
         FROM ${REGISTRATION_TABLE} WHERE n_number = ?`,
      )
      .get(nNumber);
    if (active) {
      return compact<Extract<RegistrationStatusResult, { recordType: 'active' }>>({
        ...current,
        recordType: 'active',
        status: coded(str(active, 'status_code'), decodeStatusCode),
        airworthinessClass: coded(
          str(active, 'airworthiness_class_code'),
          decodeAirworthinessClass,
        ),
        certIssueDate: str(active, 'cert_issue_date'),
        expirationDate: str(active, 'expiration_date'),
        airworthinessDate: str(active, 'airworthiness_date'),
      });
    }

    const reserved = handle
      .prepare<Row>(
        `SELECT type_reservation_code, reserve_date, expiration_notice_date, purge_date, n_number_for_change
         FROM ${RESERVED_TABLE} WHERE n_number = ? ORDER BY reserve_date DESC, rowid LIMIT 1`,
      )
      .get(nNumber);
    if (reserved) {
      return compact<Extract<RegistrationStatusResult, { recordType: 'reserved' }>>({
        ...current,
        recordType: 'reserved',
        typeReservation: coded(str(reserved, 'type_reservation_code'), decodeTypeReservation),
        reserveDate: str(reserved, 'reserve_date'),
        expirationNoticeDate: str(reserved, 'expiration_notice_date'),
        purgeDate: str(reserved, 'purge_date'),
        nNumberForChange: str(reserved, 'n_number_for_change'),
      });
    }

    const latest = history[0];
    if (latest) {
      return compact<Extract<RegistrationStatusResult, { recordType: 'deregistered' }>>({
        ...current,
        ...cancellations[0],
        recordType: 'deregistered',
        modeSCodeHex: str(latest, 'mode_s_code_hex'),
        yearManufactured: numZeroAsBlank(latest, 'year_mfr'),
      });
    }

    return { recordType: 'unknown', nNumber, nNumberDisplay: current.nNumberDisplay };
  }

  // --- Row → domain mappers ---

  /** Map a `registration` row to a full decoded record, redacting owner PII. */
  private toRegistrationRecord(row: Row): RegistrationRecord {
    const nNumber = String(row.n_number);
    const make = str(row, 'visible_make');
    const kitManufacturer = str(row, 'kit_mfr');
    const kitName = kitManufacturer?.toUpperCase();
    const hiddenKit =
      this.redactOwnerPii &&
      kitName !== undefined &&
      ((!str(row, 'visible_reference_make') &&
        kitName === str(row, 'reference_make')?.toUpperCase()) ||
        (!make && kitName === str(row, 'make')?.toUpperCase()));
    const classCode = str(row, 'airworthiness_class_code');
    const rawOperations = row.approved_operations_raw;
    return compact<RegistrationRecord>({
      nNumber,
      nNumberDisplay: displayNNumber(nNumber),
      ownerRedacted: this.redactOwnerPii,
      fractionalOwner: decodeFractionalOwner(str(row, 'fractional_owner')),
      serialNumber: str(row, 'serial_number'),
      manufacturerModelCode: str(row, 'mfr_mdl_code'),
      engineManufacturerModelCode: str(row, 'eng_mfr_mdl_code'),
      make,
      model: str(row, 'model'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      engineType: coded(str(row, 'engine_type_code'), decodeTypeEngine),
      engineMake: str(row, 'engine_make'),
      engineModel: str(row, 'engine_model'),
      engineHorsepower: numZeroAsBlank(row, 'horsepower'),
      engineThrustLbs: numZeroAsBlank(row, 'thrust'),
      yearManufactured: numZeroAsBlank(row, 'year_mfr'),
      region: coded(str(row, 'region_code'), decodeRegion),
      lastActionDate: str(row, 'last_action_date'),
      certIssueDate: str(row, 'cert_issue_date'),
      airworthinessClass: coded(classCode, decodeAirworthinessClass),
      approvedOperations: decodeApprovedOperations(
        classCode,
        typeof rawOperations === 'string' ? rawOperations : undefined,
      ),
      approvedOperationsRaw: str(row, 'approved_operations_raw'),
      status: coded(str(row, 'status_code'), decodeStatusCode),
      airworthinessDate: str(row, 'airworthiness_date'),
      expirationDate: str(row, 'expiration_date'),
      modeSCodeOctal: str(row, 'mode_s_code_octal'),
      modeSCodeHex: str(row, 'mode_s_code_hex'),
      uniqueId: str(row, 'unique_id'),
      kitManufacturer: hiddenKit ? undefined : kitManufacturer,
      kitModel: str(row, 'kit_model'),
      owner: this.redactOwnerPii ? undefined : this.buildOwnerDetail(row),
    });
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
      make: str(row, 'visible_make'),
      manufacturerModelCode: str(row, 'mfr_mdl_code'),
      model: str(row, 'model'),
      yearManufactured: numZeroAsBlank(row, 'year_mfr'),
      state: str(row, 'state'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      status: coded(str(row, 'status_code'), decodeStatusCode),
      modeSCodeHex: str(row, 'mode_s_code_hex'),
      serialNumber: str(row, 'serial_number'),
      ownerName: this.redactOwnerPii ? undefined : str(row, 'owner_name'),
    });
  }

  /** Map an `aircraft_ref` row to a full decoded record. */
  private toAircraftTypeRecord(row: Row): AircraftTypeRecord {
    return compact<AircraftTypeRecord>({
      code: String(row.code),
      manufacturer: str(row, 'visible_make'),
      model: str(row, 'model'),
      aircraftType: coded(str(row, 'aircraft_type_code'), decodeTypeAircraft),
      engineType: coded(str(row, 'engine_type_code'), decodeTypeEngine),
      category: coded(str(row, 'category_code'), decodeAircraftCategory),
      builderCertification: coded(str(row, 'builder_cert_code'), decodeBuilderCert),
      // num_engines keeps a literal 0 — a real value for unpowered aircraft (gliders, balloons), not a blank sentinel.
      numberOfEngines: num(row, 'num_engines'),
      numberOfSeats: numZeroAsBlank(row, 'num_seats'),
      weightClass: str(row, 'weight_class'),
      weightClassLabel: decodeWeightClass(str(row, 'weight_class')),
      cruiseSpeedMph: numZeroAsBlank(row, 'cruise_speed'),
      typeCertificateDataSheet: str(row, 'tc_data_sheet'),
      typeCertificateDataHolder: str(row, 'tc_data_holder'),
    });
  }

  /** Map an `aircraft_ref` row to a search summary. */
  private toAircraftTypeSummary(row: Row): AircraftTypeSummary {
    return compact<AircraftTypeSummary>({
      code: String(row.code),
      manufacturer: str(row, 'visible_make'),
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
