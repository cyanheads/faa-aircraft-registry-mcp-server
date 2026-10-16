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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrationResource } from '@/mcp-server/resources/definitions/registration.resource.js';
import { formatRegistrationRecord } from '@/mcp-server/tools/definitions/_schemas.js';
import { getAircraftTypeTool } from '@/mcp-server/tools/definitions/get-aircraft-type.tool.js';
import { getRegistrationStatusTool } from '@/mcp-server/tools/definitions/get-registration-status.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { lookupRegistrationTool } from '@/mcp-server/tools/definitions/lookup-registration.tool.js';
import { searchAircraftTypesTool } from '@/mcp-server/tools/definitions/search-aircraft-types.tool.js';
import { searchRegistrationsTool } from '@/mcp-server/tools/definitions/search-registrations.tool.js';
import {
  getRegistryService,
  initRegistryService,
  resetRegistryService,
} from '@/services/registry/registry-service.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';

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
        manufacturer: 'DOGGETT JOHN ROY',
        model: 'JRD VP-II',
      });
      expect(JSON.stringify(result.content)).toContain('056387');
      expect(JSON.stringify(result.content)).toContain('JRD VP-II');
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
