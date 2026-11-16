/**
 * @fileoverview SDK v2 shared-wire contract coverage for every FAA registry
 * tool: strict root inputs, production-shaped success output, and dual-surface
 * error envelopes used by 2026-07-28 and initialize-negotiated 2025 clients.
 * @module tests/integration/tool-contracts.int.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registrationResource } from '@/mcp-server/resources/definitions/registration.resource.js';
import { formatRegistrationRecord } from '@/mcp-server/tools/definitions/_schemas.js';
import { getAircraftTypeTool } from '@/mcp-server/tools/definitions/get-aircraft-type.tool.js';
import { getRegistrationStatusTool } from '@/mcp-server/tools/definitions/get-registration-status.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { lookupRegistrationTool } from '@/mcp-server/tools/definitions/lookup-registration.tool.js';
import { searchAircraftTypesTool } from '@/mcp-server/tools/definitions/search-aircraft-types.tool.js';
import { searchRegistrationsTool } from '@/mcp-server/tools/definitions/search-registrations.tool.js';
import { DESIGNATOR_SPELLING_BUDGET } from '@/services/registry/normalize.js';
import {
  getRegistryService,
  initRegistryService,
  resetRegistryService,
} from '@/services/registry/registry-service.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';
import { makeZip } from '../fixtures/make-zip.js';

const snapshotCalls = [
  [lookupRegistrationTool, { nNumber: 'N12345' }],
  [getRegistrationStatusTool, { nNumber: 'N99999' }],
  [getAircraftTypeTool, { code: '2072714' }],
  [searchRegistrationsTool, { state: 'WA', limit: 1 }],
  [searchAircraftTypesTool, { query: 'cessna', limit: 500, offset: 500 }],
] as const;

beforeAll(async () => {
  const mirrorPath = tempDbPath();
  await buildFixtureDb(mirrorPath);
  initRegistryService({
    redactOwnerPii: true,
    mirrorPath,
    databaseUrl: 'https://example.invalid/never-downloaded.zip',
  });
});

afterAll(async () => {
  await getRegistryService().mirrorInstance.close();
  resetRegistryService();
});

/** Swap the shared service onto another index; the caller restores the original afterwards. */
const useService = async (redactOwnerPii: boolean, mirrorPath: string) => {
  await getRegistryService().mirrorInstance.close();
  initRegistryService({
    redactOwnerPii,
    mirrorPath,
    databaseUrl: 'https://example.invalid/registry.zip',
  });
};

/** File path of the index the shared service currently reads. */
const currentIndexPath = async () => {
  const handle = await getRegistryService().mirrorInstance.raw();
  const file = handle.prepare<{ file: string }>('PRAGMA database_list').get()?.file;
  if (!file) throw new Error('The shared fixture index path was not captured.');
  return file;
};

const surfaces = (result: { structuredContent?: unknown; content: unknown }) =>
  JSON.stringify([result.structuredContent, result.content]);

describe.each([
  { definition: searchRegistrationsTool, filter: { state: 'WA' } },
  { definition: searchAircraftTypesTool, filter: { query: 'cessna' } },
])('$definition.name limit contract', ({ definition, filter }) => {
  it('keeps the repair of a positive integer string', async () => {
    // Simulate a string sent by an MCP client before argument repair.
    const result = await runToolContract(definition, {
      ...filter,
      limit: '25' as unknown as number,
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ totalCount: expect.any(Number) });
  });

  it('advertises a positive integer without a maximum', () => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' });
    expect(schema.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, default: 25 });
    expect(schema.properties?.limit).not.toHaveProperty('maximum');
  });

  it.each([0, -1, 1.5, '1.5', 'abc'])('rejects invalid limit %j', async (limit) => {
    const result = await runToolContract(definition, {
      ...filter,
      limit: limit as unknown as number,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_arguments' } },
    });
    expect(JSON.stringify(result.content)).toContain('invalid_arguments');
  });

  it.each([0, 500])('discloses the applied cap on a page at offset %i', async (offset) => {
    const result = await runToolContract(definition, { ...filter, limit: 500, offset });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const { notice } = z.object({ notice: z.string() }).parse(result.structuredContent);
    expect(notice).toEqual(expect.stringContaining('Requested limit 500; applied 200.'));
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    if (offset) expect(notice).toEqual(expect.stringContaining('past the end'));
    expect(JSON.stringify(result.content)).toContain(notice);
  });
});

it('retains cap, total and next offsets through both searches when a clamped page fills', async () => {
  const handle = await getRegistryService().mirrorInstance.raw();
  handle.exec(`
    WITH RECURSIVE items(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM items WHERE n<201)
    INSERT INTO registration (n_number, state) SELECT printf('6%04d', n), 'CA' FROM items;
    WITH RECURSIVE items(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM items WHERE n<201)
    INSERT INTO aircraft_ref (code, mfr, model, category_code, manufacturer_redacted)
      SELECT printf('8%06d', n), 'FIXTURE', 'MODEL', '3', 0 FROM items;
  `);
  try {
    for (const [definition, filter, key] of [
      [searchRegistrationsTool, { state: 'CA' }, 'registrations'],
      [searchAircraftTypesTool, { category: '3' }, 'aircraftTypes'],
    ] as const) {
      const first = await runToolContract(definition, { ...filter, limit: 500 });
      expect(first.structuredContent).toMatchObject({
        totalCount: 201,
        nextOffset: 200,
        shown: 200,
        cap: 200,
        truncated: true,
        notice: expect.stringContaining('offset: 200'),
      });
      expect(JSON.stringify(first.content)).toContain('Requested limit 500; applied 200.');
      expect(JSON.stringify(first.content)).toContain('offset: 200');
      const page = z.record(z.string(), z.unknown()).parse(first.structuredContent);
      expect(page[key]).toHaveLength(200);
      const last = await runToolContract(definition, { ...filter, limit: 500, offset: 200 });
      const lastPage = z.record(z.string(), z.unknown()).parse(last.structuredContent);
      expect(lastPage[key]).toHaveLength(1);
      expect(lastPage.totalCount).toBe(201);
      expect(lastPage).not.toHaveProperty('nextOffset');
      expect(lastPage).not.toHaveProperty('truncated');
    }
  } finally {
    handle.exec("DELETE FROM registration WHERE state = 'CA'");
    handle.exec("DELETE FROM aircraft_ref WHERE mfr = 'FIXTURE'");
  }
});

