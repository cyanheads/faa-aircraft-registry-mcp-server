/**
 * @fileoverview Static FAA decode tables — the small categorical maps from the
 * `ardata.pdf` data dictionary (rev. 2025-05-08), applied at query time. Codes
 * are stored raw in the index; the label is resolved here so a correction is a
 * code change, not a re-ingest. Every decoder returns `undefined` for an unknown
 * or blank code so callers can omit the label rather than fabricate one.
 * @module services/registry/decode
 */

/** Look up a code in a map, normalizing case/whitespace; undefined when blank/unknown. */
function decode(
  map: Readonly<Record<string, string>>,
  code: string | null | undefined,
): string | undefined {
  if (code === null || code === undefined) return;
  const key = code.trim().toUpperCase();
  if (key === '') return;
  return map[key];
}

/** Type Registrant (MASTER) / Type Registration (DEREG). */
const TYPE_REGISTRANT: Readonly<Record<string, string>> = {
  '1': 'Individual',
  '2': 'Partnership',
  '3': 'Corporation',
  '4': 'Co-Owned',
  '5': 'Government',
  '7': 'LLC',
  '8': 'Non-Citizen Corporation',
  '9': 'Non-Citizen Co-Owned',
};

/** Type Aircraft. */
const TYPE_AIRCRAFT: Readonly<Record<string, string>> = {
  '1': 'Glider',
  '2': 'Balloon',
  '3': 'Blimp/Dirigible',
  '4': 'Fixed-wing single-engine',
  '5': 'Fixed-wing multi-engine',
  '6': 'Rotorcraft',
  '7': 'Weight-shift-control',
  '8': 'Powered Parachute',
  '9': 'Gyroplane',
  H: 'Hybrid Lift',
  O: 'Other',
};

/** Type Engine. */
const TYPE_ENGINE: Readonly<Record<string, string>> = {
  '0': 'None',
  '1': 'Reciprocating',
  '2': 'Turbo-prop',
  '3': 'Turbo-shaft',
  '4': 'Turbo-jet',
  '5': 'Turbo-fan',
  '6': 'Ramjet',
  '7': '2-Cycle',
  '8': '4-Cycle',
  '9': 'Unknown',
  '10': 'Electric',
  '11': 'Rotary',
};

/**
 * Status Code (MASTER / DEREG). Letters from the dictionary plus the numeric
 * 1–29 notice/expiry/cancellation lifecycle states.
 */
const STATUS_CODE: Readonly<Record<string, string>> = {
  A: 'Triennial form mailed, not returned by USPS',
  D: 'Expired Dealer',
  E: 'Revoked by enforcement',
  M: 'Valid, assigned to manufacturer under Dealer Certificate',
  N: 'Non-citizen corporation, no flight-hour report',
  R: 'Registration pending',
  S: 'Second Triennial form mailed, not returned',
  T: 'Valid (Trainee)',
  V: 'Valid registration',
  W: 'Certificate ineffective/invalid',
  X: 'Enforcement letter',
  Z: 'Permanent Reserved',
  '1': 'Triennial Aircraft Registration form returned by the Post Office as undeliverable',
  '2': 'N-Number assigned but not yet registered',
  '3': 'N-Number assigned as a Non Type Certificated aircraft but not yet registered',
  '4': 'N-Number assigned as import but not yet registered',
  '5': 'Reserved N-Number',
  '6': 'Administratively canceled',
  '7': 'Sale reported',
  '8': 'Second attempt mailing a Triennial Aircraft Registration form to the owner with no response',
  '9': 'Certificate of Registration revoked',
  '10': 'N-Number assigned, not registered, pending cancellation',
  '11': 'N-Number assigned as Non Type Certificated (Amateur), not registered, pending cancellation',
  '12': 'N-Number assigned as import, not registered, pending cancellation',
  '13': 'Registration Expired',
  '14': 'First Notice for Re-Registration/Renewal',
  '15': 'Second Notice for Re-Registration/Renewal',
  '16': 'Registration Expired – Pending Cancellation',
  '17': 'Sale Reported – Pending Cancellation',
  '18': 'Sale Reported – Canceled',
  '19': 'Registration Pending – Pending Cancellation',
  '20': 'Registration Pending – Canceled',
  '21': 'Revoked – Pending Cancellation',
  '22': 'Revoked – Canceled',
  '23': 'Expired Dealer (Pending Cancellation)',
  '24': 'Third Notice for Re-Registration/Renewal',
  '25': 'First Notice for Registration Renewal',
  '26': 'Second Notice for Registration Renewal',
  '27': 'Registration Expired',
  '28': 'Third Notice for Registration Renewal',
  '29': 'Registration Expired – Pending Cancellation',
};

