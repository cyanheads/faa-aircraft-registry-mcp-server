/**
 * @fileoverview SDK v2 shared-wire contract coverage for every FAA registry
 * tool: strict root inputs, production-shaped success output, and dual-surface
 * error envelopes used by 2026-07-28 and initialize-negotiated 2025 clients.
 * @module tests/integration/tool-contracts.int.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
