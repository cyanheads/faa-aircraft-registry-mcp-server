/**
 * @fileoverview faa_search_registrations — search active registrations by owner
 * name, make/model, exact manufacturer/model code, state, aircraft type, or Mode S code. FTS5 over the local
 * on-disk index; results are decoded summaries carrying N-numbers for follow-up
 * faa_lookup_registration calls. Free-text terms are column-scoped, so makeModel
 * matches make/model only and never owner or city. Owner-name search is disabled
 * when owner-PII redaction is on (so the search input can't be used to confirm a
 * person↔aircraft link). Discloses the total match count and pages via offset.
 * @module mcp-server/tools/definitions/search-registrations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { mirrorLoadingError } from '../../_mirror-errors.js';
import { codedValueSchema } from './_schemas.js';
import {
  applySearchLimit,
  enrichSearchPage,
  searchEnrichment,
  searchLimitSchema,
} from './_search-page.js';

const registrationSummarySchema = z
  .object({
    nNumber: z.string().describe('Normalized N-number without the leading "N".'),
    nNumberDisplay: z.string().describe('N-number with the leading "N" for display.'),
    serialNumber: z
      .string()
      .optional()
      .describe('Manufacturer serial number as stored by the FAA.'),
    make: z.string().optional().describe('Aircraft manufacturer name.'),
    manufacturerModelCode: z
      .string()
      .optional()
      .describe(
        'FAA manufacturer/model/series code (6–7 characters); use with faa_get_aircraft_type for specs or manufacturerModelCode to find registrations of the same type.',
      ),
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
    'Search active US civil aircraft registrations by owner name, make/model, exact manufacturerModelCode, serial number, state, aircraft type, or Mode S (hex) code. Discover codes with faa_search_aircraft_types and get full records with faa_lookup_registration. Filters are AND-combined and at least one is required. Owner-name search is available on deployments that expose owner PII. Responses report totalCount across all pages and return nextOffset when more matches remain.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    ownerName: z
      .string()
      .optional()
      .describe('Registrant name to match (full-text). Rejected when owner-PII redaction is on.'),
    makeModel: z
      .string()
      .optional()
      .describe(
        'Aircraft make or model. Each search term matches a token prefix, such as 172 matching 172S.',
      ),
    serialNumber: z
      .string()
      .optional()
      .describe(
        'Exact manufacturer serial number, trimmed and matched case-insensitively. Leading zeros, punctuation, and internal spaces are significant. Blank is unset. Use manufacturerModelCode or makeModel to narrow duplicate serials.',
      ),
    manufacturerModelCode: z
      .string()
      .optional()
      .describe(
        'Exact FAA manufacturer/model/series code: 6–7 alphanumeric characters, trimmed and uppercased; blank is unset. Discover codes with faa_search_aircraft_types. AND-combined with other filters.',
      ),
    state: z
      .string()
      .optional()
      .describe(
        'Two ASCII letters for a state, territory or military postal code (e.g. WA, GU, AE, AP; exact match). Trimmed and uppercased; blank is unset.',
      ),
    aircraftType: z
      .string()
      .optional()
      .describe(
        'FAA aircraft type code: 1–9, H (Hybrid Lift), O (Other), exact match. Trimmed and uppercased; blank is unset.',
      ),
    modeSCode: z
      .string()
      .optional()
      .describe(
        'Six hexadecimal characters for the Mode S code (ICAO 24-bit address), exact match. Trimmed and uppercased; blank is unset.',
      ),
    limit: searchLimitSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first result to return — pass the nextOffset from a previous response, with identical filters, to page forward (default 0).',
      ),
  }),

  output: z.object({
    registrations: z
      .array(registrationSummarySchema)
      .describe('Matching registration summaries for this page (up to limit).'),
  }),

  enrichment: searchEnrichment,

  errors: [
    mirrorLoadingError,
    {
      reason: 'invalid_code',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'manufacturerModelCode is not 6–7 alphanumeric characters after normalization.',
      recovery:
        'Use faa_search_aircraft_types to discover a 6–7-character manufacturer/model/series code, then pass it as manufacturerModelCode.',
    },
    {
      reason: 'invalid_state',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'state is not two ASCII letters.',
      recovery:
        'Provide a two-letter state, territory or military postal code such as WA, GU, AE or AP.',
    },
    {
      reason: 'invalid_mode_s_code',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'modeSCode is not six hexadecimal characters.',
      recovery: 'Provide a six-character hexadecimal Mode S code such as A4E2D9.',
    },
    {
      reason: 'invalid_aircraft_type',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'aircraftType is not 1–9, H or O.',
      recovery: 'Provide aircraftType as 1–9, H (Hybrid Lift) or O (Other).',
    },
    {
      reason: 'owner_search_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ownerName was supplied while owner-PII redaction is enabled on this deployment.',
      recovery:
        'Drop the ownerName filter. Search by makeModel, manufacturerModelCode, serialNumber, state, aircraftType, or modeSCode.',
    },
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No search filter was supplied.',
      recovery:
        'Provide at least one of makeModel, manufacturerModelCode, serialNumber, state, aircraftType, or modeSCode (or ownerName when owner PII is unredacted).',
    },
  ],

  async handler(input, ctx) {
    const service = getRegistryService();

    const ownerName = input.ownerName?.trim() || undefined;
    if (ownerName && !service.ownerSearchEnabled) {
      throw ctx.fail('owner_search_disabled', 'Owner-name search is disabled on this deployment.');
    }

    const makeModel = input.makeModel?.trim() || undefined;
    const manufacturerModelCode = input.manufacturerModelCode?.trim() || undefined;
    const serialNumber = input.serialNumber?.trim() || undefined;
    const state = input.state?.trim() || undefined;
    const aircraftType = input.aircraftType?.trim() || undefined;
    const modeSCode = input.modeSCode?.trim() || undefined;

    if (
      !ownerName &&
      !makeModel &&
      !manufacturerModelCode &&
      !serialNumber &&
      !state &&
      !aircraftType &&
      !modeSCode
    ) {
      throw ctx.fail('no_filters', 'At least one search filter is required.');
    }

    const { limit, notice } = applySearchLimit(ctx, 'faa_search_registrations', input.limit);
    let dataAsOf: string | undefined;
    const page = await service.searchRegistrations(
      {
        ...(ownerName ? { ownerName } : {}),
        ...(makeModel ? { makeModel } : {}),
        ...(manufacturerModelCode ? { manufacturerModelCode } : {}),
        ...(serialNumber ? { serialNumber } : {}),
        ...(state ? { state } : {}),
        ...(aircraftType ? { aircraftType } : {}),
        ...(modeSCode ? { modeSCode } : {}),
        limit,
        offset: input.offset,
      },
      ctx,
      (snapshot) => {
        dataAsOf = snapshot.dataAsOf;
      },
    );

    enrichSearchPage(
      ctx,
      'faa_search_registrations',
      page,
      input.offset,
      dataAsOf,
      notice,
      'No registrations matched the supplied filters. Broaden the make/model terms, discover manufacturerModelCode with faa_search_aircraft_types, verify the state or Mode S code, or remove a filter.',
    );

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
        `### ${escapeMarkdownInline(r.nNumberDisplay)} (N-number: ${escapeMarkdownInline(r.nNumber)})${makeModel ? ` — ${escapeMarkdownInline(makeModel)}` : ''}`,
      );
      const facts: string[] = [];
      if (r.serialNumber) facts.push(`Serial: ${escapeMarkdownInline(r.serialNumber)}`);
      if (r.manufacturerModelCode)
        facts.push(`Mfr/model code: ${escapeMarkdownInline(r.manufacturerModelCode)}`);
      const type = coded(r.aircraftType);
      if (type) facts.push(`Type: ${escapeMarkdownInline(type)}`);
      const status = coded(r.status);
      if (status) facts.push(`Status: ${escapeMarkdownInline(status)}`);
      if (r.state) facts.push(`State: ${escapeMarkdownInline(r.state)}`);
      if (r.modeSCodeHex) facts.push(`Mode S: ${escapeMarkdownInline(r.modeSCodeHex)}`);
      if (facts.length > 0) lines.push(facts.join(' | '));
      lines.push(`Owner redacted (ownerRedacted): ${r.ownerRedacted ? 'yes' : 'no'}`);
      if (r.ownerName) lines.push(`Owner: ${escapeMarkdownInline(r.ownerName)}`);
      else if (r.ownerRedacted) lines.push('_Owner: redacted on this deployment_');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
