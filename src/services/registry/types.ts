/**
 * @fileoverview Domain types for the FAA registry service — the decoded,
 * redaction-aware shapes returned to tool handlers. Raw single-char codes are
 * preserved alongside their decoded labels so an agent gets human-readable
 * values without losing the canonical code. Permissible (often-blank) fields are
 * optional and never fabricated from a blank upstream field.
 * @module services/registry/types
 */

import type { SqlValue } from '@cyanheads/mcp-ts-core/mirror';

/** A coded field surfaced as both its raw code and decoded label. */
export interface CodedValue {
  /** The raw code as stored in the registry. */
  code: string;
  /** The decoded human-readable label, omitted when the code is unknown. */
  label?: string;
}

/** Owner / registrant block — present only when PII redaction is off. */
export interface OwnerDetail {
  city?: string;
  country?: string;
  county?: string;
  name?: string;
  /** Co-owner names (1–5), only when PII is unredacted. */
  otherNames?: string[];
  state?: string;
  street?: string;
  street2?: string;
  /** Registrant type (Individual / LLC / Corporation / …). */
  typeRegistrant?: CodedValue;
  zip?: string;
}

/** A full active-registration record (MASTER, pre-joined with ACFTREF/ENGINE). */
export interface RegistrationRecord {
  aircraftType?: CodedValue;
  airworthinessClass?: CodedValue;
  airworthinessDate?: string;
  /** Raw approved-operations sub-code string (chars 2–10 of CERTIFICATION). */
  approvedOperationsRaw?: string;
  certIssueDate?: string;
  engineMake?: string;
  engineManufacturerModelCode?: string;
  engineModel?: string;
  engineType?: CodedValue;
  expirationDate?: string;
  /** Always set (defaults to false) — the registry's fractional-ownership flag. */
  fractionalOwner: boolean;
  kitManufacturer?: string;
  kitModel?: string;
  lastActionDate?: string;
  make?: string;
  manufacturerModelCode?: string;
  model?: string;
  /** ICAO 24-bit address (hex) — the key opensky uses for live flight data. */
  modeSCodeHex?: string;
  modeSCodeOctal?: string;
  /** Normalized N-number without the leading `N`. */
  nNumber: string;
  /** With the conventional leading `N`, for display. */
  nNumberDisplay: string;
  /** Owner block — present only when redaction is off. */
  owner?: OwnerDetail;
  /** True when owner PII was withheld from this payload by the redaction gate. */
  ownerRedacted: boolean;
  region?: CodedValue;
  serialNumber?: string;
  status?: CodedValue;
  uniqueId?: string;
  yearManufactured?: number;
}

/** An aircraft reference record (ACFTREF), decoded. */
export interface AircraftTypeRecord {
  aircraftType?: CodedValue;
  builderCertification?: CodedValue;
  category?: CodedValue;
  /** 7-char manufacturer/model/series code. */
  code: string;
  cruiseSpeedMph?: number;
  engineType?: CodedValue;
  manufacturer?: string;
  model?: string;
  numberOfEngines?: number;
  numberOfSeats?: number;
  typeCertificateDataHolder?: string;
  typeCertificateDataSheet?: string;
  /** Literal weight class string (e.g. `CLASS 1`). */
  weightClass?: string;
}

/** A summary row from a registration search (decoded, redaction-aware). */
export interface RegistrationSummary {
  aircraftType?: CodedValue;
  make?: string;
  model?: string;
  modeSCodeHex?: string;
  nNumber: string;
  nNumberDisplay: string;
  /** Registrant name — present only when redaction is off. */
  ownerName?: string;
  ownerRedacted: boolean;
  state?: string;
  status?: CodedValue;
  yearManufactured?: number;
}

/** A summary row from an aircraft-type search. */
export interface AircraftTypeSummary {
  aircraftType?: CodedValue;
  category?: CodedValue;
  code: string;
  manufacturer?: string;
  model?: string;
  numberOfEngines?: number;
  numberOfSeats?: number;
}

/** Discriminated registration-status resolution across all three status files. */
export type RegistrationStatusResult =
  | {
      recordType: 'active';
      nNumber: string;
      nNumberDisplay: string;
      status?: CodedValue;
      airworthinessClass?: CodedValue;
      certIssueDate?: string;
      expirationDate?: string;
      airworthinessDate?: string;
    }
  | {
      recordType: 'deregistered';
      nNumber: string;
      nNumberDisplay: string;
      status?: CodedValue;
      cancelDate?: string;
      serialNumber?: string;
      manufacturerModelCode?: string;
      modeSCodeHex?: string;
    }
  | {
      recordType: 'reserved';
      nNumber: string;
      nNumberDisplay: string;
      typeReservation?: CodedValue;
      reserveDate?: string;
      expirationNoticeDate?: string;
      purgeDate?: string;
      nNumberForChange?: string;
    }
  | {
      recordType: 'unknown';
      nNumber: string;
      nNumberDisplay: string;
    };

/** Search filters for {@link RegistryService.searchRegistrations}. */
export interface RegistrationSearchFilters {
  aircraftType?: string;
  limit: number;
  makeModel?: string;
  modeSCode?: string;
  ownerName?: string;
  state?: string;
}

/** Search filters for {@link RegistryService.searchAircraftTypes}. */
export interface AircraftTypeSearchFilters {
  aircraftType?: string;
  category?: string;
  limit: number;
  query?: string;
}

/** A result page that discloses truncation against the requested cap. */
export interface SearchPage<T> {
  /** The limit applied. */
  cap: number;
  items: T[];
  /** True when the result set was capped at the limit. */
  truncated: boolean;
}

/** A raw mirror row keyed by declared column. */
export type Row = Record<string, SqlValue>;

/**
 * Strip keys whose value is `undefined`, returning a value that satisfies
 * `exactOptionalPropertyTypes` (an absent optional property, not one set to
 * `undefined`). Lets a mapper assemble a flat object with `field: value ?? undefined`
 * and drop the blanks in one pass instead of dozens of conditional spreads.
 */
export function compact<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
