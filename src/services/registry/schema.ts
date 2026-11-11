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
/** The FAA generation marker, written with the wipe and published with terminal sync state. */
export const REGISTRY_GENERATION_TABLE = 'registry_generation';

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
    version: 2,
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
    migrations: [auxiliaryTablesMigration(), { version: 2, up: upgradeRegistryTables }],
  };
}

/**
 * Version 1 auxiliary reference/status tables and aircraft_ref FTS index.
 * The framework applies this before the version 2 upgrade on a fresh database.
 */
function ensureAuxiliaryTables(handle: SqliteHandle): void {
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

/** Add classification, history, serial indexing, and generation publication. */
function upgradeRegistryTables(handle: SqliteHandle): void {
  // Older core releases could stamp a fresh schema before running migrations.
  // A cold v1 index from those releases can be missing the auxiliary tables.
  ensureAuxiliaryTables(handle);
  handle.exec(`
    ALTER TABLE ${AIRCRAFT_REF_TABLE} ADD COLUMN manufacturer_redacted INTEGER;
    ALTER TABLE ${DEREG_TABLE} ADD COLUMN export_country TEXT;
    ALTER TABLE ${DEREG_TABLE} ADD COLUMN year_mfr INTEGER;
    CREATE INDEX idx_registration_serial_nocase
      ON ${REGISTRATION_TABLE} (serial_number COLLATE NOCASE);
    CREATE TABLE ${REGISTRY_GENERATION_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      generation INTEGER NOT NULL,
      loading INTEGER NOT NULL CHECK (loading IN (0, 1)),
      data_as_of TEXT
    );
  `);
  // Core's SQLite lease commit updates mirror_sync_state inside its fenced
  // transaction. Publish there so a process exit after commit cannot strand a
  // successful rebuild as loading, and a failed terminal commit cannot publish.
  handle.exec(`
    CREATE TRIGGER faa_publish_generation AFTER UPDATE OF status ON mirror_sync_state
    WHEN NEW.id = 1 AND NEW.status = 'complete' AND NEW.completed_at IS NOT NULL
    BEGIN
      UPDATE ${REGISTRY_GENERATION_TABLE} SET loading = 0
      WHERE id = 1 AND loading = 1 AND EXISTS (
        SELECT 1 FROM mirror_sync_lease AS lease
        WHERE lease.id = 1
          AND lease.owner = ${REGISTRY_GENERATION_TABLE}.owner
          AND lease.generation = ${REGISTRY_GENERATION_TABLE}.generation
      );
    END;
  `);
}
