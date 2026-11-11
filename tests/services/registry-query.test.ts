/** @fileoverview Query behavior over a synthetic registry mirror. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistryService } from '@/services/registry/registry-service.js';
import { REGISTRY_GENERATION_TABLE } from '@/services/registry/schema.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';

const ctx = createMockContext();
const page = { limit: 25, offset: 0 };

describe('registry queries', () => {
  let path: string;
  let service: RegistryService;

  beforeEach(async () => {
    path = tempDbPath();
    await buildFixtureDb(path);
    service = new RegistryService({
      mirrorPath: path,
      databaseUrl: 'https://example.invalid/unused.zip',
      redactOwnerPii: true,
    });
  });

  afterEach(async () => {
    await service.mirrorInstance.close();
  });

  it('keeps insertion-order registration paging and active precedence', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      INSERT INTO dereg (n_number, serial_number, cancel_date) VALUES ('12345', 'OLD', '2026-01-01');
      INSERT INTO reserved (n_number, type_reservation_code) VALUES ('12345', 'HD');
    `);
    const first = await service.searchRegistrations({ state: 'WA', limit: 1, offset: 0 }, ctx);
    const second = await service.searchRegistrations({ state: 'WA', limit: 1, offset: 1 }, ctx);
    expect(first.items.map((item) => item.nNumber)).toEqual(['12345']);
    expect(second.items.map((item) => item.nNumber)).toEqual(['5RP']);
    expect(await service.getRegistrationStatus('N12345', ctx)).toMatchObject({
      recordType: 'active',
    });
  });

  it('checks RESERVED before same-date cancellations', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      INSERT INTO dereg (n_number, cancel_date) VALUES ('777RZ', '2026-01-01');
      UPDATE reserved SET type_reservation_code = 'HD' WHERE n_number = '777RZ';
    `);
    expect(await service.getRegistrationStatus('N777RZ', ctx)).toMatchObject({
      recordType: 'reserved',
      typeReservation: { code: 'HD' },
      cancellations: [{ cancelDate: '2026-01-01' }],
    });
  });

  it('keeps latest deregistered fields and excludes registrant PII in both modes', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE aircraft_ref SET manufacturer_redacted = 1 WHERE code = '1234567';
      INSERT INTO dereg
        (n_number, serial_number, mfr_mdl_code, cancel_date, export_country, year_mfr, status_code, owner_name, street)
      VALUES ('404ER', 'LATEST', '1234567', '2026-02-03', 'CANADA', 2020, '99', 'PRIVATE BUILDER', '1 PRIVATE WAY');
    `);
    const hidden = await service.getRegistrationStatus('N404ER', ctx);
    expect(hidden).toMatchObject({
      recordType: 'deregistered',
      serialNumber: 'LATEST',
      manufacturerModelCode: '1234567',
      cancelDate: '2026-02-03',
      exportCountry: 'CANADA',
      yearManufactured: 2020,
      status: { code: '99' },
      model: 'MODEL X',
    });
    expect(hidden).not.toHaveProperty('make');
    expect(hidden.cancellations?.[0]).toEqual({
      serialNumber: 'LATEST',
      manufacturerModelCode: '1234567',
      cancelDate: '2026-02-03',
      exportCountry: 'CANADA',
      status: { code: '99' },
      model: 'MODEL X',
    });
    const open = new RegistryService({
      mirrorPath: path,
      databaseUrl: 'https://example.invalid/unused.zip',
      redactOwnerPii: false,
    });
    try {
      const status = await open.getRegistrationStatus('N404ER', ctx);
      expect(status).toMatchObject({
        make: 'SPARSE AERO',
        cancellations: [{ make: 'SPARSE AERO' }, {}],
      });
      expect(JSON.stringify(status)).not.toMatch(/PRIVATE BUILDER|PRIVATE WAY/);
    } finally {
      await open.mirrorInstance.close();
    }
  });

  it('returns complete ordered history even after a number is reassigned', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE aircraft_ref SET manufacturer_redacted = NULL WHERE code = '1234567';
      INSERT INTO dereg (n_number, serial_number, mfr_mdl_code, cancel_date, owner_name, street)
      VALUES ('12345', 'UNDATED', '7654321', NULL, 'PRIVATE BUILDER', '1 PRIVATE WAY'),
             ('12345', 'FIRST', '2072714', '2020-05-05', 'PRIVATE BUILDER', '1 PRIVATE WAY'),
             ('12345', 'SECOND', '1234567', '2020-05-05', 'PRIVATE BUILDER', '1 PRIVATE WAY'),
             ('12345', 'LATEST', '2072714', '2021-06-06', 'PRIVATE BUILDER', '1 PRIVATE WAY');
    `);
    const status = await service.getRegistrationStatus('N12345', ctx);
    expect(status).toMatchObject({ recordType: 'active' });
    expect(status.cancellations).toEqual([
      {
        serialNumber: 'LATEST',
        manufacturerModelCode: '2072714',
        cancelDate: '2021-06-06',
        make: 'CESSNA',
        model: '172S',
      },
      {
        serialNumber: 'FIRST',
        manufacturerModelCode: '2072714',
        cancelDate: '2020-05-05',
        make: 'CESSNA',
        model: '172S',
      },
      {
        serialNumber: 'SECOND',
        manufacturerModelCode: '1234567',
        cancelDate: '2020-05-05',
        model: 'MODEL X',
      },
      { serialNumber: 'UNDATED', manufacturerModelCode: '7654321' },
    ]);
  });

  it('filters flagged make tokens before counting and ignores hidden names when sorting', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE aircraft_ref SET manufacturer_redacted = 1, mfr = 'ZED PRIVATE' WHERE code = '1234567';
      UPDATE aircraft_ref_fts SET mfr = 'ZED PRIVATE' WHERE code = '1234567';
      INSERT INTO aircraft_ref (code, mfr, model, manufacturer_redacted) VALUES
        ('7654321', 'ALPHA PRIVATE', 'MODEL Z', 1),
        ('4567890', 'PUBLIC COMPANY', 'MODEL A', 0);
      INSERT INTO aircraft_ref_fts (code, mfr, model) VALUES
        ('7654321', 'ALPHA PRIVATE', 'MODEL Z'),
        ('4567890', 'PUBLIC COMPANY', 'MODEL A');
      UPDATE registration SET make = 'ZED PRIVATE', model = 'MODEL X', kit_mfr = 'PUBLIC KIT CO'
        WHERE n_number = '99SP';
    `);
    expect(await service.lookupRegistration('N99SP', ctx)).toMatchObject({
      kitManufacturer: 'PUBLIC KIT CO',
    });
    for (const text of ['zed', 'private model']) {
      expect((await service.searchAircraftTypes({ ...page, query: text }, ctx)).totalCount).toBe(0);
      expect(
        (await service.searchRegistrations({ ...page, makeModel: text }, ctx)).totalCount,
      ).toBe(0);
    }
    const summary = await service.searchRegistrations({ ...page, makeModel: 'mode' }, ctx);
    expect(summary.items.map(({ nNumber, make }) => [nNumber, make])).toEqual([
      ['99SP', undefined],
    ]);
    const filters = { query: 'mode', limit: 1 };
    const first = await service.searchAircraftTypes({ ...filters, offset: 0 }, ctx);
    const second = await service.searchAircraftTypes({ ...filters, offset: 1 }, ctx);
    const last = await service.searchAircraftTypes({ ...filters, offset: 2 }, ctx);
    const pastEnd = await service.searchAircraftTypes({ ...filters, offset: 3 }, ctx);
    expect([first, second, last, pastEnd].map(({ totalCount }) => totalCount)).toEqual([
      3, 3, 3, 3,
    ]);
    expect(
      [first, second, last].flatMap(({ items }) =>
        items.map(({ code, manufacturer }) => [code, manufacturer]),
      ),
    ).toEqual([
      ['1234567', undefined],
      ['7654321', undefined],
      ['4567890', 'PUBLIC COMPANY'],
    ]);
    expect(pastEnd).toMatchObject({ items: [], truncated: false });
  });

  it('hides unresolved legacy builder names and matching kit aliases', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE aircraft_ref SET manufacturer_redacted = NULL WHERE code = '1234567';
      UPDATE registration SET make = 'SPARSE AERO', model = 'MODEL X', kit_mfr = 'sparse aero'
      WHERE n_number = '99SP';
    `);
    const record = await service.lookupRegistration('N99SP', ctx);
    expect(record?.make).toBeUndefined();
    expect(record?.kitManufacturer).toBeUndefined();
    expect((await service.getAircraftType('1234567', ctx))?.manufacturer).toBeUndefined();
    expect(
      (await service.searchRegistrations({ ...page, makeModel: 'SPARSE' }, ctx)).totalCount,
    ).toBe(0);
    expect((await service.searchAircraftTypes({ ...page, query: 'SPARSE' }, ctx)).totalCount).toBe(
      0,
    );
    expect(
      (await service.searchRegistrations({ ...page, makeModel: 'MODEL' }, ctx)).items,
    ).toMatchObject([{ nNumber: '99SP', model: 'MODEL X' }]);
    expect(
      (await service.searchRegistrations({ ...page, manufacturerModelCode: '1234567' }, ctx)).items,
    ).toMatchObject([{ nNumber: '99SP', model: 'MODEL X' }]);
  });

  it('keeps owner terms whole-token when combining owner and make filters', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE registration SET owner_name = 'SMITHSON' WHERE n_number = '12345';
      UPDATE registration SET owner_name = 'SMITH' WHERE n_number = '5RP';
    `);
    const open = new RegistryService({
      mirrorPath: path,
      databaseUrl: 'https://example.invalid/unused.zip',
      redactOwnerPii: false,
    });
    try {
      const result = await open.searchRegistrations(
        { ...page, ownerName: 'SMITH', makeModel: 'cess 172' },
        ctx,
      );
      expect(result.items.map(({ nNumber }) => nNumber)).toEqual(['5RP']);
    } finally {
      await open.mirrorInstance.close();
    }
  });

  it('matches make and model prefixes together in both searches', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      INSERT INTO aircraft_ref (code, mfr, model, builder_cert_code) VALUES
        ('2072717', 'CESSNA', '172', '0'),
        ('2072718', 'CESSNA', '172RG', '0');
      INSERT INTO aircraft_ref_fts (code, mfr, model) VALUES
        ('2072717', 'CESSNA', '172'),
        ('2072718', 'CESSNA', '172RG');
      INSERT INTO registration (n_number, mfr_mdl_code, make, model, state) VALUES
        ('1A', '2072717', 'CESSNA', '172', 'WA'),
        ('2A', '2072718', 'CESSNA', '172RG', 'WA'),
        ('3A', '2072718', 'CESSNA', '172RG', 'OR');
    `);
    expect(
      (
        await service.searchRegistrations({ ...page, makeModel: 'cess 172', state: 'WA' }, ctx)
      ).items.map(({ nNumber }) => nNumber),
    ).toEqual(['12345', '5RP', '1A', '2A']);
    expect(
      (await service.searchAircraftTypes({ ...page, query: 'cess 172' }, ctx)).items.map(
        (item) => item.code,
      ),
    ).toEqual(['2072717', '2072718', '2072714', '2072715']);
  });

  it('keeps an invalid FTS string a validation error after moving to raw SQL', async () => {
    const error = { code: JsonRpcErrorCode.ValidationError, data: { field: 'match' } };
    await expect(
      service.searchRegistrations({ ...page, makeModel: 'ce\0ss' }, ctx),
    ).rejects.toMatchObject(error);
    await expect(
      service.searchAircraftTypes({ ...page, query: 'ce\0ss' }, ctx),
    ).rejects.toMatchObject(error);
  });

  it('matches exact serials without dropping zeros, punctuation or spaces', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE registration SET serial_number = '001-a B' WHERE n_number IN ('12345', '105HH');
      UPDATE registration SET serial_number = '001-aB' WHERE n_number = '5RP';
    `);
    const filter = { limit: 1, offset: 0, serialNumber: ' 001-A b ' };
    expect(await service.searchRegistrations(filter, ctx)).toMatchObject({
      cap: 1,
      totalCount: 2,
      truncated: true,
      items: [{ nNumber: '12345', serialNumber: '001-a B' }],
    });
    expect(await service.searchRegistrations({ ...filter, offset: 1 }, ctx)).toMatchObject({
      cap: 1,
      totalCount: 2,
      truncated: false,
      items: [{ nNumber: '105HH', serialNumber: '001-a B' }],
    });
    expect(await service.searchRegistrations({ ...filter, offset: 2 }, ctx)).toMatchObject({
      cap: 1,
      totalCount: 2,
      truncated: false,
      items: [],
    });
    expect(
      (await service.searchRegistrations({ ...filter, manufacturerModelCode: '2072714' }, ctx))
        .totalCount,
    ).toBe(1);
    expect(
      (await service.searchRegistrations({ ...filter, serialNumber: '001-a' }, ctx)).totalCount,
    ).toBe(0);
    expect(
      (await service.searchRegistrations({ ...filter, serialNumber: '1-a B' }, ctx)).totalCount,
    ).toBe(0);
  });

  it('returns class-specific operations and per-engine ratings', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE registration SET airworthiness_class_code = '4', approved_operations_raw = '9A9C34'
      WHERE n_number = '12345';
      UPDATE registration SET airworthiness_class_code = '6', approved_operations_raw = '131',
        eng_mfr_mdl_code = '99999' WHERE n_number = '5RP';
      INSERT INTO engine_ref (code, horsepower, thrust) VALUES ('99999', 0, 1200);
    `);
    expect(await service.lookupRegistration('N12345', ctx)).toMatchObject({
      engineHorsepower: 180,
      approvedOperationsRaw: '9A9C34',
      approvedOperations: [
        { code: '9A', label: 'Unmanned Aircraft - Research and Development' },
        { code: '9C', label: 'Unmanned Aircraft - Crew Training' },
        { code: '3', label: 'Exhibition' },
        { code: '4', label: 'Racing' },
      ],
    });
    const thrust = await service.lookupRegistration('N5RP', ctx);
    expect(thrust).toMatchObject({
      engineThrustLbs: 1200,
      approvedOperations: [
        { code: '1', label: 'Standard' },
        { code: '3', label: 'Restricted' },
        { code: '1', label: 'Agriculture and Pest Control' },
      ],
    });
    expect(thrust?.engineHorsepower).toBeUndefined();
    const sparse = await service.lookupRegistration('N99SP', ctx);
    expect(sparse).not.toHaveProperty('engineHorsepower');
    expect(sparse).not.toHaveProperty('engineThrustLbs');
    expect(sparse).not.toHaveProperty('approvedOperations');
  });

  it('pins results and date while another connection publishes a new generation', async () => {
    const writer = await openSqliteHandle(path, { busyTimeoutMs: 5000 });
    try {
      writer.exec(`
        INSERT INTO ${REGISTRY_GENERATION_TABLE} (id, owner, generation, loading, data_as_of)
        VALUES (1, 'fixture', 1, 0, '2026-11-09');
      `);
      const replace = {
        ...ctx,
        log: {
          ...ctx.log,
          debug() {
            writer.transaction(() => {
              writer.exec(`
                UPDATE registration SET state = 'OR' WHERE n_number = '12345';
                UPDATE ${REGISTRY_GENERATION_TABLE} SET generation = 2, data_as_of = '2026-11-10';
              `);
            }, 'immediate');
          },
        },
      };
      const dates: (string | undefined)[] = [];
      const old = await service.searchRegistrations(
        { ...page, state: 'WA' },
        replace,
        (snapshot) => {
          dates.push(snapshot.dataAsOf);
        },
      );
      const updated = await service.searchRegistrations(
        { ...page, state: 'WA' },
        ctx,
        (snapshot) => {
          dates.push(snapshot.dataAsOf);
        },
      );
      expect(dates).toEqual(['2026-11-09', '2026-11-10']);
      expect(old.totalCount).toBe(2);
      expect(old.items.map(({ nNumber }) => nNumber)).toEqual(['12345', '5RP']);
      expect(updated.totalCount).toBe(1);
      expect(updated.items.map(({ nNumber }) => nNumber)).toEqual(['5RP']);
    } finally {
      writer.close();
    }
  });
});
