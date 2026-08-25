/**
 * @fileoverview SDK v2 shared-wire contract coverage for every FAA registry
 * tool: strict root inputs, production-shaped success output, and dual-surface
 * error envelopes used by 2026-07-28 and initialize-negotiated 2025 clients.
 * @module tests/integration/tool-contracts.int.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