describe('snapshot metadata', () => {
  it.each([
    ['2026-11-10', false],
    ['2026-11-03', false],
    ['2026-11-02', true],
    [null, true],
  ] as const)('reports the date and composes notices for %s', async (date, refresh) => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle
      .prepare(
        "INSERT INTO registry_generation (id, owner, generation, loading, data_as_of) VALUES (1, 'test', 0, 0, ?)",
      )
      .run(date);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T23:59:59Z'));
    try {
      for (const [definition, input] of snapshotCalls) {
        const result = await runToolContract(definition, input);
        expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
        const text = result.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n');
        const output = z
          .object({
            dataAsOf: z.string().optional(),
            notice: z.string().optional(),
          })
          .parse(result.structuredContent);
        if (date) {
          expect(output.dataAsOf).toBe(date);
          expect(text).toContain(date);
        } else {
          expect(result.structuredContent).not.toHaveProperty('dataAsOf');
        }
        expect(text.includes('mirror:refresh')).toBe(refresh);
        const { notice } = output;
        if (notice) expect(text).toContain(notice);
        if (definition.name === 'faa_search_registrations') {
          expect(notice).toEqual(expect.stringContaining('offset: 1'));
        }
        if (definition.name === 'faa_search_aircraft_types') {
          expect(notice).toEqual(expect.stringContaining('past the end'));
          expect(notice).toEqual(expect.stringContaining('Requested limit 500; applied 200.'));
        }
      }
    } finally {
      vi.useRealTimers();
      handle.exec('DELETE FROM registry_generation');
    }
  });

  it('returns retryable loading errors through every tool and the registration resource', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle.exec(
      "INSERT INTO registry_generation (id, owner, generation, loading) VALUES (1, 'test', 0, 1)",
    );
    try {
      for (const [definition, input] of snapshotCalls) {
        const result = await runToolContract(definition, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: {
              reason: 'mirror_loading',
              retryable: true,
              recovery: { hint: expect.stringContaining('mirror:refresh') },
            },
          },
        });
        expect(JSON.stringify(result.content)).toContain('mirror_loading');
        expect(JSON.stringify(result.content)).toContain('retryable');
      }
      expect(registrationResource.errors).toContainEqual(
        expect.objectContaining({
          reason: 'mirror_loading',
          retryable: true,
        }),
      );
      await expect(
        registrationResource.handler(
          { nNumber: 'N12345' },
          createMockContext({ errors: registrationResource.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'mirror_loading' } });
    } finally {
      handle.exec('DELETE FROM registry_generation');
    }
  });
});

it('includes existing operations and positive engine ratings on lookup and in the resource', async () => {
  const handle = await getRegistryService().mirrorInstance.raw();
  handle.exec("UPDATE engine_ref SET thrust = 1250 WHERE code = '41514'");
  try {
    const input = { nNumber: 'N12345' };
    const result = await runToolContract(lookupRegistrationTool, input);
    const expected = {
      approvedOperationsRaw: 'NAGT',
      approvedOperations: expect.arrayContaining([{ code: 'N', label: 'Normal' }]),
      engineHorsepower: 180,
      engineThrustLbs: 1250,
    };
    expect(result.structuredContent).toMatchObject(expected);
    const content = JSON.stringify(result.content);
    for (const rendered of ['Normal (N)', '180 hp', '1250 lb']) expect(content).toContain(rendered);
    const resource = await registrationResource.handler(
      input,
      createMockContext({ errors: registrationResource.errors }),
    );
    expect(registrationResource.output?.parse(resource)).toMatchObject(expected);
    expect(resource).not.toHaveProperty('dataAsOf');
  } finally {
    handle.exec("UPDATE engine_ref SET thrust = NULL WHERE code = '41514'");
  }
});

it('finds a serial by itself and retains its exact stored form on both surfaces', async () => {
  const result = await runToolContract(searchRegistrationsTool, { serialNumber: ' 172s0001 ' });
  expect(result.structuredContent).toMatchObject({
    totalCount: 1,
    registrations: [{ nNumber: '12345', serialNumber: '172S0001' }],
  });
  expect(JSON.stringify(result.content)).toContain('Serial: 172S0001');
  const prefix = await runToolContract(searchRegistrationsTool, { serialNumber: '172S' });
  expect(prefix.structuredContent).toMatchObject({ totalCount: 0, registrations: [] });
});

it('renders the latest DEREG fields and every ordered cancellation row', async () => {
  const handle = await getRegistryService().mirrorInstance.raw();
  handle.exec("UPDATE dereg SET export_country = 'CA', year_mfr = 2001 WHERE n_number = '404ER'");
  handle.exec(
    "INSERT INTO dereg (n_number, serial_number, cancel_date) VALUES ('404ER', 'OLDER-SERIAL', '2010-03-04')",
  );
  try {
    const result = await runToolContract(getRegistrationStatusTool, { nNumber: '404ER' });
    expect(result.structuredContent).toMatchObject({
      recordType: 'deregistered',
      exportCountry: 'CA',
      yearManufactured: 2001,
      make: 'CESSNA',
      model: '172S',
      cancellations: [
        { exportCountry: 'CA', serialNumber: 'DEREG-SN', cancelDate: '2020-06-15' },
        { serialNumber: 'OLDER-SERIAL', cancelDate: '2010-03-04' },
      ],
    });
    const content = JSON.stringify(result.content);
    for (const rendered of ['OLDER-SERIAL', '2010-03-04', '2001', 'CA', 'CESSNA', '172S']) {
      expect(content).toContain(rendered);
    }
    expect(content.indexOf('DEREG-SN')).toBeLessThan(content.indexOf('OLDER-SERIAL'));
  } finally {
    handle.exec("DELETE FROM dereg WHERE serial_number = 'OLDER-SERIAL'");
    handle.exec("UPDATE dereg SET export_country = NULL, year_mfr = NULL WHERE n_number = '404ER'");
  }
});

