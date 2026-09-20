/**
 * @fileoverview Mirror store schema for the FAA registry index. The `registration`
 * table is the MirrorService primary table (with its own FTS5 index, managed by
 * the framework). The reference and status tables (`aircraft_ref`, `engine_ref`,
 * `dereg`, `reserved`) plus a second FTS index over `aircraft_ref` are auxiliary
 * tables created via a migration and maintained by the ingester through the raw
 * handle. All columns are `TEXT`/`INTEGER` — booleans are stored as `'Y'`/null,
 * arrays as JSON strings (SqlValue is string | number | null).
 * @module services/registry/schema
 */

import type { Migration, SqliteHandle, SqliteMirrorStoreSpec } from '@cyanheads/mcp-ts-core/mirror';
import { DEFAULT_FTS_TOKENIZER } from '@cyanheads/mcp-ts-core/mirror';

/** Primary table name (the MirrorService-owned table). */
export const REGISTRATION_TABLE = 'registration';
/** Auxiliary reference/status table names. */
export const AIRCRAFT_REF_TABLE = 'aircraft_ref';
export const ENGINE_REF_TABLE = 'engine_ref';
export const DEREG_TABLE = 'dereg';
export const RESERVED_TABLE = 'reserved';
/** Auxiliary FTS index over aircraft_ref (its own fts5 table, populated by the ingester). */
export const AIRCRAFT_REF_FTS = 'aircraft_ref_fts';

/**
 * Column scopes for user-supplied search terms. Every free-text filter is
 * confined to the subset that matches its documented meaning — a make/model
 * query must never reach `owner_name`, `other_names`, or `city`, which would
 * both return false positives and let search probe the fields the owner-PII
 * redaction gate withholds. Keep these in sync with the `fts:` list in
 * {@link registrationStoreSpec} and the `aircraft_ref_fts` DDL in
 * {@link ensureAuxiliaryTables}; the `fts:` order itself is schema-significant
 * and must not be reordered to match these.
 */
export const MAKE_MODEL_FTS_COLUMNS = ['make', 'model'] as const;
/** Owner-name scope — includes co-owner names, which are owner-name data. */
export const OWNER_FTS_COLUMNS = ['owner_name', 'other_names'] as const;
/** The searchable columns of `aircraft_ref_fts` (`code` is UNINDEXED). */
export const AIRCRAFT_REF_FTS_COLUMNS = ['mfr', 'model'] as const;

/**
 * The MirrorService primary-table spec. `registration` carries the pre-joined
 * MASTER row with decoded ACFTREF/ENGINE labels and an FTS5 index over the
 * searchable text columns. The auxiliary tables ride along via `migrations`.
 */
export function registrationStoreSpec(path: string): SqliteMirrorStoreSpec {
  return {
    path,
    table: REGISTRATION_TABLE,
    primaryKey: 'n_number',
    version: 1,
    columns: {
      n_number: 'TEXT',
      serial_number: 'TEXT',
      mfr_mdl_code: 'TEXT',
      eng_mfr_mdl_code: 'TEXT',
      make: 'TEXT',
      model: 'TEXT',
      aircraft_type_code: 'TEXT',
      engine_type_code: 'TEXT',
      engine_make: 'TEXT',
      engine_model: 'TEXT',
      year_mfr: 'INTEGER',
      type_registrant_code: 'TEXT',
      owner_name: 'TEXT',
      street: 'TEXT',
      street2: 'TEXT',
      city: 'TEXT',
      state: 'TEXT',
      zip: 'TEXT',
      region_code: 'TEXT',
      county: 'TEXT',
      country: 'TEXT',
      last_action_date: 'TEXT',
      cert_issue_date: 'TEXT',
      airworthiness_class_code: 'TEXT',
      approved_operations_raw: 'TEXT',
      status_code: 'TEXT',
      mode_s_code_octal: 'TEXT',
      mode_s_code_hex: 'TEXT',
      fractional_owner: 'TEXT',
      airworthiness_date: 'TEXT',
      other_names: 'TEXT',
      expiration_date: 'TEXT',
      unique_id: 'TEXT',
      kit_mfr: 'TEXT',
      kit_model: 'TEXT',
    },
    fts: ['owner_name', 'make', 'model', 'other_names', 'city'],
    indexes: [
      { columns: ['mode_s_code_hex'] },
      { columns: ['mfr_mdl_code'] },
      { columns: ['state'] },
      { columns: ['aircraft_type_code'] },
    ],
    migrations: [auxiliaryTablesMigration()],
  };
}

