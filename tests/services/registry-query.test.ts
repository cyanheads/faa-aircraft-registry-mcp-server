/** @fileoverview Query behavior over a synthetic registry mirror. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { openSqliteHandle, type SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESIGNATOR_SPELLING_BUDGET,
  type FtsTermMatch,
  toFtsMatch,
} from '@/services/registry/normalize.js';
import { RegistryService } from '@/services/registry/registry-service.js';
import { REGISTRY_GENERATION_TABLE } from '@/services/registry/schema.js';
import type { RegistrationSearchFilters } from '@/services/registry/types.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';

const ctx = createMockContext();
const page = { limit: 25, offset: 0 };
const openService = (mirrorPath: string, redactOwnerPii: boolean) =>
  new RegistryService({
    mirrorPath,
    databaseUrl: 'https://example.invalid/unused.zip',
    redactOwnerPii,
  });

describe('registry queries', () => {
  let path: string;
  let service: RegistryService;

  beforeEach(async () => {
    path = tempDbPath();
    await buildFixtureDb(path);
    service = openService(path, true);
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
    const open = openService(path, false);
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
      ['4567890', 'PUBLIC COMPANY'],
      ['1234567', undefined],
      ['7654321', undefined],
    ]);
    expect(pastEnd).toMatchObject({ items: [], truncated: false });
  });

  /**
   * A browse under redaction lists every named manufacturer before any withheld
   * one; within the withheld group only model and code order, so a hidden name
   * cannot move a row. The offset walk reproduces the single-call order.
   */
  it('lists named manufacturers before withheld ones across page boundaries', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      INSERT INTO aircraft_ref (code, mfr, model, aircraft_type_code, manufacturer_redacted) VALUES
        ('0590001', 'AARDVARK HOMEBUILDER', '#1 BUSH', '4', 1),
        ('0590002', 'ZULU HOMEBUILDER', '#1 BUSH', '4', 1),
        ('0590003', 'MIDDLE HOMEBUILDER', 'ZEPHYR', '4', 1),
        ('0590004', 'ZENITH PUBLIC', 'AAA', '4', 0);
    `);
    const filters = { aircraftType: '4', limit: 3 };
    const whole = await service.searchAircraftTypes({ ...filters, limit: 25, offset: 0 }, ctx);
    const order = whole.items.map(({ code, manufacturer }) => [code, manufacturer]);
    expect(order).toEqual([
      ['2072714', 'CESSNA'],
      ['2072715', 'CESSNA'],
      ['2072716', 'CESSNA'],
      ['0590004', 'ZENITH PUBLIC'],
      ['0590001', undefined],
      ['0590002', undefined],
      ['0590003', undefined],
    ]);
    const walked: string[] = [];
    for (let offset = 0; offset < whole.totalCount; offset += filters.limit) {
      const page = await service.searchAircraftTypes({ ...filters, offset }, ctx);
      expect(page.totalCount).toBe(7);
      expect(page.truncated).toBe(offset + filters.limit < 7);
      walked.push(...page.items.map(({ code }) => code));
    }
    expect(walked).toEqual(order.map(([code]) => code));

    const open = openService(path, false);
    try {
      const unredacted = await open.searchAircraftTypes({ ...filters, limit: 25, offset: 0 }, ctx);
      expect(unredacted.items.map(({ code }) => code)).toEqual([
        '0590001',
        '2072714',
        '2072715',
        '2072716',
        '0590003',
        '0590004',
        '0590002',
      ]);
    } finally {
      await open.mirrorInstance.close();
    }
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
    const open = openService(path, false);
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

/**
 * Engine code, airworthiness class and manufacture-year filters. Fixture rows:
 * N12345 (engine 41514, class 1, 2008, WA) and N5RP (41514, class 1, 2015, WA);
 * N99SP stores a NULL year and N105HH the FAA's blank 0. Each test gives those
 * two a leading-zero engine code and class 4.
 */
describe('registration engine, airworthiness and year filters', () => {
  let service: RegistryService;

  beforeEach(async () => {
    const path = tempDbPath();
    await buildFixtureDb(path);
    service = openService(path, true);
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE registration SET eng_mfr_mdl_code = '01234', airworthiness_class_code = '4'
      WHERE n_number IN ('99SP', '105HH');
    `);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.mirrorInstance.close();
  });

  type Filters = Omit<RegistrationSearchFilters, 'limit' | 'offset'>;
  const search = (filters: Filters, limit = 25, offset = 0) =>
    service.searchRegistrations({ ...filters, limit, offset }, ctx);
  const numbers = async (filters: Filters) =>
    (await search(filters)).items.map(({ nNumber }) => nNumber);
  const invalid = (reason: string) => ({
    code: JsonRpcErrorCode.ValidationError,
    data: { reason },
  });

  it('matches an exact engine code, keeping leading zeros and trimming padding', async () => {
    expect(await numbers({ engineManufacturerModelCode: ' 41514 ' })).toEqual(['12345', '5RP']);
    expect(await numbers({ engineManufacturerModelCode: '01234' })).toEqual(['99SP', '105HH']);
    expect(await numbers({ engineManufacturerModelCode: '17026' })).toEqual([]);
    expect(await numbers({ engineManufacturerModelCode: ' ', state: 'WA' })).toEqual([
      '12345',
      '5RP',
    ]);
  });

  it.each(['1702', 'O-320', 'IO520', '170260', '1702A'])(
    'rejects engine code %j alongside a valid filter',
    async (engineManufacturerModelCode) => {
      await expect(search({ engineManufacturerModelCode, state: 'WA' })).rejects.toMatchObject(
        invalid('invalid_engine_code'),
      );
    },
  );

  it('matches an exact airworthiness class alone and beside a state', async () => {
    expect(await numbers({ airworthinessClass: ' 4 ' })).toEqual(['99SP', '105HH']);
    expect(await numbers({ airworthinessClass: '1', state: ' wa ' })).toEqual(['12345', '5RP']);
    expect(await numbers({ airworthinessClass: '9' })).toEqual([]);
    expect(await numbers({ airworthinessClass: '', state: 'WA' })).toEqual(['12345', '5RP']);
  });

  it.each(['0', 'X', '10', '4E'])(
    'rejects airworthiness class %j alongside a valid filter',
    async (airworthinessClass) => {
      await expect(search({ airworthinessClass, state: 'WA' })).rejects.toMatchObject(
        invalid('invalid_airworthiness_class'),
      );
    },
  );

  it('bounds the manufacture year inclusively and never matches a blank year', async () => {
    expect(await numbers({ yearManufacturedMin: 2008, yearManufacturedMax: 2015 })).toEqual([
      '12345',
      '5RP',
    ]);
    expect(await numbers({ yearManufacturedMin: 2008, yearManufacturedMax: 2008 })).toEqual([
      '12345',
    ]);
    expect(await numbers({ yearManufacturedMin: 2015, yearManufacturedMax: 2015 })).toEqual([
      '5RP',
    ]);
    expect(await numbers({ yearManufacturedMin: 2009 })).toEqual(['5RP']);
    expect(await numbers({ yearManufacturedMin: 1000 })).toEqual(['12345', '5RP']);
    // Max-only: neither N105HH's stored 0 nor N99SP's NULL is a year.
    expect(await numbers({ yearManufacturedMax: 2010 })).toEqual(['12345']);
    expect(await numbers({ yearManufacturedMax: 9999 })).toEqual(['12345', '5RP']);
    expect(await numbers({ yearManufacturedMax: 2007 })).toEqual([]);
  });

  it('rejects a minimum year after the maximum', async () => {
    await expect(
      search({ yearManufacturedMin: 2015, yearManufacturedMax: 2008 }),
    ).rejects.toMatchObject(invalid('invalid_year_range'));
  });

  it('agrees on totals and page boundaries with the rows, alone and beside a make/model term', async () => {
    // A make/model term counts against the reference join; the others count the bare table.
    for (const filters of [
      { engineManufacturerModelCode: '41514' },
      { airworthinessClass: '4' },
      { yearManufacturedMin: 2000 },
      { yearManufacturedMax: 2020 },
      { engineManufacturerModelCode: '41514', makeModel: 'cessna' },
      { airworthinessClass: '4', makeModel: 'uh' },
      { yearManufacturedMax: 2010, makeModel: 'cessna' },
      { yearManufacturedMin: 2008, yearManufacturedMax: 2015, makeModel: '172' },
    ] satisfies Filters[]) {
      const whole = await search(filters);
      expect(whole.totalCount, JSON.stringify(filters)).toBeGreaterThan(0);
      expect(whole.totalCount, JSON.stringify(filters)).toBe(whole.items.length);
      const walked: string[] = [];
      for (let offset = 0; offset <= whole.totalCount; offset++) {
        const one = await search(filters, 1, offset);
        expect(one.totalCount).toBe(whole.totalCount);
        expect(one.truncated).toBe(offset + 1 < whole.totalCount);
        walked.push(...one.items.map(({ nNumber }) => nNumber));
      }
      expect(walked).toEqual(whole.items.map(({ nNumber }) => nNumber));
    }
    expect(
      await numbers({ yearManufacturedMax: 2010, makeModel: 'cessna' }),
      'combined filters narrow each other',
    ).toEqual(['12345']);
  });

  it('summarizes the engine code and airworthiness class only where the FAA stored them', async () => {
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      UPDATE registration SET airworthiness_class_code = '0' WHERE n_number = '105HH';
      UPDATE registration SET eng_mfr_mdl_code = NULL, airworthiness_class_code = NULL
      WHERE n_number = '99SP';
    `);
    const only = async (modeSCode: string) => (await search({ modeSCode })).items[0];
    expect(await only('A4E2D9')).toMatchObject({
      engineManufacturerModelCode: '41514',
      airworthinessClass: { code: '1', label: 'Standard' },
    });
    // The FAA's undocumented class 0 is reported as stored, with no invented label.
    const undocumented = await only('105ACE');
    expect(undocumented?.engineManufacturerModelCode).toBe('01234');
    expect(undocumented?.airworthinessClass).toEqual({ code: '0' });
    await expect(search({ airworthinessClass: '0' })).rejects.toMatchObject(
      invalid('invalid_airworthiness_class'),
    );
    const sparse = await only('99FACE');
    expect(sparse).not.toHaveProperty('engineManufacturerModelCode');
    expect(sparse).not.toHaveProperty('airworthinessClass');
  });

  it('serves each filter alone from its own index in the statements the search issues', async () => {
    const handle = await service.mirrorInstance.raw();
    const prepare = handle.prepare.bind(handle);
    const issued: { sql: string; params: SqlValue[] }[] = [];
    vi.spyOn(handle, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      const capture = (params: SqlValue[]) => {
        if (sql.includes('FROM registration AS r')) issued.push({ sql, params });
      };
      return {
        all: (...params: SqlValue[]) => {
          capture(params);
          return statement.all(...params);
        },
        get: (...params: SqlValue[]) => {
          capture(params);
          return statement.get(...params);
        },
        run: (...params: SqlValue[]) => statement.run(...params),
      };
    }) as typeof handle.prepare);
    for (const [filters, index] of [
      [{ engineManufacturerModelCode: '41514' }, 'registration_eng_mfr_mdl_code_idx'],
      [{ airworthinessClass: '4' }, 'registration_airworthiness_class_code_idx'],
      [{ yearManufacturedMin: 2000, yearManufacturedMax: 2020 }, 'registration_year_mfr_idx'],
      [{ yearManufacturedMax: 2020 }, 'registration_year_mfr_idx'],
    ] as const) {
      issued.length = 0;
      await search(filters);
      // One count and one page statement per call.
      expect(issued.map(({ sql }) => sql.startsWith('SELECT count(*)'))).toEqual([true, false]);
      for (const { sql, params } of issued) {
        const plan = prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map(({ detail }) => detail)
          .join('\n');
        expect(plan, sql).toContain(index);
      }
    }
  });
});

const MAKE_MODEL = ['make', 'model'] as const;
const OWNER = ['owner_name', 'other_names'] as const;
const designator = (input: string) => toFtsMatch(input, MAKE_MODEL, 'designator');
const whole = (input: string) => toFtsMatch(input, OWNER, 'whole');

describe('toFtsMatch terms', () => {
  it('keeps the expression for terms with no boundary or more than four, and for owner names', () => {
    expect(designator('cessna 172')).toBe('{make model} : ("cessna"* AND "172"*)');
    expect(designator(' "skyhawk" ')).toBe('{make model} : ("skyhawk"*)');
    expect(designator('A1B2C3')).toBe('{make model} : ("A1B2C3"*)');
    expect(designator('DC-3A-S1C3G')).toBe('{make model} : ("DC-3A-S1C3G"*)');
    expect(designator('"""')).toBeUndefined();
    expect(whole('JOHN Q PUBLIC')).toBe('{owner_name other_names} : ("JOHN" AND "Q" AND "PUBLIC")');
    expect(whole('SMITH-JONES PA28')).toBe('{owner_name other_names} : ("SMITH-JONES" AND "PA28")');
  });

  it('matches every join/split spelling of a designator, the term as typed first', () => {
    expect(designator('PA28')).toBe('{make model} : (("PA28"* OR "PA 28"*))');
    expect(designator('PA-32R')).toBe(
      '{make model} : (("PA-32R"* OR "PA32R"* OR "PA32 R"* OR "PA 32 R"*))',
    );
    expect(designator('-PA28-')).toBe('{make model} : (("-PA28-"* OR "PA 28"*))');
    expect(designator('piper PA-28-181')).toBe(
      '{make model} : ("piper"* AND ("PA-28-181"* OR "PA28181"* OR "PA28 181"* OR "PA 28181"*))',
    );
    const fourBoundaries = designator('PA-32R-301T')?.match(/"[^"]*"\*/g);
    expect(fourBoundaries).toHaveLength(16);
    expect(fourBoundaries?.[0]).toBe('"PA-32R-301T"*');
    expect(fourBoundaries).toEqual(
      expect.arrayContaining(['"PA32R301T"*', '"PA 32 R 301 T"*', '"PA32R 301T"*']),
    );
    // The spelling that splits where the typed term does is the typed term itself.
    expect(fourBoundaries).not.toContain('"PA 32R 301T"*');
  });

  it('drops terms with no letter or digit in both modes', () => {
    expect(designator('cessna - 172')).toBe('{make model} : ("cessna"* AND "172"*)');
    for (const input of ['-', '- – / ..', '" - "']) {
      expect(designator(input), input).toBeUndefined();
      expect(whole(input), input).toBeUndefined();
    }
    expect(whole('JOHNSON & JOHNSON')).toBe('{owner_name other_names} : ("JOHNSON")');
  });

  it('matches a repeated term once, a designator in any of its spellings', () => {
    expect(designator('cessna CESSNA Cessna')).toBe('{make model} : ("cessna"*)');
    expect(designator('UH-1H uh1h UH_1-H')).toBe(
      '{make model} : (("UH-1H"* OR "UH1H"* OR "UH1 H"* OR "UH 1 H"*))',
    );
    expect(whole('SMITH smith')).toBe('{owner_name other_names} : ("SMITH")');
  });

  /** The budget bounds how many spellings one search adds; a term past it builds today's phrase. */
  it('stops adding spellings at the budget, counted after repeats are dropped', () => {
    const terms = Array.from({ length: DESIGNATOR_SPELLING_BUDGET + 2 }, (_, i) => `x${i + 1}`);
    const groups = designator(terms.join(' '))?.slice('{make model} : ('.length, -1).split(' AND ');
    expect(groups).toHaveLength(terms.length);
    terms.forEach((term, i) => {
      expect(groups?.[i]).toBe(
        i < DESIGNATOR_SPELLING_BUDGET ? `("${term}"* OR "x ${i + 1}"*)` : `"${term}"*`,
      );
    });
    // A term whose spellings exceed what remains matches as typed; a later one that fits still expands.
    const filler = terms.slice(0, DESIGNATOR_SPELLING_BUDGET - 10);
    const tail = designator([...filler, 'PA-32R-301T', 'y1'].join(' '))?.split(' AND ');
    expect(tail?.at(-2)).toBe('"PA-32R-301T"*');
    expect(tail?.at(-1)).toBe('("y1"* OR "y 1"*))');
    const repeated = designator(`${'x1 '.repeat(50)}PA-32R-301T`);
    expect(repeated?.match(/"[^"]*"\*/g)).toHaveLength(2 + 16);
  });

  it('keeps rejecting a null character', () => {
    expect(() => designator('pa\u000028')).toThrow(/null character/);
    expect(() => whole('sm\u0000ith')).toThrow(/null character/);
  });

  /**
   * Random text from FTS5 syntax, separators, quotes, non-ASCII letters, combining
   * marks and code points the tokenizer and JS classify differently. Every output
   * must parse as a MATCH (alone and under the redaction rescope) and contain only
   * quoted alternatives, each term's typed form first.
   */
  it('builds only parseable, fully quoted expressions from arbitrary text', async () => {
    const handle = await openSqliteHandle(tempDbPath());
    try {
      handle.exec(`
        CREATE VIRTUAL TABLE fz USING fts5(owner_name, make, model, other_names, city,
          tokenize = 'unicode61 remove_diacritics 2');
        INSERT INTO fz VALUES ('JOHN Q PUBLIC', 'PIPER', 'PA-28-181', NULL, 'SEATTLE'),
          ('PA28 FLYERS LLC', 'CESSNA', '172S', 'JANE ROE', 'TACOMA');
      `);
      const count = handle.prepare<{ n: number }>('SELECT count(*) AS n FROM fz WHERE fz MATCH ?');
      // The last line: NBSP, é, a New Tai Lue vowel sign, an unassigned and a private-use point.
      const pieces = [
        ...'PA 28 R 1 a Z 0 172S - _ . / " "" * : ^ { } ( ) + , & NEAR AND OR NOT'.split(' '),
        ...[' ', '  ', '\t', '\n', "'", 'ß', 'Ω', '中', `e${String.fromCodePoint(0x301)}`],
        ...[0xa0, 0xe9, 0x19b0, 0x378, 0xe000].map((point) => String.fromCodePoint(point)),
      ];
      let seed = 0x35;
      const next = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const phrase = '"[^"]*[\\p{L}\\p{N}\\p{Co}][^"]*"';
      const shape = {
        designator: new RegExp(
          `^\\{make model\\} : \\((?:${phrase}\\*|\\(${phrase}\\*(?: OR ${phrase}\\*)+\\))(?: AND (?:${phrase}\\*|\\(${phrase}\\*(?: OR ${phrase}\\*)+\\)))*\\)$`,
          'u',
        ),
        whole: new RegExp(
          `^\\{owner_name other_names\\} : \\(${phrase}(?: AND ${phrase})*\\)$`,
          'u',
        ),
      };
      // A generated spelling can hold the word AND, so terms are found by their quoted phrases.
      const quotedTerms = /\("[^"]*"\*(?: OR "[^"]*"\*)+\)|"[^"]*"\*?/g;
      let built = 0;
      for (let i = 0; i < 600; i++) {
        const input = Array.from(
          { length: Math.floor(next() * 12) },
          () => pieces[Math.floor(next() * pieces.length)],
        ).join('');
        const typed = new Set(
          input
            .trim()
            .split(/\s+/)
            .map((term) => term.replace(/"/g, '')),
        );
        for (const mode of ['designator', 'whole'] as const satisfies FtsTermMatch[]) {
          const expression = toFtsMatch(input, mode === 'whole' ? OWNER : MAKE_MODEL, mode);
          if (!expression) continue;
          built++;
          expect(expression, JSON.stringify(input)).toMatch(shape[mode]);
          for (const term of expression.match(quotedTerms) ?? []) {
            const first = /"([^"]*)"/.exec(term)?.[1];
            expect(typed.has(first ?? ''), `${JSON.stringify(input)} → ${term}`).toBe(true);
          }
          expect(() => count.get(expression), JSON.stringify(input)).not.toThrow();
          expect(() => count.get(`model : (${expression})`), JSON.stringify(input)).not.toThrow();
        }
      }
      expect(built).toBeGreaterThan(600);
    } finally {
      handle.close();
    }
  });
});

/**
 * Linear-time scan of caller-sized text in both modes. CPU time of this thread,
 * least of several measurements, with the 5k baseline re-timed beside each larger
 * size; the input doubles and each size is checked before the next is built.
 */
describe('toFtsMatch scan cost', () => {
  const cpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  /** Least per-call CPU ms; a small input runs in a batch so its time is above the timer's resolution. */
  const leastPerCall = (run: () => void) => {
    let batch = 1;
    for (;;) {
      const start = cpuMs();
      for (let i = 0; i < batch; i++) run();
      if (cpuMs() - start >= 2 || batch >= 4096) break;
      batch *= 4;
    }
    let least = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 3; r++) {
      const start = cpuMs();
      for (let i = 0; i < batch; i++) run();
      least = Math.min(least, (cpuMs() - start) / batch);
    }
    return least;
  };
  const base = 5_000;

  it.each([
    ['one long line', 'designator', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['one long line', 'whole', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['breaks throughout', 'designator', (n: number) => '  \r\n'.repeat(n / 4)],
    ['breaks throughout', 'whole', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a digit run', 'designator', (n: number) => '1'.repeat(n)],
    ['a separator run', 'designator', (n: number) => '-'.repeat(n)],
    ['a separator run', 'whole', (n: number) => '-'.repeat(n)],
    [
      'distinct designators',
      'designator',
      (n: number) =>
        Array.from({ length: n / 4 }, (_, i) => `PA-${i}`)
          .join(' ')
          .slice(0, n),
    ],
  ] as const)('scans %s in %s mode in linear time', { timeout: 0 }, (_, mode, make) => {
    const columns = mode === 'whole' ? OWNER : MAKE_MODEL;
    const small = make(base);
    for (let size = base * 2; size <= base * 64; size *= 2) {
      const input = make(size);
      let growth = Number.POSITIVE_INFINITY;
      let perCall = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3; pair++) {
        const baseline = leastPerCall(() => toFtsMatch(small, columns, mode));
        const large = leastPerCall(() => toFtsMatch(input, columns, mode));
        perCall = Math.min(perCall, large);
        growth = Math.min(growth, large / baseline);
      }
      expect(growth, `${size} characters`).toBeLessThan((size / base) * 4);
      expect(perCall, `${size} characters, CPU ms`).toBeLessThan(size / 1000);
    }
  });
});

/**
 * Both searches over designator rows inserted per test. Codes 71010xx are public
 * manufacturers; 0560008 is a builder withheld by redaction, beside a public
 * 0560009 with the same model.
 */
describe('designator spellings in both searches', () => {
  let path: string;
  let service: RegistryService;

  beforeEach(async () => {
    path = tempDbPath();
    await buildFixtureDb(path);
    service = openService(path, true);
    const handle = await service.mirrorInstance.raw();
    handle.exec(`
      INSERT INTO aircraft_ref (code, mfr, model, builder_cert_code, manufacturer_redacted) VALUES
        ('7101001', 'PIPER', 'PA-28-181', '0', 0),
        ('7101002', 'PIPER', 'PA-28R-201', '0', 0),
        ('7101003', 'PIPER', 'PA-32R-301', '0', 0),
        ('7101004', 'CIRRUS', 'SR22', '0', 0),
        ('7101005', 'CIRRUS', 'SR-22', '0', 0),
        ('7101006', 'ROBINSON', 'R44 II', '0', 0),
        ('7101007', 'DE HAVILLAND', 'DHC-6-300', '0', 0),
        ('7101008', 'BELL', 'UH-1H', '0', 0),
        ('7101009', 'BELL', 'UH-1B', '0', 0),
        ('7101010', 'VOUGHT', 'F4U-1', '0', 0),
        ('7101011', 'VOUGHT', 'F4U-1D', '0', 0),
        ('0560008', 'JOHN SMITH', 'RV-8', '1', 1),
        ('0560009', 'VANS AIRCRAFT', 'RV-8', '1', 0);
      INSERT INTO aircraft_ref_fts (code, mfr, model) SELECT code, mfr, model FROM aircraft_ref
        WHERE code GLOB '71010*' OR code GLOB '056000*';
      INSERT INTO registration (n_number, mfr_mdl_code, make, model, owner_name) VALUES
        ('D01', '7101001', 'PIPER', 'PA-28-181', 'PA28 FLYERS LLC'),
        ('D02', '7101002', 'PIPER', 'PA-28R-201', 'SMITHSON AVIATION'),
        ('D03', '7101003', 'PIPER', 'PA-32R-301', 'JOHNSON & JOHNSON INC'),
        ('D04', '7101004', 'CIRRUS', 'SR22', NULL),
        ('D05', '7101005', 'CIRRUS', 'SR-22', NULL),
        ('D06', '7101006', 'ROBINSON', 'R44 II', 'SMITH FAMILY TRUST'),
        ('D07', '7101007', 'DE HAVILLAND', 'DHC-6-300', NULL),
        ('D08', '7101008', 'BELL', 'UH-1H', NULL),
        ('D09', '7101009', 'BELL', 'UH-1B', NULL),
        ('D10', '7101010', 'VOUGHT', 'F4U-1', NULL),
        ('D11', '7101011', 'VOUGHT', 'F4U-1D', NULL),
        ('V08', '0560008', 'JOHN SMITH', 'RV-8', NULL),
        ('V09', '0560009', 'VANS AIRCRAFT', 'RV-8', NULL);
    `);
  });

  afterEach(async () => {
    await service.mirrorInstance.close();
  });

  const registrations = async (makeModel: string, on = service) =>
    (await on.searchRegistrations({ ...page, makeModel }, ctx)).items.map(({ nNumber }) => nNumber);
  const types = async (query: string) =>
    (await service.searchAircraftTypes({ ...page, query }, ctx)).items.map(({ code }) => code);
  const unredacted = () => openService(path, false);

  it.each([
    ['PA28', 'PA-28', ['D01', 'D02'], ['7101001', '7101002']],
    ['PA32R', 'PA-32R', ['D03'], ['7101003']],
    ['PA28-181', 'PA-28-181', ['D01'], ['7101001']],
    ['SR-22', 'SR22', ['D04', 'D05'], ['7101005', '7101004']],
    ['R-44', 'R44', ['D06'], ['7101006']],
    ['DHC6', 'DHC-6', ['D07'], ['7101007']],
  ])('matches %s and %s to the same rows in both searches', async (one, other, rows, codes) => {
    expect(await registrations(one)).toEqual(rows);
    expect(await registrations(other)).toEqual(rows);
    expect(await types(one)).toEqual(codes);
    expect(await types(other)).toEqual(codes);
  });

  it('keeps every row a term matched as typed', async () => {
    expect(await registrations('UH-1H')).toEqual(['D08']);
    expect(await registrations('PA-32R')).toEqual(['D03']);
    expect(await registrations('F4U-1')).toEqual(['D10', 'D11']);
    expect(await types('UH-1H')).toEqual(['7101008']);
    expect(await types('F4U-1')).toEqual(['7101010', '7101011']);
  });

  it('ignores a separator-only term and returns an empty page for no usable term', async () => {
    expect(await registrations('cessna - 172')).toEqual(['12345', '5RP']);
    expect(await registrations('cessna - 172')).toEqual(await registrations('cessna 172'));
    expect(await types('cessna - 172')).toEqual(await types('cessna 172'));
    for (const text of ['-', '"""', '- /']) {
      expect(await service.searchRegistrations({ ...page, makeModel: text }, ctx)).toMatchObject({
        totalCount: 0,
        items: [],
        truncated: false,
      });
      expect(await service.searchAircraftTypes({ ...page, query: text }, ctx)).toMatchObject({
        totalCount: 0,
        items: [],
      });
    }
  });

  it('never matches a withheld builder name through an expanded designator', async () => {
    expect(await registrations('smith RV8')).toEqual([]);
    expect(await registrations('john RV-8')).toEqual([]);
    expect(await types('smith RV8')).toEqual([]);
    expect(await registrations('vans RV8')).toEqual(['V09']);
    expect(await registrations('RV8')).toEqual(['V08', 'V09']);
    expect(await types('RV8')).toEqual(['0560009', '0560008']);
    const walked: string[] = [];
    for (let offset = 0; offset <= 2; offset++) {
      const one = await service.searchRegistrations({ makeModel: 'RV8', limit: 1, offset }, ctx);
      expect(one.totalCount).toBe(2);
      expect(one.truncated).toBe(offset + 1 < 2);
      walked.push(...one.items.map(({ nNumber, make }) => `${nNumber}:${make ?? ''}`));
    }
    expect(walked).toEqual(['V08:', 'V09:VANS AIRCRAFT']);
    const open = unredacted();
    try {
      expect(await registrations('smith RV8', open)).toEqual(['V08']);
    } finally {
      await open.mirrorInstance.close();
    }
  });

  it('matches owner names as whole tokens, never expanded, ignoring separator-only terms', async () => {
    const open = unredacted();
    const owners = async (ownerName: string) =>
      (await open.searchRegistrations({ ...page, ownerName }, ctx)).items.map(
        ({ nNumber }) => nNumber,
      );
    try {
      expect(await owners('SMITH')).toEqual(['D06']);
      expect(await owners('PA28')).toEqual(['D01']);
      expect(await owners('PA-28')).toEqual([]);
      expect(await owners('JOHNSON & JOHNSON')).toEqual(['D03']);
      expect(await owners('&')).toEqual([]);
    } finally {
      await open.mirrorInstance.close();
    }
  });
});