it('keeps public model prefixes discoverable and withholds classified manufacturers on every surface', async () => {
  const handle = await getRegistryService().mirrorInstance.raw();
  handle.exec(`
    UPDATE aircraft_ref SET manufacturer_redacted = 1, mfr = 'EXAMPLE PRIVATE MAKER'
      WHERE code = '2072714';
    UPDATE aircraft_ref_fts SET mfr = 'EXAMPLE PRIVATE MAKER' WHERE code = '2072714';
    UPDATE registration SET make = 'EXAMPLE PRIVATE MAKER', kit_mfr = 'EXAMPLE PRIVATE MAKER'
      WHERE n_number = '12345';
  `);
  try {
    for (const [definition, input, field] of [
      [lookupRegistrationTool, { nNumber: '12345' }, 'make'],
      [getAircraftTypeTool, { code: '2072714' }, 'manufacturer'],
      [getRegistrationStatusTool, { nNumber: '404ER' }, 'make'],
    ] as const) {
      const result = await runToolContract(definition, input);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty(field);
      expect(JSON.stringify(result.structuredContent)).not.toContain('EXAMPLE PRIVATE MAKER');
      expect(JSON.stringify(result.content)).not.toContain('EXAMPLE PRIVATE MAKER');
      if (definition === lookupRegistrationTool) {
        expect(result.structuredContent).not.toHaveProperty('kitManufacturer');
      }
    }
    for (const [definition, filterKey, key, exact] of [
      [searchRegistrationsTool, 'makeModel', 'registrations', { manufacturerModelCode: '2072714' }],
      [searchAircraftTypesTool, 'query', 'aircraftTypes', {}],
    ] as const) {
      const hidden = await runToolContract(definition, { [filterKey]: 'example 172', ...exact });
      expect(hidden.structuredContent).toMatchObject({ totalCount: 0, [key]: [] });
      const visible = await runToolContract(definition, { [filterKey]: '172', ...exact });
      expect(visible.isError).not.toBe(true);
      expect(JSON.stringify(visible.structuredContent)).toContain('2072714');
      expect(JSON.stringify(visible.content)).toContain('172S');
      expect(JSON.stringify(visible.structuredContent)).not.toContain('EXAMPLE PRIVATE MAKER');
      expect(JSON.stringify(visible.content)).not.toContain('EXAMPLE PRIVATE MAKER');
    }
    const resource = await registrationResource.handler(
      { nNumber: '12345' },
      createMockContext({ errors: registrationResource.errors }),
    );
    expect(registrationResource.output?.parse(resource)).toMatchObject({ model: '172S' });
    expect(JSON.stringify(resource)).not.toContain('EXAMPLE PRIVATE MAKER');
  } finally {
    handle.exec(`
      UPDATE aircraft_ref SET manufacturer_redacted = 0, mfr = 'CESSNA' WHERE code = '2072714';
      UPDATE aircraft_ref_fts SET mfr = 'CESSNA' WHERE code = '2072714';
      UPDATE registration SET make = 'CESSNA', kit_mfr = NULL WHERE n_number = '12345';
    `);
  }
});

