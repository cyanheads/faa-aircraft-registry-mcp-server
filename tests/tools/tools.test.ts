/**
 * @fileoverview Tool + resource handler tests — error contracts (not_found,
 * owner_search_disabled, no_filters), success payloads, and the redaction flag on
 * the wire. Drives handlers through the initialized service singleton pointed at a
 * fixture DB.
 * @module tests/tools/tools.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrationResource } from '@/mcp-server/resources/definitions/registration.resource.js';
import { getAircraftTypeTool } from '@/mcp-server/tools/definitions/get-aircraft-type.tool.js';
import { getRegistrationStatusTool } from '@/mcp-server/tools/definitions/get-registration-status.tool.js';
import { lookupRegistrationTool } from '@/mcp-server/tools/definitions/lookup-registration.tool.js';
import { searchAircraftTypesTool } from '@/mcp-server/tools/definitions/search-aircraft-types.tool.js';
import { searchRegistrationsTool } from '@/mcp-server/tools/definitions/search-registrations.tool.js';
import { initRegistryService, resetRegistryService } from '@/services/registry/registry-service.js';
import { buildFixtureDb, tempDbPath } from '../fixtures/build-fixture-db.js';

/** A mock context carrying a tool's own error contract so `ctx.fail` is typed/wired. */
const lookupCtx = createMockContext({ errors: lookupRegistrationTool.errors });
const searchCtx = createMockContext({ errors: searchRegistrationsTool.errors });
const aircraftTypeCtx = createMockContext({ errors: getAircraftTypeTool.errors });
const statusCtx = createMockContext({ errors: getRegistrationStatusTool.errors });
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

  it('throws not_found (NotFound) for a well-formed but unknown N-number', async () => {
    // N99999 is shape-valid but absent; a malformed number now fails validation first.
    await expect(
      lookupRegistrationTool.handler({ nNumber: 'N99999' }, lookupCtx),
    ).rejects.toBeInstanceOf(McpError);
    await expect(
      lookupRegistrationTool.handler({ nNumber: 'N99999' }, lookupCtx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws invalid_n_number (ValidationError) for a malformed N-number', async () => {
    await expect(
      lookupRegistrationTool.handler({ nNumber: 'BANANA' }, lookupCtx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_n_number' } });
  });

  it('carries the declared recovery hint for a malformed N-number on the wire', async () => {
    const result = await runToolContract(lookupRegistrationTool, { nNumber: 'BANANA' });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: Record<string, unknown> }).error;
    expect(error.data).toMatchObject({
      reason: 'invalid_n_number',
      recovery: { hint: expect.stringContaining('N172SP') },
    });
  });

  it('omits a year_mfr = 0 from the record and the formatted headline', async () => {
    const out = await lookupRegistrationTool.handler({ nNumber: 'N105HH' }, lookupCtx);
    expect(out.yearManufactured).toBeUndefined();
    const content = lookupRegistrationTool.format?.(out)[0];
    const text = content?.type === 'text' ? content.text : '';
    // Headline must read "HILLER UH-12D", never "0 HILLER UH-12D".
    expect(text).toContain('HILLER UH-12D');
    expect(text).not.toContain('0 HILLER');
  });
});

/**
 * The resolved redaction flag has to reach BOTH client surfaces — a client
 * reading `content[]` (Claude Desktop) must be told the owner block is withheld
 * rather than silently see a record with no owner. `server-config.test.ts`
 * covers how the flag itself resolves; this covers what the caller then sees.
 */
describe('owner-PII redaction — format() surface', () => {
  afterAll(() => resetRegistryService());

  const renderedRecord = async (): Promise<string> => {
    const out = await lookupRegistrationTool.handler({ nNumber: 'N12345' }, lookupCtx);
    const block = lookupRegistrationTool.format?.(out)[0];
    return block?.type === 'text' ? block.text : '';
  };

  it('states that the owner block is withheld and prints no PII when redaction is ON', async () => {
    await initService(true);
    const text = await renderedRecord();
    expect(text).toContain('ownerRedacted=true');
    expect(text).toContain('withheld');
    expect(text).not.toContain('JOHN Q PUBLIC');
    expect(text).not.toContain('123 RUNWAY RD');
  });

  it('prints the registrant block when redaction is OFF', async () => {
    await initService(false);
    const text = await renderedRecord();
    expect(text).toContain('ownerRedacted=false');
    expect(text).toContain('JOHN Q PUBLIC');
  });
});