/** Registrant's Region. */
const REGION: Readonly<Record<string, string>> = {
  '1': 'Eastern',
  '2': 'Southwestern',
  '3': 'Central',
  '4': 'Western-Pacific',
  '5': 'Alaskan',
  '7': 'Southern',
  '8': 'European',
  C: 'Great Lakes',
  E: 'New England',
  S: 'Northwest Mountain',
};

/** Airworthiness Classification — CERTIFICATION field char 1. */
const AIRWORTHINESS_CLASS: Readonly<Record<string, string>> = {
  '1': 'Standard',
  '2': 'Limited',
  '3': 'Restricted',
  '4': 'Experimental',
  '5': 'Provisional',
  '6': 'Multiple',
  '7': 'Primary',
  '8': 'Special Flight Permit',
  '9': 'Light Sport',
};

/** Aircraft Category — ACFTREF AC-CAT. */
const AIRCRAFT_CATEGORY: Readonly<Record<string, string>> = {
  '1': 'Land',
  '2': 'Sea',
  '3': 'Amphibian',
};

/** Builder Certification — ACFTREF BUILD-CERT-IND. */
const BUILDER_CERT: Readonly<Record<string, string>> = {
  '0': 'Type Certificated',
  '1': 'Not Type Certificated',
  '2': 'Light Sport',
};

/** ACFTREF Aircraft Weight — maximum gross takeoff weight in pounds. */
const WEIGHT_CLASS: Readonly<Record<string, string>> = {
  'CLASS 1': 'Maximum gross takeoff weight up to 12,499 lb',
  'CLASS 2': 'Maximum gross takeoff weight 12,500–19,999 lb',
  'CLASS 3': 'Maximum gross takeoff weight 20,000 lb and over',
  'CLASS 4': 'Maximum gross takeoff weight: UAV up to 55 lb',
};

/** Type Reservation — RESERVED TR. */
const TYPE_RESERVATION: Readonly<Record<string, string>> = {
  AA: 'Reserved — no fee',
  A: 'Fee paid, expiry notice sent',
  HD: '2-year hold for cancelled N-numbers',
  FN: 'Fee paid, notice sent',
  FP: 'Fee paid',
  MF: 'Reserved to manufacturer — no fee, no expiry',
  MT: 'Reserved to manufacturer — temporary',
  NC: 'N-Number change in process',
  NN: 'N-Number change, expiry notice sent',
  CN: 'N-Number change, expire notice sent',
  CE: 'N-Number change expired',
};

export const decodeTypeRegistrant = (c?: string | null) => decode(TYPE_REGISTRANT, c);
export const decodeTypeAircraft = (c?: string | null) => decode(TYPE_AIRCRAFT, c);
export const decodeTypeEngine = (c?: string | null) => decode(TYPE_ENGINE, c);
export const decodeStatusCode = (c?: string | null) => decode(STATUS_CODE, c);
export const decodeRegion = (c?: string | null) => decode(REGION, c);
export const decodeAirworthinessClass = (c?: string | null) => decode(AIRWORTHINESS_CLASS, c);
export const decodeAircraftCategory = (c?: string | null) => decode(AIRCRAFT_CATEGORY, c);
export const decodeBuilderCert = (c?: string | null) => decode(BUILDER_CERT, c);
export const decodeTypeReservation = (c?: string | null) => decode(TYPE_RESERVATION, c);
/** Decode the FAA maximum gross takeoff weight range without replacing the raw class. */
export const decodeWeightClass = (c?: string | null) => decode(WEIGHT_CLASS, c);

/** Fractional-owner flag — `Y` means fractional ownership; blank means not. */
export function decodeFractionalOwner(c?: string | null): boolean {
  return (c ?? '').trim().toUpperCase() === 'Y';
}