toolContractSuite(lookupRegistrationTool, {
  success: [{ name: 'returns an active registration', input: { nNumber: 'N12345' } }],
  errors: [
    {
      name: 'returns the validation error envelope for a malformed N-number',
      input: { nNumber: 'BANANA' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_n_number',
    },
  ],
});

toolContractSuite(getRegistrationStatusTool, {
  success: [{ name: 'returns registration status', input: { nNumber: 'N12345' } }],
  errors: [
    {
      name: 'returns the validation error envelope for a malformed N-number',
      input: { nNumber: 'BANANA' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_n_number',
    },
  ],
});

toolContractSuite(searchRegistrationsTool, {
  success: [
    {
      name: 'returns registration matches with enrichment',
      input: { makeModel: 'cessna', limit: 25, offset: 0 },
    },
  ],
  errors: [
    {
      name: 'returns the validation error envelope when filters are absent',
      input: { limit: 25, offset: 0 },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'no_filters',
    },
  ],
});

toolContractSuite(searchAircraftTypesTool, {
  success: [
    {
      name: 'returns aircraft-type matches with enrichment',
      input: { query: 'cessna', limit: 25, offset: 0 },
    },
  ],
  errors: [
    {
      name: 'returns the validation error envelope when filters are absent',
      input: { limit: 25, offset: 0 },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'no_filters',
    },
  ],
});

toolContractSuite(getAircraftTypeTool, {
  success: [{ name: 'returns decoded aircraft specs', input: { code: '2072714' } }],
  errors: [
    {
      name: 'returns the validation error envelope for a malformed aircraft code',
      input: { code: 'ABC' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_code',
    },
  ],
});

/**
 * The wire envelope a client actually receives, taken through the production
 * rejection path rather than a direct `.handler()` call. Two distinct shapes:
 * an argument rejection, which never reaches the handler and classifies
 * `InvalidParams`, and a handler-thrown contract error, which stays on its
 * declared code. Assertions are containment, not byte-exact — the framework
 * owns this text and appends to it.
 */
describe('error envelope on the wire', () => {
  it.each([
    ['CLASS 1', 'Maximum gross takeoff weight up to 12,499 lb'],
    ['CLASS 2', 'Maximum gross takeoff weight 12,500–19,999 lb'],
    ['CLASS 3', 'Maximum gross takeoff weight 20,000 lb and over'],
    ['CLASS 4', 'Maximum gross takeoff weight: UAV up to 55 lb'],
  ])(
    'decodes %s at query time on both response surfaces',
    async (weightClass, weightClassLabel) => {
      const handle = await getRegistryService().mirrorInstance.raw();
      handle
        .prepare('UPDATE aircraft_ref SET weight_class = ? WHERE code = ?')
        .run(weightClass, '1234567');
      try {
        const result = await runToolContract(getAircraftTypeTool, { code: '1234567' });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ weightClass, weightClassLabel });
        expect(JSON.stringify(result.content)).toContain(weightClass);
        expect(JSON.stringify(result.content)).toContain(weightClassLabel);
      } finally {
        handle.prepare('UPDATE aircraft_ref SET weight_class = NULL WHERE code = ?').run('1234567');
      }
    },
  );
  it('preserves raw weight strings and omits absent or blank weights', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    for (const raw of ['CLASS 1', 'ODD CLASS', '', '  ', null]) {
      handle.prepare('UPDATE aircraft_ref SET weight_class = ? WHERE code = ?').run(raw, '1234567');
      const result = await runToolContract(getAircraftTypeTool, { code: '1234567' });
      expect(result.isError).not.toBe(true);
      if (raw?.trim()) {
        expect(result.structuredContent).toMatchObject({ weightClass: raw });
        expect(JSON.stringify(result.content)).toContain(raw);
      } else {
        expect(result.structuredContent).not.toHaveProperty('weightClass');
        expect(JSON.stringify(result.content)).not.toContain('Weight class');
      }
      if (raw !== 'CLASS 1') {
        expect(result.structuredContent).not.toHaveProperty('weightClassLabel');
        expect(JSON.stringify(result.content)).not.toContain('Weight class range');
      }
    }
  });
  it('returns a six-character FAA aircraft reference through production output parsing', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle
      .prepare('INSERT INTO aircraft_ref (code, mfr, model) VALUES (?, ?, ?)')
      .run('056387', 'DOGGETT JOHN ROY', 'JRD VP-II');
    try {
      const result = await runToolContract(getAircraftTypeTool, { code: ' 056387 ' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: '056387',
        model: 'JRD VP-II',
      });
      // This legacy reference has no certification/classification evidence.
      expect(result.structuredContent).not.toHaveProperty('manufacturer');
      expect(JSON.stringify(result.content)).toContain('056387');
      expect(JSON.stringify(result.content)).toContain('JRD VP-II');
      expect(JSON.stringify(result.content)).not.toContain('DOGGETT JOHN ROY');
    } finally {
      handle.prepare('DELETE FROM aircraft_ref WHERE code = ?').run('056387');
    }
  });
  it('filters exact manufacturer codes through capped, last and past-end wire pages', async () => {
    const pages = [];
    for (const offset of [0, 1, 2]) {
      const result = await runToolContract(searchRegistrationsTool, {
        manufacturerModelCode: ' 2072714 ',
        limit: 1,
        offset,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ totalCount: 2 });
      const body = result.structuredContent as {
        registrations: {
          nNumber: string;
          manufacturerModelCode: string;
          ownerRedacted: boolean;
          ownerName?: string;
        }[];
        nextOffset?: number;
      };
      if (offset < 2) {
        expect(body.registrations).toHaveLength(1);
        expect(body.registrations[0]).toMatchObject({
          manufacturerModelCode: '2072714',
          ownerRedacted: true,
        });
        expect(body.registrations[0]).not.toHaveProperty('ownerName');
        expect(JSON.stringify(result.content)).toContain('2072714');
        pages.push(body.registrations[0]?.nNumber);
      } else {
        expect(body.registrations).toEqual([]);
        expect(JSON.stringify(result.content)).toContain('past the end');
      }
      expect(body.nextOffset).toBe(offset === 0 ? 1 : undefined);
    }
    expect(pages).toEqual(['12345', '5RP']);
    for (const manufacturerModelCode of ['0000000', '056387']) {
      const result = await runToolContract(searchRegistrationsTool, {
        manufacturerModelCode,
        limit: 25,
        offset: 0,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ registrations: [], totalCount: 0 });
      expect(JSON.stringify(result.content)).toContain('No matching registrations');
    }
    const combined = await runToolContract(searchRegistrationsTool, {
      manufacturerModelCode: '2072714',
      makeModel: 'hiller',
      limit: 25,
      offset: 0,
    });
    expect(combined.structuredContent).toMatchObject({ registrations: [], totalCount: 0 });
  });

  it('normalizes short alphanumeric codes and omits absent summary codes', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle
      .prepare('UPDATE registration SET mfr_mdl_code = ? WHERE n_number = ?')
      .run('AB12CD', '99SP');
    try {
      const result = await runToolContract(searchRegistrationsTool, {
        manufacturerModelCode: ' ab12cd ',
        limit: 25,
        offset: 0,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        registrations: [{ nNumber: '99SP', manufacturerModelCode: 'AB12CD' }],
      });
      expect(JSON.stringify(result.content)).toContain('AB12CD');
      handle.prepare('UPDATE registration SET mfr_mdl_code = NULL WHERE n_number = ?').run('99SP');
      const absent = await runToolContract(searchRegistrationsTool, {
        modeSCode: '99FACE',
        limit: 25,
        offset: 0,
      });
      expect(absent.isError).not.toBe(true);
      expect(
        (absent.structuredContent as { registrations: object[] }).registrations[0],
      ).not.toHaveProperty('manufacturerModelCode');
      expect(JSON.stringify(absent.content)).not.toContain('Mfr/model code:');
    } finally {
      handle
        .prepare('UPDATE registration SET mfr_mdl_code = ? WHERE n_number = ?')
        .run('1234567', '99SP');
    }
  });

  it('declares code validation and treats blank code as unset', async () => {
    const invalid = await runToolContract(searchRegistrationsTool, {
      manufacturerModelCode: 'ABC',
      state: 'WA',
      limit: 25,
      offset: 0,
    });
    expect(invalid.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_code',
          recovery: { hint: expect.stringContaining('faa_search_aircraft_types') },
        },
      },
    });
    expect(JSON.stringify(invalid.content)).toContain('invalid_code');
    expect(JSON.stringify(invalid.content)).toContain('Recovery:');
    const blank = await runToolContract(searchRegistrationsTool, {
      manufacturerModelCode: ' ',
      limit: 25,
      offset: 0,
    });
    expect(blank.structuredContent).toMatchObject({ error: { data: { reason: 'no_filters' } } });
    const unset = await runToolContract(searchRegistrationsTool, {
      manufacturerModelCode: ' ',
      state: 'WA',
      limit: 25,
      offset: 0,
    });
    expect(unset.isError).not.toBe(true);
    expect(unset.structuredContent).toMatchObject({ totalCount: 2 });
  });
  it.each([
    ['state', 'Washington', 'invalid_state'],
    ['modeSCode', 'NOTHEX', 'invalid_mode_s_code'],
    ['aircraftType', '99', 'invalid_aircraft_type'],
  ])(
    'returns the registration %s domain reason and recovery on both surfaces',
    async (field, value, reason) => {
      const result = await runToolContract(searchRegistrationsTool, {
        makeModel: 'cessna',
        [field]: value,
        limit: 25,
        offset: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: expect.any(String) } },
        },
      });
      expect(JSON.stringify(result.content)).toContain(reason);
      expect(JSON.stringify(result.content)).toContain('Recovery:');
    },
  );

  it.each([
    ['aircraftType', '99', 'invalid_aircraft_type'],
    ['category', '9', 'invalid_category'],
  ])(
    'returns the aircraft %s domain reason and recovery on both surfaces',
    async (field, value, reason) => {
      const result = await runToolContract(searchAircraftTypesTool, {
        query: 'cessna',
        [field]: value,
        limit: 25,
        offset: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: expect.any(String) } },
        },
      });
      expect(JSON.stringify(result.content)).toContain(reason);
      expect(JSON.stringify(result.content)).toContain('Recovery:');
    },
  );

  it('keeps normalized, blank and valid empty search behavior on the wire', async () => {
    const normalized = await runToolContract(searchRegistrationsTool, {
      state: ' wa ',
      aircraftType: ' 4 ',
      modeSCode: ' a4e2d9 ',
      limit: 25,
      offset: 0,
    });
    expect(normalized.isError).not.toBe(true);
    expect(normalized.structuredContent).toMatchObject({ registrations: [{ nNumber: '12345' }] });
    expect(JSON.stringify(normalized.content)).toContain('N12345');
    for (const state of ['AE', 'AP', 'GU', 'ZZ']) {
      const absent = await runToolContract(searchRegistrationsTool, {
        state,
        limit: 25,
        offset: 0,
      });
      expect(absent.isError).not.toBe(true);
      expect(absent.structuredContent).toMatchObject({ registrations: [], totalCount: 0 });
      expect(JSON.stringify(absent.content)).toContain('No matching registrations');
    }
    for (const [definition, input] of [
      [
        searchRegistrationsTool,
        { state: ' ', modeSCode: '', aircraftType: ' ', limit: 25, offset: 0 },
      ],
      [searchAircraftTypesTool, { aircraftType: ' ', category: ' ', limit: 25, offset: 0 }],
    ] as const) {
      const result = await runToolContract(definition, input);
      expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'no_filters' } } });
    }
    const types = await runToolContract(searchAircraftTypesTool, {
      query: ' cessna ',
      category: ' 1 ',
      aircraftType: ' 4 ',
      limit: 25,
      offset: 0,
    });
    expect(types.isError).not.toBe(true);
    expect(types.structuredContent).toMatchObject({ totalCount: 3 });
  });
  it('shares corrected numeric status labels across lookup, active status, search and resource', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle.prepare('UPDATE registration SET status_code = ? WHERE n_number = ?').run('29', '12345');
    try {
      for (const [definition, input] of [
        [lookupRegistrationTool, { nNumber: '12345' }],
        [getRegistrationStatusTool, { nNumber: '12345' }],
      ] as const) {
        const result = await runToolContract(definition, input);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: { code: '29', label: 'Registration Expired – Pending Cancellation' },
        });
        expect(JSON.stringify(result.content)).toContain(
          'Registration Expired – Pending Cancellation',
        );
      }
      const search = await runToolContract(searchRegistrationsTool, {
        state: 'WA',
        limit: 25,
        offset: 0,
      });
      expect(search.structuredContent).toMatchObject({
        registrations: expect.arrayContaining([
          expect.objectContaining({
            status: { code: '29', label: 'Registration Expired – Pending Cancellation' },
          }),
        ]),
      });
      expect(JSON.stringify(search.content)).toContain(
        'Registration Expired – Pending Cancellation',
      );
      const resource = await registrationResource.handler(
        { nNumber: '12345' },
        createMockContext({ errors: registrationResource.errors }),
      );
      expect(resource.status).toEqual({
        code: '29',
        label: 'Registration Expired – Pending Cancellation',
      });
      expect(formatRegistrationRecord(resource)).toContain(
        'Registration Expired – Pending Cancellation',
      );
      const dereg = await runToolContract(getRegistrationStatusTool, { nNumber: '404ER' });
      expect(dereg.structuredContent).toMatchObject({
        status: { code: '22', label: 'Revoked – Canceled' },
      });
      expect(JSON.stringify(dereg.content)).toContain('Revoked – Canceled');
    } finally {
      handle
        .prepare('UPDATE registration SET status_code = ? WHERE n_number = ?')
        .run('V', '12345');
    }
  });
  it('rejects an out-of-schema argument as InvalidParams with a recovery hint', async () => {
    const result = await runToolContract(
      lookupRegistrationTool,
      /**
       * Wrong type for a declared field — rejected at argument validation. A
       * boolean, because pre-validation repairs an integer sent for a string.
       */
      { nNumber: true } as unknown as { nNumber: string },
    );

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toMatchObject({ reason: 'invalid_arguments' });

    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('nNumber');
    expect(text).toContain('Recovery:');
  });

  it('closes a handler-thrown contract error with its reason and retryable terms', async () => {
    const result = await runToolContract(lookupRegistrationTool, { nNumber: 'BANANA' });

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_n_number' });

    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('reason invalid_n_number');
  });
});