/**
 * Idempotent DDL for the auxiliary reference/status tables and the aircraft_ref
 * FTS index (`CREATE … IF NOT EXISTS` throughout) — safe to run on every open.
 *
 * These tables are NOT part of the MirrorService primary-table DDL. Two paths
 * create them, and both must stay idempotent: {@link auxiliaryTablesMigration},
 * which the framework runner applies on a freshly created database as well as
 * on upgrade, and the ingester, which runs this DDL unconditionally at the start
 * of every sync before it touches the tables. The second is what guarantees the
 * tables on a mirror whose schema version was already stamped, and it matches
 * how the framework builds the primary table (idempotent, on every open).
 */
export function ensureAuxiliaryTables(handle: SqliteHandle): void {
  handle.exec(`
        CREATE TABLE IF NOT EXISTS ${AIRCRAFT_REF_TABLE} (
          code TEXT PRIMARY KEY NOT NULL,
          mfr TEXT,
          model TEXT,
          aircraft_type_code TEXT,
          engine_type_code TEXT,
          category_code TEXT,
          builder_cert_code TEXT,
          num_engines INTEGER,
          num_seats INTEGER,
          weight_class TEXT,
          cruise_speed INTEGER,
          tc_data_sheet TEXT,
          tc_data_holder TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_aircraft_ref_type ON ${AIRCRAFT_REF_TABLE} (aircraft_type_code);
        CREATE INDEX IF NOT EXISTS idx_aircraft_ref_category ON ${AIRCRAFT_REF_TABLE} (category_code);

        CREATE VIRTUAL TABLE IF NOT EXISTS ${AIRCRAFT_REF_FTS} USING fts5 (
          code UNINDEXED,
          mfr,
          model,
          tokenize = '${DEFAULT_FTS_TOKENIZER}'
        );

        CREATE TABLE IF NOT EXISTS ${ENGINE_REF_TABLE} (
          code TEXT PRIMARY KEY NOT NULL,
          mfr TEXT,
          model TEXT,
          engine_type_code TEXT,
          horsepower INTEGER,
          thrust INTEGER
        );

        CREATE TABLE IF NOT EXISTS ${DEREG_TABLE} (
          n_number TEXT NOT NULL,
          serial_number TEXT,
          mfr_mdl_code TEXT,
          status_code TEXT,
          cancel_date TEXT,
          mode_s_code_hex TEXT,
          owner_name TEXT,
          street TEXT,
          street2 TEXT,
          city TEXT,
          state TEXT,
          zip TEXT,
          physical_address TEXT,
          physical_address2 TEXT,
          physical_city TEXT,
          physical_state TEXT,
          physical_zip TEXT,
          physical_county TEXT,
          physical_country TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dereg_n_number ON ${DEREG_TABLE} (n_number);

        CREATE TABLE IF NOT EXISTS ${RESERVED_TABLE} (
          n_number TEXT NOT NULL,
          registrant TEXT,
          street TEXT,
          street2 TEXT,
          city TEXT,
          state TEXT,
          zip TEXT,
          type_reservation_code TEXT,
          reserve_date TEXT,
          expiration_notice_date TEXT,
          purge_date TEXT,
          n_number_for_change TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reserved_n_number ON ${RESERVED_TABLE} (n_number);
      `);
}

/**
 * Migration wrapper around {@link ensureAuxiliaryTables} for the MirrorService
 * `migrations` spec. The runner applies `up()` on a freshly created database as
 * well as on upgrade, so this is what stands the auxiliary tables up at first
 * open, and it keeps their schema versioned alongside the primary table. `up()`
 * must therefore tolerate the current declarative layout — pure
 * `CREATE … IF NOT EXISTS`, never a bare `ALTER` assuming an older shape.
 */
function auxiliaryTablesMigration(): Migration {
  return {
    version: 1,
    up: ensureAuxiliaryTables,
  };
}
