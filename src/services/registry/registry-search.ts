/** @fileoverview Indexed registry search and shared manufacturer visibility policy. */

import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { cleanField, normalizeExactFilter, toFtsMatch } from './normalize.js';
import {
  AIRCRAFT_REF_FTS,
  AIRCRAFT_REF_FTS_COLUMNS,
  AIRCRAFT_REF_TABLE,
  MAKE_MODEL_FTS_COLUMNS,
  OWNER_FTS_COLUMNS,
  REGISTRATION_TABLE,
} from './schema.js';
import type {
  AircraftTypeSearchFilters,
  RegistrationSearchFilters,
  Row,
  SearchPage,
} from './types.js';

const REGISTRATION_FTS = `${REGISTRATION_TABLE}_fts`;

// Explicit classification wins. The only legacy permission is type certification.
const MANUFACTURER_PUBLIC =
  "(ref.manufacturer_redacted = 0 OR (ref.manufacturer_redacted IS NULL AND ref.builder_cert_code = '0'))";

/** Project a manufacturer through the same gate used for matching and ordering. */
export function visibleManufacturer(column: 'r.make' | 'ref.mfr', redact: boolean): string {
  return redact ? `CASE WHEN ${MANUFACTURER_PUBLIC} THEN ${column} END` : column;
}

/** Reference match for a registration whose searchable make/model is prejoined. */
export const REGISTRATION_REFERENCE_JOIN = `LEFT JOIN ${AIRCRAFT_REF_TABLE} AS ref ON ref.code = r.mfr_mdl_code`;

function readPage(
  handle: SqliteHandle,
  {
    select,
    rowSource,
    countSource = rowSource,
    orderBy,
  }: {
    select: string;
    rowSource: string;
    countSource?: string;
    orderBy: string;
  },
  conditions: string[],
  params: string[],
  { limit, offset }: { limit: number; offset: number },
): SearchPage<Row> {
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = handle
    .prepare<{ n: number }>(`SELECT count(*) AS n FROM ${countSource} ${where}`)
    .get(...params);
  if (!count) throw new Error('Registry count query returned no result.');
  const totalCount = count.n;
  const items =
    offset >= totalCount
      ? []
      : handle
          .prepare<Row>(
            `SELECT ${select} FROM ${rowSource} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
          )
          .all(...params, limit, offset);
  return { items, cap: limit, totalCount, truncated: offset + items.length < totalCount };
}

function addMatch(
  conditions: string[],
  params: string[],
  kind: 'registrations' | 'types',
  match: string,
  redact: boolean,
): void {
  const matches =
    kind === 'registrations'
      ? `r.rowid IN (SELECT rowid FROM ${REGISTRATION_FTS} WHERE ${REGISTRATION_FTS} MATCH ?)`
      : `ref.code IN (SELECT code FROM ${AIRCRAFT_REF_FTS} WHERE ${AIRCRAFT_REF_FTS} MATCH ?)`;
  conditions.push(matches);
  params.push(match);
  if (redact) {
    // First restrict the candidates with the indexed make/model query. A
    // hidden manufacturer can only qualify when every term matches the model.
    conditions.push(`CASE WHEN ${MANUFACTURER_PUBLIC} THEN 1 ELSE ${matches} END`);
    params.push(`model : (${match})`);
  }
}

/** Read a registration page and its exact total from the current snapshot. */
export function readRegistrations(
  handle: SqliteHandle,
  filters: RegistrationSearchFilters,
  redact: boolean,
  manufacturerModelCode: string | undefined,
): SearchPage<Row> {
  const conditions: string[] = [];
  const params: string[] = [];
  const state = normalizeExactFilter(filters.state, 'state');
  const aircraftType = normalizeExactFilter(filters.aircraftType, 'aircraftType');
  const modeSCode = normalizeExactFilter(filters.modeSCode, 'modeSCode');
  const exact: [string, string | undefined][] = [
    ['r.state = ?', state],
    ['r.mfr_mdl_code = ?', manufacturerModelCode],
    ['r.aircraft_type_code = ?', aircraftType],
    ['r.mode_s_code_hex = ?', modeSCode],
    ['r.serial_number = ? COLLATE NOCASE', cleanField(filters.serialNumber)],
  ];
  for (const [condition, value] of exact) {
    if (value) {
      conditions.push(condition);
      params.push(value);
    }
  }
  const ownerName = redact ? undefined : filters.ownerName;
  const makeModelMatch = filters.makeModel
    ? toFtsMatch(filters.makeModel, MAKE_MODEL_FTS_COLUMNS, true)
    : undefined;
  const ownerMatch = ownerName ? toFtsMatch(ownerName, OWNER_FTS_COLUMNS) : undefined;
  if ((filters.makeModel && !makeModelMatch) || (ownerName && !ownerMatch)) {
    conditions.push('0');
  } else {
    const match = [makeModelMatch, ownerMatch].filter(Boolean).join(' AND ');
    if (match) addMatch(conditions, params, 'registrations', match, redact);
  }

  const base = `${REGISTRATION_TABLE} AS r`;
  const source = redact ? `${base} ${REGISTRATION_REFERENCE_JOIN}` : base;
  return readPage(
    handle,
    {
      select: `r.*, ${visibleManufacturer('r.make', redact)} AS visible_make`,
      rowSource: source,
      countSource: makeModelMatch ? source : base,
      orderBy: 'r.rowid',
    },
    conditions,
    params,
    filters,
  );
}

/** Read a type page ordered by public manufacturer, model and code. */
export function readAircraftTypes(
  handle: SqliteHandle,
  filters: AircraftTypeSearchFilters,
  redact: boolean,
): SearchPage<Row> {
  const conditions: string[] = [];
  const params: string[] = [];
  const aircraftType = normalizeExactFilter(filters.aircraftType, 'aircraftType');
  const category = normalizeExactFilter(filters.category, 'category');
  if (aircraftType) {
    conditions.push('ref.aircraft_type_code = ?');
    params.push(aircraftType);
  }
  if (category) {
    conditions.push('ref.category_code = ?');
    params.push(category);
  }
  if (filters.query) {
    const match = toFtsMatch(filters.query, AIRCRAFT_REF_FTS_COLUMNS, true);
    if (match) addMatch(conditions, params, 'types', match, redact);
    else conditions.push('0');
  }

  return readPage(
    handle,
    {
      select: `ref.*, ${visibleManufacturer('ref.mfr', redact)} AS visible_make`,
      rowSource: `${AIRCRAFT_REF_TABLE} AS ref`,
      orderBy: 'visible_make, ref.model, ref.code',
    },
    conditions,
    params,
    filters,
  );
}