/**
 * An unmatched Mode S search names what the address encodes. The decode table
 * lives in tests/services/mode-s.test.ts; these cases prove the wiring once per
 * branch, through the production parse and the content[] trailer.
 */
describe('faa_search_registrations unmatched Mode S code', () => {
  const N399WM_SENTENCE =
    'Mode S code A4A638 encodes N399WM. Call faa_get_registration_status with N399WM for its current state and cancellation history.';

  it('adds nothing when a Mode S search has matches, on the page or past its end', async () => {
    for (const offset of [0, 1]) {
      const result = await runToolContract(searchRegistrationsTool, {
        modeSCode: 'A4E2D9',
        offset,
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ totalCount: 1 });
      expect(result.structuredContent).not.toHaveProperty('encodedNNumber');
      for (const surface of [result.structuredContent, result.content]) {
        expect(JSON.stringify(surface)).not.toContain('encode');
      }
      if (offset) expect(JSON.stringify(result.content)).toContain('past the end');
    }
  });

  it.each([
    { modeSCode: 'a4a638' },
    { modeSCode: 'A4A638', state: 'WA' },
    { modeSCode: ' a4a638 ', offset: 3 },
  ])('names the encoded N-number for $modeSCode on both surfaces', async (input) => {
    const result = await runToolContract(searchRegistrationsTool, input);
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      registrations: [],
      totalCount: 0,
      encodedNNumber: 'N399WM',
      notice: expect.stringContaining(N399WM_SENTENCE),
    });
    const content = JSON.stringify(result.content);
    expect(content).toContain(N399WM_SENTENCE);
    expect(content).toContain('**encodedNNumber:** `N399WM`');
    expect(content).not.toContain('undefined');
  });

  it.each([
    ['ADF7C8', 'is in the US allocation (A00000–AFFFFF) but encodes no N-number.'],
    ['3C6444', 'is outside the US allocation (A00000–AFFFFF) and encodes no N-number.'],
  ])('explains why %s encodes no N-number without encodedNNumber', async (modeSCode, tail) => {
    const result = await runToolContract(searchRegistrationsTool, { modeSCode });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const sentence = `Mode S code ${modeSCode} ${tail}`;
    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      notice: expect.stringContaining(sentence),
    });
    expect(result.structuredContent).not.toHaveProperty('encodedNNumber');
    const content = JSON.stringify(result.content);
    expect(content).toContain(sentence);
    expect(content).not.toContain('encodedNNumber');
    expect(content).not.toContain('undefined');
  });

  it('joins the decode with the limit-clamp and stale-snapshot notices', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle
      .prepare(
        "INSERT INTO registry_generation (id, owner, generation, loading, data_as_of) VALUES (1, 'test', 0, 0, ?)",
      )
      .run('2026-11-02');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T23:59:59Z'));
    try {
      const result = await runToolContract(searchRegistrationsTool, {
        modeSCode: 'A4A638',
        limit: 500,
      });
      const { notice } = z.object({ notice: z.string() }).parse(result.structuredContent);
      const parts = [
        'Requested limit 500; applied 200.',
        'No registrations matched the supplied filters.',
        N399WM_SENTENCE,
        'The FAA registry snapshot is more than seven days old.',
      ];
      for (const part of parts) expect(notice).toContain(part);
      const positions = parts.map((part) => notice.indexOf(part));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(result.structuredContent).toMatchObject({ encodedNNumber: 'N399WM' });
      expect(JSON.stringify(result.content)).toContain(notice);
    } finally {
      vi.useRealTimers();
      handle.exec('DELETE FROM registry_generation');
    }
  });
});

