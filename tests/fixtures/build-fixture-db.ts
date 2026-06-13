/**
 * @fileoverview Build a small synthetic FAA registry SQLite fixture for tests —
 * a handful of registration rows plus reference (ACFTREF/ENGINE) and status
 * (DEREG/RESERVED) rows, exercising the query/join/decode/redaction path without
 * the multi-hundred-MB real corpus. Writes the same schema the production mirror
 * uses (framework `buildSchemaSql` + the server's auxiliary-table migration) and
 * marks the sync state complete so `mirror.ready()` returns true.
 * @module tests/fixtures/build-fixture-db
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchemaSql, openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { registrationStoreSpec } from '@/services/registry/schema.js';

/** Create a temp DB path under the OS temp dir (unique per call). */
export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'faa-fixture-'));
  return join(dir, 'faa-registry.db');
}

/**
 * Build the fixture database at `path`. Seeds:
 * - N12345 (12345): active Cessna 172S, Lycoming IO-360, individual owner.
 * - N5RP (5RP): active record with a co-owner and LLC registrant.
 * - N99SP (99SP): active but deliberately sparse (no year, no cruise speed, no owner name).
 * - N404ER (404ER): deregistered only.
 * - N777RZ (777RZ): reserved only.
 * Plus ACFTREF 2072714 (Cessna 172S) and 1234567 (sparse), ENGINE 41514 (Lycoming).
 */
export async function buildFixtureDb(path: string): Promise<void> {
  const spec = registrationStoreSpec(path);
  const handle = await openSqliteHandle(path, { busyTimeoutMs: 5000 });

  // Primary table + FTS + sync_state, exactly as the production mirror builds it.
  handle.exec(buildSchemaSql(spec));
  // Auxiliary reference/status tables (the server's migration content).
  for (const migration of spec.migrations ?? []) migration.up(handle);

  handle.transaction(() => {
    const reg = handle.prepare(
      `INSERT INTO registration (
        n_number, serial_number, mfr_mdl_code, eng_mfr_mdl_code, make, model,
        aircraft_type_code, engine_type_code, engine_make, engine_model, year_mfr,
        type_registrant_code, owner_name, street, street2, city, state, zip,
        region_code, county, country, last_action_date, cert_issue_date,
        airworthiness_class_code, approved_operations_raw, status_code,
        mode_s_code_octal, mode_s_code_hex, fractional_owner, airworthiness_date,
        other_names, expiration_date, unique_id, kit_mfr, kit_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // N12345 — full active record. Dates ISO-formatted, as the ingester writes them.
    reg.run(
      '12345',
      '172S0001',
      '2072714',
      '41514',
      'CESSNA',
      '172S',
      '4',
      '1',
      'LYCOMING',
      'IO-360-L2A',
      2008,
      '1',
      'JOHN Q PUBLIC',
      '123 RUNWAY RD',
      null,
      'SEATTLE',
      'WA',
      '98101',
      'S',
      'KING',
      'US',
      '2023-01-15',
      '2008-06-01',
      '1',
      'NAGT',
      'V',
      '50314521',
      'A4E2D9',
      null,
      '2008-06-01',
      null,
      '2026-01-31',
      '1001',
      null,
      null,
    );

    // N5RP — active with co-owners + LLC registrant.
    reg.run(
      '5RP',
      'SN-5RP',
      '2072714',
      '41514',
      'CESSNA',
      '172S',
      '4',
      '1',
      'LYCOMING',
      'IO-360-L2A',
      2015,
      '7',
      'SKYHIGH AVIATION LLC',
      '1 HANGAR WAY',
      'SUITE 2',
      'BELLEVUE',
      'WA',
      '98004',
      'S',
      'KING',
      'US',
      '2022-01-01',
      '2015-03-01',
      '1',
      'N',
      'V',
      '00000123',
      'C0FFEE',
      'Y',
      '2015-03-01',
      JSON.stringify(['JANE ROE', 'RICHARD POE']),
      '2027-12-31',
      '1002',
      null,
      null,
    );

    // N99SP — sparse active record: no year, no owner name, no cruise data.
    reg.run(
      '99SP',
      null,
      '1234567',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'V',
      null,
      '99FACE',
      null,
      null,
      null,
      null,
      '1003',
      null,
      null,
    );

    handle
      .prepare(
        `INSERT INTO aircraft_ref (
          code, mfr, model, aircraft_type_code, engine_type_code, category_code,
          builder_cert_code, num_engines, num_seats, weight_class, cruise_speed,
          tc_data_sheet, tc_data_holder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '2072714',
        'CESSNA',
        '172S',
        '4',
        '1',
        '1',
        '0',
        1,
        4,
        'CLASS 1',
        124,
        '3A12',
        'CESSNA AIRCRAFT CO',
      );
    handle
      .prepare(
        `INSERT INTO aircraft_ref (
          code, mfr, model, aircraft_type_code, engine_type_code, category_code,
          builder_cert_code, num_engines, num_seats, weight_class, cruise_speed,
          tc_data_sheet, tc_data_holder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '1234567',
        'SPARSE AERO',
        'MODEL X',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );

    handle
      .prepare(`INSERT INTO aircraft_ref_fts (code, mfr, model) VALUES (?, ?, ?)`)
      .run('2072714', 'CESSNA', '172S');
    handle
      .prepare(`INSERT INTO aircraft_ref_fts (code, mfr, model) VALUES (?, ?, ?)`)
      .run('1234567', 'SPARSE AERO', 'MODEL X');

    handle
      .prepare(
        `INSERT INTO engine_ref (code, mfr, model, engine_type_code, horsepower, thrust) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('41514', 'LYCOMING', 'IO-360-L2A', '1', 180, null);

    // N404ER — deregistered (with both address blocks populated for redaction tests).
    handle
      .prepare(
        `INSERT INTO dereg (
          n_number, serial_number, mfr_mdl_code, status_code, cancel_date, mode_s_code_hex,
          owner_name, street, street2, city, state, zip,
          physical_address, physical_address2, physical_city, physical_state,
          physical_zip, physical_county, physical_country
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        // Dates stored ISO-formatted, exactly as the ingester writes them (parseFaaDate at ingest).
        '404ER',
        'DEREG-SN',
        '2072714',
        '22',
        '2020-06-15',
        'DEADBE',
        'FORMER OWNER INC',
        '500 OLD RAMP',
        null,
        'RENTON',
        'WA',
        '98057',
        '500 PHYSICAL RAMP',
        'BLDG 9',
        'RENTON',
        'WA',
        '98057',
        'KING',
        'US',
      );

    // N777RZ — reserved.
    handle
      .prepare(
        `INSERT INTO reserved (
          n_number, registrant, street, street2, city, state, zip,
          type_reservation_code, reserve_date, expiration_notice_date, purge_date, n_number_for_change
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '777RZ',
        'RESERVER LLC',
        '9 FUTURE LN',
        null,
        'TACOMA',
        'WA',
        '98402',
        'FP',
        '2026-01-01',
        null,
        '2026-07-01',
        null,
      );

    // Mark the mirror complete so ready() is true.
    handle
      .prepare(
        `INSERT INTO mirror_sync_state (id, status, completed_at, total, started_at)
         VALUES (1, 'complete', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status='complete', completed_at=excluded.completed_at, total=excluded.total`,
      )
      .run(new Date().toISOString(), 3, new Date().toISOString());
  });

  handle.close();
}