describe('faa_search_registrations — redaction-gated owner search', () => {
  it('throws owner_search_disabled when redaction is ON and ownerName is supplied', async () => {
    await initService(true);
    await expect(
      searchRegistrationsTool.handler(
        { ownerName: 'JOHN Q PUBLIC', limit: 25, offset: 0 },
        searchCtx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'owner_search_disabled' } });
  });

  it('allows owner search when redaction is OFF', async () => {
    await initService(false);
    const out = await searchRegistrationsTool.handler(
      { ownerName: 'public', limit: 25, offset: 0 },
      searchCtx,
    );
    expect(out.registrations.some((r) => r.nNumber === '12345')).toBe(true);
  });

  it('throws no_filters when no filter is supplied', async () => {
    await initService(true);
    await expect(
      searchRegistrationsTool.handler({ limit: 25, offset: 0 }, searchCtx),
    ).rejects.toMatchObject({
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

  /** A fresh enrichment-collecting context for the search tool. */
  const freshCtx = () =>
    createMockContext({
      errors: searchRegistrationsTool.errors,
    });

  it('produces effective output that parses when the result set is NOT truncated', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchRegistrationsTool.handler(
      { makeModel: 'cessna', limit: 25, offset: 0 },
      enrichCtx,
    );
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    // Truncation fields stay absent (optional) when the cap was not hit.
    expect(effective).not.toHaveProperty('truncated');
    // nextOffset is optional and must stay absent when no page follows.
    expect(effective).not.toHaveProperty('nextOffset');
    // totalCount is required — it must be present even here.
    expect(effective).toMatchObject({ totalCount: 2 });
  });

  it('produces effective output that parses on an empty result (notice only)', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchRegistrationsTool.handler(
      { makeModel: 'zzzznotarealmake', limit: 25, offset: 0 },
      enrichCtx,
    );
    expect(out.registrations).toHaveLength(0);
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    // The required totalCount must survive the zero-result path — the failure
    // mode this describe block exists to catch.
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).toHaveProperty('notice');
    expect(effective).toMatchObject({ totalCount: 0 });
  });

  it('populates truncated/shown/cap and nextOffset when the cap IS hit', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchRegistrationsTool.handler(
      { makeModel: 'cessna', limit: 1, offset: 0 },
      enrichCtx,
    );
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).toMatchObject({
      truncated: true,
      shown: 1,
      cap: 1,
      totalCount: 2,
      nextOffset: 1,
    });
  });

  /**
   * The truncation notice is guidance the agent will act on literally, so it
   * must name the offset that actually retrieves the next page — not advise
   * raising a limit that may already be at its maximum.
   */
  it('points the truncation notice at the next-page offset, and that offset works', async () => {
    await initService(true);
    const firstCtx = freshCtx();
    const first = await searchRegistrationsTool.handler(
      { makeModel: 'cessna', limit: 1, offset: 0 },
      firstCtx,
    );
    const enrichment = getEnrichment(firstCtx);
    expect(enrichment.notice).toContain('offset: 1');
    expect(enrichment.notice).not.toMatch(/raise the cap/i);

    // Follow the emitted guidance literally: it must return a new row.
    const secondCtx = freshCtx();
    const second = await searchRegistrationsTool.handler(
      { makeModel: 'cessna', limit: 1, offset: enrichment.nextOffset as number },
      secondCtx,
    );
    expect(second.registrations).toHaveLength(1);
    expect(second.registrations[0]?.nNumber).not.toBe(first.registrations[0]?.nNumber);
    // End of the set — no further page advertised.
    expect(getEnrichment(secondCtx)).not.toHaveProperty('nextOffset');
  });

  it('reports the real total, not the page size, when offset runs past the end', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchRegistrationsTool.handler(
      { makeModel: 'cessna', limit: 25, offset: 99 },
      enrichCtx,
    );
    expect(out.registrations).toHaveLength(0);
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).toMatchObject({ totalCount: 2 });
    // The empty-result notice must not claim nothing matched when 2 rows do.
    expect(getEnrichment(enrichCtx)).toMatchObject({
      notice: expect.stringContaining('past the end'),
    });
  });
});