describe('faa_search_registrations engine, airworthiness and year filters on the wire', () => {
  const newFilters = [
    'engineManufacturerModelCode',
    'airworthinessClass',
    'yearManufacturedMin',
    'yearManufacturedMax',
  ];
  const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    JSON.stringify(result.content);

  it.each([
    [{ engineManufacturerModelCode: 'IO520' }, 'invalid_engine_code', '17026'],
    [{ airworthinessClass: '0' }, 'invalid_airworthiness_class', '4 Experimental'],
    [
      { yearManufacturedMin: 2015, yearManufacturedMax: 2008 },
      'invalid_year_range',
      'only one of the two bounds',
    ],
  ])('returns %j as %s with its recovery on both surfaces', async (filter, reason, hint) => {
    const result = await runToolContract(searchRegistrationsTool, { ...filter, state: 'WA' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason, recovery: { hint: expect.stringContaining(hint) } },
      },
    });
    expect(text(result)).toContain(reason);
    expect(text(result)).toContain(hint);
  });

  it.each([
    ['yearManufacturedMin', 75],
    ['yearManufacturedMin', 1975.5],
    ['yearManufacturedMax', 10000],
    ['yearManufacturedMax', 'abc'],
  ])('rejects %s %j at the schema', async (field, value) => {
    const result = await runToolContract(searchRegistrationsTool, {
      state: 'WA',
      [field]: value as unknown as number,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(text(result)).toContain(field);
  });

  it('repairs a year sent as a string and codes sent as integers', async () => {
    const result = await runToolContract(searchRegistrationsTool, {
      yearManufacturedMin: '2008' as unknown as number,
      engineManufacturerModelCode: 41514 as unknown as string,
      airworthinessClass: 1 as unknown as string,
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ totalCount: 2 });
    // An integer drops a leading zero, which the five-digit rule then rejects.
    const zero = await runToolContract(searchRegistrationsTool, {
      engineManufacturerModelCode: 1234 as unknown as string,
    });
    expect(zero.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_engine_code' } },
    });
  });

  it('advertises four-digit integer year bounds and unrestricted code strings', () => {
    const schema = z.toJSONSchema(searchRegistrationsTool.input, { io: 'input' });
    for (const field of ['yearManufacturedMin', 'yearManufacturedMax']) {
      expect(schema.properties?.[field]).toMatchObject({
        type: 'integer',
        minimum: 1000,
        maximum: 9999,
      });
    }
    for (const field of ['engineManufacturerModelCode', 'airworthinessClass']) {
      expect(schema.properties?.[field]).toMatchObject({ type: 'string' });
      expect(schema.properties?.[field]).not.toHaveProperty('pattern');
      expect(schema.properties?.[field]).not.toHaveProperty('enum');
    }
    for (const field of newFilters) expect(schema.required ?? []).not.toContain(field);
  });

  it('names every new filter in the no_filters and owner_search_disabled recoveries', async () => {
    for (const [input, reason] of [
      [{ engineManufacturerModelCode: ' ', airworthinessClass: '' }, 'no_filters'],
      [{ ownerName: 'PUBLIC' }, 'owner_search_disabled'],
    ] as const) {
      const result = await runToolContract(searchRegistrationsTool, input);
      expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
      const { hint } = z
        .object({
          error: z.object({ data: z.object({ recovery: z.object({ hint: z.string() }) }) }),
        })
        .parse(result.structuredContent).error.data.recovery;
      for (const field of newFilters) {
        expect(hint, reason).toContain(field);
        expect(text(result), reason).toContain(field);
      }
    }
  });

  it('pages each filter alone and beside a make/model term with matching totals', async () => {
    for (const filter of [
      { engineManufacturerModelCode: '41514' },
      { airworthinessClass: '1', makeModel: 'cessna' },
      { yearManufacturedMin: 2000, makeModel: '172' },
    ]) {
      const first = await runToolContract(searchRegistrationsTool, { ...filter, limit: 1 });
      expect(first.structuredContent, JSON.stringify(filter)).toMatchObject({
        totalCount: 2,
        nextOffset: 1,
        registrations: [{ nNumber: '12345' }],
      });
      expect(text(first)).toContain('offset: 1');
      const last = await runToolContract(searchRegistrationsTool, {
        ...filter,
        limit: 1,
        offset: 1,
      });
      expect(last.structuredContent).toMatchObject({
        totalCount: 2,
        registrations: [{ nNumber: '5RP' }],
      });
      expect(last.structuredContent).not.toHaveProperty('nextOffset');
    }
  });

  it('never returns a blank year for a max-only bound', async () => {
    const result = await runToolContract(searchRegistrationsTool, { yearManufacturedMax: 2010 });
    expect(result.structuredContent).toMatchObject({
      totalCount: 1,
      registrations: [{ nNumber: '12345', yearManufactured: 2008 }],
    });
    expect(text(result)).not.toMatch(/N105HH|N99SP/);
  });

  it('carries the stored engine code and class on both surfaces and omits blanks', async () => {
    const handle = await getRegistryService().mirrorInstance.raw();
    handle.exec(`
      UPDATE registration SET eng_mfr_mdl_code = '01234', airworthiness_class_code = '4'
      WHERE n_number = '105HH';
    `);
    try {
      const result = await runToolContract(searchRegistrationsTool, {
        airworthinessClass: ' 4 ',
        engineManufacturerModelCode: ' 01234 ',
      });
      expect(result.structuredContent).toMatchObject({
        totalCount: 1,
        registrations: [
          {
            nNumber: '105HH',
            engineManufacturerModelCode: '01234',
            airworthinessClass: { code: '4', label: 'Experimental' },
          },
        ],
      });
      expect(text(result)).toContain('Engine mfr/model code: 01234');
      expect(text(result)).toContain('Airworthiness class: Experimental (4)');
      const sparse = await runToolContract(searchRegistrationsTool, { modeSCode: '99FACE' });
      const [row] = z
        .object({ registrations: z.array(z.record(z.string(), z.unknown())) })
        .parse(sparse.structuredContent).registrations;
      expect(row).toMatchObject({ nNumber: '99SP' });
      expect(row).not.toHaveProperty('engineManufacturerModelCode');
      expect(row).not.toHaveProperty('airworthinessClass');
      expect(text(sparse)).not.toMatch(/Engine mfr\/model code|Airworthiness class/);
    } finally {
      handle.exec(`
        UPDATE registration SET eng_mfr_mdl_code = NULL, airworthiness_class_code = NULL
        WHERE n_number = '105HH';
      `);
    }
  });
});

