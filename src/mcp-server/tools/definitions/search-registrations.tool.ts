/**
 * @fileoverview faa_search_registrations — search active registrations by owner
 * name, make/model, state, aircraft type, or Mode S code. FTS5 over the bundled
 * index; results are decoded summaries carrying N-numbers for follow-up
 * faa_lookup_registration calls. Owner-name search is disabled when owner-PII
 * redaction is on (so the search input can't be used to confirm a person↔aircraft
 * link). Discloses truncation when the result set hits the limit.
 * @module mcp-server/tools/definitions/search-registrations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { codedValueSchema } from './_schemas.js';

const registrationSummarySchema = z
  .object({
    nNumber: z.string().describe('Normalized N-number without the leading "N".'),
    nNumberDisplay: z.string().describe('N-number with the leading "N" for display.'),
    make: z.string().optional().describe('Aircraft manufacturer name.'),
    model: z.string().optional().describe('Aircraft model name.'),
    yearManufactured: z.number().optional().describe('Year manufactured; often blank.'),
    state: z.string().optional().describe('Registrant state/territory abbreviation.'),
    aircraftType: codedValueSchema.optional().describe('Aircraft type as code + label.'),
    status: codedValueSchema.optional().describe('Registration status as code + label.'),
    modeSCodeHex: z.string().optional().describe('Mode S code in hex (ICAO 24-bit address).'),
    ownerName: z
      .string()
      .optional()
      .describe('Registrant name; present only when owner-PII redaction is off.'),
    ownerRedacted: z.boolean().describe('True when owner name was withheld by the redaction gate.'),
  })
  .describe(
    'A decoded registration summary; use nNumber with faa_lookup_registration for full detail.',
  );

export const searchRegistrationsTool = tool('faa_search_registrations', {
  title: 'faa-aircraft-registry-mcp-server: search registrations',
  description:
    'Search active US civil aircraft registrations by owner name, make/model, state, aircraft type, or Mode S (hex) code. Full-text search over the bundled registry; returns decoded summaries with N-numbers to drill into via faa_lookup_registration. At least one filter is required. Owner-name search is unavailable when this deployment redacts owner PII — search by make/model, state, aircraft type, or Mode S code instead. When the result count hits the limit, the response discloses truncation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    ownerName: z
      .string()
      .optional()
      .describe('Registrant name to match (full-text). Rejected when owner-PII redaction is on.'),
    makeModel: z.string().optional().describe('Aircraft make and/or model to match (full-text).'),
    state: z.string().optional().describe('Two-letter state/territory abbreviation (exact match).'),
    aircraftType: z
      .string()
      .optional()
      .describe('Aircraft type code to match exactly (e.g. "4" for fixed-wing single-engine).'),
    modeSCode: z
      .string()
      .optional()
      .describe('Mode S code in hex to match exactly (ICAO 24-bit address).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(25)
      .describe('Maximum number of results to return (1–200, default 25).'),
  }),

  output: z.object({
    registrations: z
      .array(registrationSummarySchema)
      .describe('Matching registration summaries (up to limit).'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'Present and true only when the result set was capped at the limit — more matches exist.',
      ),
    shown: z.number().optional().describe('Number of results returned (present only when capped).'),
    cap: z.number().optional().describe('The limit that was applied (present only when capped).'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no registrations matched the supplied filters.'),
  },

  errors: [
    {
      reason: 'owner_search_disabled',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'ownerName was supplied while owner-PII redaction is enabled on this deployment.',
      recovery:
        'Drop the ownerName filter — owner-name search is disabled here. Search by makeModel, state, aircraftType, or modeSCode instead.',
    },
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No search filter was supplied.',
      recovery:
        'Provide at least one of makeModel, state, aircraftType, or modeSCode (or ownerName when owner PII is unredacted).',
    },
  ],

  async handler(input, ctx) {
    const service = getRegistryService();

    const ownerName = input.ownerName?.trim() || undefined;
    if (ownerName && !service.ownerSearchEnabled) {
      throw ctx.fail('owner_search_disabled', 'Owner-name search is disabled on this deployment.', {
        ...ctx.recoveryFor('owner_search_disabled'),
      });
    }

    const makeModel = input.makeModel?.trim() || undefined;
    const state = input.state?.trim() || undefined;
    const aircraftType = input.aircraftType?.trim() || undefined;
    const modeSCode = input.modeSCode?.trim() || undefined;

    if (!ownerName && !makeModel && !state && !aircraftType && !modeSCode) {
      throw ctx.fail('no_filters', 'At least one search filter is required.', {
        ...ctx.recoveryFor('no_filters'),
      });
    }

    const page = await service.searchRegistrations(
      {
        ...(ownerName ? { ownerName } : {}),
        ...(makeModel ? { makeModel } : {}),
        ...(state ? { state } : {}),
        ...(aircraftType ? { aircraftType } : {}),
        ...(modeSCode ? { modeSCode } : {}),
        limit: input.limit,
      },
      ctx,
    );

    if (page.items.length === 0) {
      ctx.enrich.notice(
        'No registrations matched the supplied filters. Broaden the make/model terms, verify the state or Mode S code, or remove a filter.',
      );
    }
    if (page.truncated) {
      ctx.enrich.truncated({ shown: page.items.length, cap: page.cap });
    }

    return { registrations: page.items };
  },

  format: (result) => {
    if (result.registrations.length === 0) {
      return [{ type: 'text', text: 'No matching registrations.' }];
    }
    const coded = (v?: { code: string; label?: string | undefined }) =>
      v ? (v.label ? `${v.label} (${v.code})` : v.code) : undefined;
    const lines: string[] = [];
    for (const r of result.registrations) {
      const makeModel = [r.yearManufactured?.toString(), r.make, r.model].filter(Boolean).join(' ');
      lines.push(
        `### ${r.nNumberDisplay} (N-number: ${r.nNumber})${makeModel ? ` — ${makeModel}` : ''}`,
      );
      const facts: string[] = [];
      const type = coded(r.aircraftType);
      if (type) facts.push(`Type: ${type}`);
      const status = coded(r.status);
      if (status) facts.push(`Status: ${status}`);
      if (r.state) facts.push(`State: ${r.state}`);
      if (r.modeSCodeHex) facts.push(`Mode S: ${r.modeSCodeHex}`);
      if (facts.length > 0) lines.push(facts.join(' | '));
      lines.push(`Owner redacted (ownerRedacted): ${r.ownerRedacted ? 'yes' : 'no'}`);
      if (r.ownerName) lines.push(`Owner: ${r.ownerName}`);
      else if (r.ownerRedacted) lines.push('_Owner: redacted on this deployment_');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