/**
 * faa_search_aircraft_types has the same required-totalCount enrichment contract
 * as faa_search_registrations, so it carries the same SerializationError risk: a
 * required enrichment field that isn't populated on every success path fails the
 * effective-output parse. This mirrors the search-registrations parity block for
 * the aircraft-types surface, which had no tool-level guard.
 */
describe('faa_search_aircraft_types — enrichment / effective-output parity', () => {
  const effectiveSchema = searchAircraftTypesTool.output.extend(
    searchAircraftTypesTool.enrichment ?? {},
  );

  const freshCtx = () =>
    createMockContext({
      errors: searchAircraftTypesTool.errors,
    });

  it('produces effective output that parses when the result set is NOT truncated', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchAircraftTypesTool.handler(
      { query: 'cessna', limit: 25, offset: 0 },
      enrichCtx,
    );
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).not.toHaveProperty('truncated');
    expect(effective).not.toHaveProperty('nextOffset');
    // totalCount is required — it must survive the common under-cap path.
    expect(effective).toMatchObject({ totalCount: 3 });
  });

  it('produces effective output that parses on an empty result (notice only)', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchAircraftTypesTool.handler(
      { query: 'zzzznotarealmodel', limit: 25, offset: 0 },
      enrichCtx,
    );
    expect(out.aircraftTypes).toHaveLength(0);
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    // The required totalCount must survive the zero-result path — the SerializationError guard.
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).toHaveProperty('notice');
    expect(effective).toMatchObject({ totalCount: 0 });
  });

  it('populates truncated/shown/cap and nextOffset when the cap IS hit', async () => {
    await initService(true);
    const enrichCtx = freshCtx();
    const out = await searchAircraftTypesTool.handler(
      { query: 'cessna', limit: 1, offset: 0 },
      enrichCtx,
    );
    const effective = { ...out, ...getEnrichment(enrichCtx) };
    expect(() => effectiveSchema.parse(effective)).not.toThrow();
    expect(effective).toMatchObject({
      truncated: true,
      shown: 1,
      cap: 1,
      totalCount: 3,
      nextOffset: 1,
    });
  });
});

describe('faa_get_aircraft_type', () => {
  beforeAll(() => initService(true));
  afterAll(() => resetRegistryService());

  it('throws not_found for a well-formed but unknown code', async () => {
    // 0000000 is shape-valid (leading 0 is legitimate for aircraft codes) but absent.
    await expect(
      getAircraftTypeTool.handler({ code: '0000000' }, aircraftTypeCtx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('throws invalid_code for a malformed code', async () => {
    await expect(
      getAircraftTypeTool.handler({ code: 'ABC' }, aircraftTypeCtx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_code' } });
  });

  it('omits zero-sentinel cruise/seats from output and text, keeping a real engine count', async () => {
    const out = await getAircraftTypeTool.handler({ code: '1370737' }, aircraftTypeCtx);
    expect(out.numberOfEngines).toBe(2);
    expect(out.cruiseSpeedMph).toBeUndefined();
    expect(out.numberOfSeats).toBeUndefined();
    const content = getAircraftTypeTool.format?.(out)[0];
    const text = content?.type === 'text' ? content.text : '';
    expect(text).toContain('**Engines:** 2');
    expect(text).not.toContain('Cruise speed');
    expect(text).not.toContain('Seats:');
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
    // 99999 is shape-valid but never issued → unknown (00000 is now a validation error).
    const unknown = await getRegistrationStatusTool.handler({ nNumber: '99999' }, statusCtx);
    expect(unknown.recordType).toBe('unknown');
    expect(getRegistrationStatusTool.format?.(reserved)[0]?.type).toBe('text');
  });

  it('throws invalid_n_number for a malformed number instead of a silent unknown', async () => {
    await expect(
      getRegistrationStatusTool.handler({ nNumber: 'BANANA' }, statusCtx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_n_number' } });
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

  it('throws not_found for a well-formed but unknown N-number', async () => {
    await expect(
      registrationResource.handler(
        { nNumber: 'N99999' },
        { ...resourceCtx, uri: new URL('faa://registration/N99999') },
      ),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  it('throws invalid_n_number for a malformed N-number', async () => {
    await expect(
      registrationResource.handler(
        { nNumber: 'BANANA' },
        { ...resourceCtx, uri: new URL('faa://registration/BANANA') },
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_n_number' } });
  });
});