describe('SDK v2 advertised tool schemas', () => {
  it('keeps every root input closed and reserves error for the framework envelope', () => {
    for (const definition of allToolDefinitions) {
      const inputSchema = z.toJSONSchema(definition.input);
      expect(inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(definition.output.shape).not.toHaveProperty('error');
      expect(definition.enrichment ?? {}).not.toHaveProperty('error');
    }
  });

  it('advertises exact search filters as unrestricted optional strings', () => {
    for (const [definition, fields] of [
      [searchRegistrationsTool, ['state', 'modeSCode', 'aircraftType']],
      [searchAircraftTypesTool, ['aircraftType', 'category']],
    ] as const) {
      const schema = z.toJSONSchema(definition.input);
      for (const field of fields) {
        expect(schema.properties?.[field]).toMatchObject({ type: 'string' });
        expect(schema.properties?.[field]).not.toHaveProperty('enum');
        expect(schema.properties?.[field]).not.toHaveProperty('pattern');
      }
    }
  });
});

/**
 * A builder name that reorders the registrant's name, classified by a real
 * rebuild of its own index and read back through every tool. The shared
 * fixture service is restored afterwards.
 */
describe('builder name withheld by a rebuild', () => {
  const builderPath = tempDbPath();
  let sharedPath: string;
  const typeCodes = (result: { structuredContent?: unknown }) =>
    z
      .object({ aircraftTypes: z.array(z.object({ code: z.string() })) })
      .parse(result.structuredContent)
      .aircraftTypes.map(({ code }) => code);

  beforeAll(async () => {
    sharedPath = await currentIndexPath();
    await useService(true, builderPath);
    const zip = makeZip([
      { name: 'ENGINE.txt', data: Buffer.from('CODE,MFR,MODEL\n') },
      { name: 'RESERVED.txt', data: Buffer.from('N-NUMBER\n') },
      {
        name: 'ACFTREF.txt',
        data: Buffer.from(
          [
            'CODE,MFR,MODEL,TYPE-ACFT,BUILD-CERT-IND',
            '056TEST,JOHN A SMITH,JS-1,4,1',
            '056TES2,AAA PUBLIC WORKS,AP-1,4,1',
            '056TES3,ZACH Q YOUNG,AA-1,4,1',
          ].join('\n'),
        ),
      },
      {
        name: 'DEREG.txt',
        data: Buffer.from(
          'N-NUMBER,MFR-MDL-CODE,NAME,CANCEL-DATE\n44TS,056TEST,EARLIER OWNER,20200615\n',
        ),
      },
      {
        name: 'MASTER.txt',
        data: Buffer.from(
          [
            'N-NUMBER,MFR MDL CODE,NAME,TYPE REGISTRANT,STATE,KIT MFR,KIT MODEL',
            '7TS,056TEST,SMITH JOHN A,1,WA,JOHN A SMITH,JS-1',
            '9TS,056TEST,DOE JANE,1,OR,EXAMPLE KIT CO,JS-1',
            '8TS,056TES2,PUBLIC OWNER,1,WA,,',
            '6TS,056TES3,YOUNG ZACH Q,1,WA,,',
          ].join('\n'),
        ),
      },
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(zip));
    try {
      await getRegistryService().mirrorInstance.runSync({ mode: 'init' });
    } finally {
      fetch.mockRestore();
    }
  });

  afterAll(() => useService(true, sharedPath));

  it('withholds the name from output, matching, counts, ordering and a repeated kit manufacturer', async () => {
    const owner = await runToolContract(lookupRegistrationTool, { nNumber: 'N7TS' });
    expect(owner.isError, surfaces(owner)).not.toBe(true);
    expect(owner.structuredContent).toMatchObject({
      model: 'JS-1',
      manufacturerModelCode: '056TEST',
    });
    expect(owner.structuredContent).not.toHaveProperty('make');
    expect(owner.structuredContent).not.toHaveProperty('kitManufacturer');
    const otherOwner = await runToolContract(lookupRegistrationTool, { nNumber: 'N9TS' });
    expect(otherOwner.structuredContent).toMatchObject({ kitManufacturer: 'EXAMPLE KIT CO' });
    expect(otherOwner.structuredContent).not.toHaveProperty('make');
    const type = await runToolContract(getAircraftTypeTool, { code: '056TEST' });
    expect(type.structuredContent).toMatchObject({ code: '056TEST', model: 'JS-1' });
    expect(type.structuredContent).not.toHaveProperty('manufacturer');
    const status = await runToolContract(getRegistrationStatusTool, { nNumber: 'N44TS' });
    expect(status.structuredContent).toMatchObject({ recordType: 'deregistered', model: 'JS-1' });
    expect(status.structuredContent).not.toHaveProperty('make');
    const resource = await registrationResource.handler(
      { nNumber: '7TS' },
      createMockContext({ errors: registrationResource.errors }),
    );
    expect(registrationResource.output?.parse(resource)).toMatchObject({ model: 'JS-1' });
    for (const result of [owner, otherOwner, type, status]) {
      expect(surfaces(result)).not.toContain('SMITH');
    }
    expect(JSON.stringify(resource)).not.toContain('SMITH');

    for (const makeModel of ['smith john', 'john a smith']) {
      const hidden = await runToolContract(searchRegistrationsTool, { makeModel });
      expect(hidden.structuredContent).toMatchObject({ totalCount: 0, registrations: [] });
    }
    const hiddenType = await runToolContract(searchAircraftTypesTool, { query: 'smith john' });
    expect(hiddenType.structuredContent).toMatchObject({ totalCount: 0, aircraftTypes: [] });

    for (const input of [{ makeModel: 'js-1' }, { manufacturerModelCode: '056TEST' }]) {
      const found = await runToolContract(searchRegistrationsTool, input);
      expect(found.structuredContent).toMatchObject({
        totalCount: 2,
        registrations: [{ nNumber: '7TS' }, { nNumber: '9TS' }],
      });
      expect(surfaces(found)).not.toContain('SMITH');
    }
    const byModel = await runToolContract(searchAircraftTypesTool, { query: 'js-1' });
    expect(byModel.structuredContent).toMatchObject({
      totalCount: 1,
      aircraftTypes: [{ code: '056TEST' }],
    });
    // By name the two withheld codes sort 056TEST, 056TES3; by model, the reverse.
    const browse = await runToolContract(searchAircraftTypesTool, { aircraftType: '4' });
    expect(browse.structuredContent).toMatchObject({ totalCount: 3 });
    expect(typeCodes(browse).filter((code) => code !== '056TES2')).toEqual(['056TES3', '056TEST']);
    expect(surfaces(browse)).toContain('AAA PUBLIC WORKS');
    for (const result of [byModel, browse]) {
      expect(surfaces(result)).not.toContain('SMITH');
      expect(surfaces(result)).not.toContain('YOUNG');
    }
  });

  it('shows and matches the name with redaction off', async () => {
    await useService(false, builderPath);
    const owner = await runToolContract(lookupRegistrationTool, { nNumber: 'N7TS' });
    expect(owner.structuredContent).toMatchObject({
      make: 'JOHN A SMITH',
      kitManufacturer: 'JOHN A SMITH',
    });
    const byName = await runToolContract(searchRegistrationsTool, { makeModel: 'smith john' });
    expect(byName.structuredContent).toMatchObject({ totalCount: 2 });
    const browse = await runToolContract(searchAircraftTypesTool, { aircraftType: '4' });
    expect(typeCodes(browse)).toEqual(['056TES2', '056TEST', '056TES3']);
    expect(surfaces(browse)).toContain('JOHN A SMITH');
    expect(
      (await runToolContract(searchAircraftTypesTool, { query: 'smith john' })).structuredContent,
    ).toMatchObject({ totalCount: 1 });
  });
});

/**
 * Designator spellings on the wire, over an index of their own: joined and
 * hyphenated forms return the same rows on both surfaces, text with no letter or
 * digit returns an empty page, an expanded designator never matches a withheld
 * builder name, and both searches advertise the spelling-variant limit. The
 * shared fixture service is restored afterwards.
 */
describe('designator spellings on the wire', () => {
  const designatorPath = tempDbPath();
  let sharedPath: string;
  const searches = [
    ['faa_search_registrations', searchRegistrationsTool, 'makeModel', 'registrations', 'nNumber'],
    ['faa_search_aircraft_types', searchAircraftTypesTool, 'query', 'aircraftTypes', 'code'],
  ] as const;

  beforeAll(async () => {
    sharedPath = await currentIndexPath();
    await buildFixtureDb(designatorPath);
    await useService(true, designatorPath);
    const handle = await getRegistryService().mirrorInstance.raw();
    handle.exec(`
      INSERT INTO aircraft_ref (code, mfr, model, builder_cert_code, manufacturer_redacted) VALUES
        ('7101001', 'PIPER', 'PA-28-181', '0', 0),
        ('0560008', 'JOHN SMITH', 'RV-8', '1', 1),
        ('0560009', 'VANS AIRCRAFT', 'RV-8', '1', 0);
      INSERT INTO aircraft_ref_fts (code, mfr, model) VALUES
        ('7101001', 'PIPER', 'PA-28-181'),
        ('0560008', 'JOHN SMITH', 'RV-8'),
        ('0560009', 'VANS AIRCRAFT', 'RV-8');
      INSERT INTO registration (n_number, mfr_mdl_code, make, model) VALUES
        ('281PA', '7101001', 'PIPER', 'PA-28-181'),
        ('8RV', '0560008', 'JOHN SMITH', 'RV-8'),
        ('9RV', '0560009', 'VANS AIRCRAFT', 'RV-8');
    `);
  });

  afterAll(() => useService(true, sharedPath));

  it.each(searches)(
    '%s returns the same rows for PA28 and PA-28',
    async (_, definition, field, key, id) => {
      const joined = await runToolContract(definition, { [field]: 'PA28' });
      const hyphenated = await runToolContract(definition, { [field]: 'PA-28' });
      expect(joined.isError, surfaces(joined)).not.toBe(true);
      expect(joined.structuredContent).toMatchObject({
        totalCount: 1,
        [key]: [{ [id]: key === 'registrations' ? '281PA' : '7101001' }],
      });
      expect(joined.structuredContent).toEqual(hyphenated.structuredContent);
      expect(joined.content).toEqual(hyphenated.content);
      expect(JSON.stringify(joined.content)).toContain('PA-28-181');
    },
  );

  it.each(searches)(
    '%s returns an empty page for text with no letter or digit',
    async (_, definition, field, key) => {
      for (const text of ['-', '- /']) {
        const result = await runToolContract(definition, { [field]: text });
        expect(result.isError, surfaces(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ totalCount: 0, [key]: [] });
        expect(JSON.stringify(result.content)).toContain('No matching');
      }
    },
  );

  it.each(searches)(
    '%s never matches a withheld builder name through an expanded designator',
    async (_, definition, field) => {
      const hidden = await runToolContract(definition, { [field]: 'smith RV8' });
      expect(hidden.structuredContent).toMatchObject({ totalCount: 0 });
      const both = await runToolContract(definition, { [field]: 'RV8' });
      expect(both.structuredContent).toMatchObject({ totalCount: 2 });
      expect(surfaces(both)).toContain('VANS AIRCRAFT');
      expect(surfaces(both)).not.toContain('SMITH');
    },
  );

  it.each(searches)('%s advertises its spelling-variant limit', (_, definition, field) => {
    const schema = z.toJSONSchema(definition.input);
    expect(schema.properties?.[field]).toMatchObject({
      description: expect.stringContaining(`up to ${DESIGNATOR_SPELLING_BUDGET} spelling variants`),
    });
  });
});
