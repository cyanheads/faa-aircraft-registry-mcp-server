/**
 * @fileoverview Tool + resource handler tests — error contracts (not_found,
 * owner_search_disabled, no_filters), success payloads, and the redaction flag on
 * the wire. Drives handlers through the initialized service singleton pointed at a
 * fixture DB.
 * @module tests/tools/tools.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrationResource } from '@/mcp-server/resources/definitions/registration.resource.js';
import { getAircraftTypeTool } from '@/mcp-server/tools/definitions/get-aircraft-type.tool.js';
import { getRegistrationStatusTool } from '@/mcp-server/tools/definitions/get-registration-status.tool.js';
import { lookupRegistrationTool } from '@/mcp-server/tools/definitions/lookup-registration.tool.js';
import { searchRegistrationsTool } from '@/mcp-server/tools/definitions/search-registrations.tool.js';
import { initRegistryService, resetRegistryService } from '@/services/registry/registry-service.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';

/** A mock context carrying a tool's own error contract so `ctx.fail` is typed/wired. */
const lookupCtx = createMockContext({ errors: lookupRegistrationTool.errors });
const searchCtx = createMockContext({ errors: searchRegistrationsTool.errors });
const aircraftTypeCtx = createMockContext({ errors: getAircraftTypeTool.errors });
const statusCtx = createMockContext();
const resourceCtx = createMockContext({ errors: registrationResource.errors });

/** Point the service singleton at a fresh fixture DB with the given redaction mode. */
async function initService(redactOwnerPii: boolean): Promise<void> {
  resetRegistryService();
  const path = tempDbPath();
  await buildFixtureDb(path);
  initRegistryService({
    redactOwnerPii,
    mirrorPath: path,
    databaseUrl: 'https://example.invalid/never-downloaded.zip',
  });
}

describe('faa_lookup_registration', () => {
  beforeAll(() => initService(false));
  afterAll(() => resetRegistryService());

  it('returns a decoded record for a known N-number', async () => {
    const out = await lookupRegistrationTool.handler({ nNumber: 'N12345' }, lookupCtx);
    expect(out.make).toBe('CESSNA');
    expect(out.owner?.name).toBe('JOHN Q PUBLIC');
    const content = lookupRegistrationTool.format?.(out) ?? [];
    expect(content[0]?.type).toBe('text');
  });

  it('throws not_found (NotFound) for an unknown N-number', async () => {
    await expect(
      lookupRegistrationTool.handler({ nNumber: 'N00000' }, lookupCtx),
    ).rejects.toBeInstanceOf(McpError);
    await expect(
      lookupRegistrationTool.handler({ nNumber: 'N00000' }, lookupCtx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });
});

describe('faa_search_registrations — redaction-gated owner search', () => {
  it('throws owner_search_disabled when redaction is ON and ownerName is supplied', async () => {
    await initService(true);
    await expect(
      searchRegistrationsTool.handler({ ownerName: 'JOHN Q PUBLIC', limit: 25 }, searchCtx),
    ).rejects.toMatchObject({ data: { reason: 'owner_search_disabled' } });
  });

  it('allows owner search when redaction is OFF', async () => {
    await initService(false);
    const out = await searchRegistrationsTool.handler(
      { ownerName: 'public', limit: 25 },
      searchCtx,
    );
    expect(out.registrations.some((r) => r.nNumber === '12345')).toBe(true);
  });

  it('throws no_filters when no filter is supplied', async () => {
    await initService(true);
    await expect(searchRegistrationsTool.handler({ limit: 25 }, searchCtx)).rejects.toMatchObject({
      data: { reason: 'no_filters' },
    });
  });
});

/**
 * The effective output a client receives is `output.extend(enrichment-shape)`,
 * parsed by the framework. A non-truncated result must satisfy it — the original
 * bug declared truncated/shown/cap as required but only populated them when the
 * cap was hit, so every under-cap result (the common case) failed the parse with
 * a SerializationError. Direct `.handler()` calls bypass that parse, so we
 * reconstruct it here from `output` + the accumulated enrichment.
 */
describe('faa_search_registrations — enrichment / effective-output parity', () => {
  const effectiveSchema = searchRegistrationsTool.output.extend(
    searchRegistrationsTool.enrichment ?? {},
  );

  it('produces effective output that parses when the result set is NOT truncated', async () => {
    await initService(true);
    const enrichCtx = createMockContext({
      errors: searchRegistrationsTool.errors,
      enrichment: searchRegistrationsTool.enrichment,
    });
    const out = await searchRegistrationsTool.handler(
      { makeModel: 'cessna', limit: 25 },
      enrichCtx,
    );
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    // Truncation fields stay absent (optional) when the cap was not hit.
    expect(effective).not.toHaveProperty('truncated');
  });

  it('produces effective output that parses on an empty result (notice only)', async () => {
    await initService(true);
    const enrichCtx = createMockContext({
      errors: searchRegistrationsTool.errors,
      enrichment: searchRegistrationsTool.enrichment,
    });
    const out = await searchRegistrationsTool.handler(
      { makeModel: 'zzzznotarealmake', limit: 25 },
      enrichCtx,
    );
    expect(out.registrations).toHaveLength(0);
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).toHaveProperty('notice');
  });

  it('populates truncated/shown/cap when the cap IS hit', async () => {
    await initService(true);
    const enrichCtx = createMockContext({
      errors: searchRegistrationsTool.errors,
      enrichment: searchRegistrationsTool.enrichment,
    });
    await searchRegistrationsTool.handler({ makeModel: 'cessna', limit: 1 }, enrichCtx);
    const enrichment = getEnrichment(enrichCtx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 1, cap: 1 });
  });
});

describe('faa_get_aircraft_type', () => {
  beforeAll(() => initService(true));
  afterAll(() => resetRegistryService());

  it('throws not_found for an unknown code', async () => {
    await expect(
      getAircraftTypeTool.handler({ code: '0000000' }, aircraftTypeCtx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });
});

describe('faa_get_registration_status — flat discriminated output', () => {
  beforeAll(() => initService(true));
  afterAll(() => resetRegistryService());

  it('returns recordType for each file and renders content', async () => {
    const active = await getRegistrationStatusTool.handler({ nNumber: '12345' }, statusCtx);
    expect(active.recordType).toBe('active');
    const dereg = await getRegistrationStatusTool.handler({ nNumber: '404ER' }, statusCtx);
    expect(dereg.recordType).toBe('deregistered');
    const reserved = await getRegistrationStatusTool.handler({ nNumber: '777RZ' }, statusCtx);
    expect(reserved.recordType).toBe('reserved');
    const unknown = await getRegistrationStatusTool.handler({ nNumber: '00000' }, statusCtx);
    expect(unknown.recordType).toBe('unknown');
    expect(getRegistrationStatusTool.format?.(reserved)[0]?.type).toBe('text');
  });
});

describe('faa://registration/{nNumber} resource', () => {
  beforeAll(() => initService(true));
  afterAll(() => resetRegistryService());

  it('returns the redacted record for a known N-number', async () => {
    const out = await registrationResource.handler(
      { nNumber: 'N12345' },
      { ...resourceCtx, uri: new URL('faa://registration/N12345') },
    );
    expect(out.ownerRedacted).toBe(true);
    expect(out.owner).toBeUndefined();
    expect(out.make).toBe('CESSNA');
  });

  it('throws not_found for an unknown N-number', async () => {
    await expect(
      registrationResource.handler(
        { nNumber: 'N00000' },
        { ...resourceCtx, uri: new URL('faa://registration/N00000') },
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });
});
