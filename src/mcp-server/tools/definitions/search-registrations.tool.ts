/**
 * @fileoverview faa_search_registrations — search active registrations by owner
 * name, make/model, exact manufacturer/model or engine code, serial number,
 * state, aircraft type, airworthiness class, manufacture year, or Mode S code. FTS5 over the local
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
import { decodeModeSCode } from '@/services/registry/mode-s.js';
import {
  DESIGNATOR_SPELLING_BUDGET,
  displayNNumber,
  normalizeExactFilter,
} from '@/services/registry/normalize.js';
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
    engineManufacturerModelCode: z
      .string()
      .optional()
      .describe(
        'FAA engine manufacturer/model code (five digits); pass it as engineManufacturerModelCode to find registrations with the same engine.',
      ),
    airworthinessClass: codedValueSchema
      .optional()
      .describe('Airworthiness class (Standard, Experimental, …) as code + label.'),
    ownerName: z
      .string()
      .optional()
      .describe('Registrant name; present only when owner-PII redaction is off.'),
    ownerRedacted: z.boolean().describe('True when owner name was withheld by the redaction gate.'),
  })
  .describe(
    'A decoded registration summary; use nNumber with faa_lookup_registration for full detail.',
  );

/**
 * The sentence an unmatched Mode S search adds to its notice, and the N-number
 * the code encodes when it encodes one. It states only the address mapping, so
 * it stays true whichever filter emptied the page.
 */
function describeUnmatchedModeS(code: string): { sentence: string; encodedNNumber?: string } {
  const decoded = decodeModeSCode(code);
  switch (decoded.kind) {
    case 'n_number': {
      const nNumber = displayNNumber(decoded.nNumber);
      return {
        sentence: `Mode S code ${code} encodes ${nNumber}. Call faa_get_registration_status with ${nNumber} for its current state and cancellation history.`,
        encodedNNumber: nNumber,
      };
    }
    case 'us_unmapped':
      return {
        sentence: `Mode S code ${code} is in the US allocation (A00000–AFFFFF) but encodes no N-number.`,
      };
    case 'non_us':
      return {
        sentence: `Mode S code ${code} is outside the US allocation (A00000–AFFFFF) and encodes no N-number.`,
      };
  }
}

export const searchRegistrationsTool = tool('faa_search_registrations', {
  title: 'faa-aircraft-registry-mcp-server: search registrations',
  description:
    'Search active US civil aircraft registrations by owner name, make/model, exact manufacturerModelCode or engineManufacturerModelCode, serial number, state, aircraft type, airworthiness class, manufacture-year range, or Mode S (hex) code. Discover codes with faa_search_aircraft_types and get full records with faa_lookup_registration. Filters are AND-combined and at least one is required. Owner-name search is available on deployments that expose owner PII. Responses report totalCount across all pages and return nextOffset when more matches remain.',
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
        `Aircraft make or model. Each search term matches a token prefix, such as 172 matching 172S, and hyphenated and joined designators match each other, such as PA28 and PA-28. A search adds up to ${DESIGNATOR_SPELLING_BUDGET} spelling variants, in term order; a term whose variants exceed what remains matches as typed.`,
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
        'Six hexadecimal characters for the Mode S code (ICAO 24-bit address), exact match. Trimmed and uppercased; blank is unset. When nothing matches, the notice says which N-number a US address encodes and encodedNNumber carries it for faa_get_registration_status.',
      ),
    engineManufacturerModelCode: z
      .string()
      .optional()
      .describe(
        'Exact FAA engine manufacturer/model code: five digits such as 17026, trimmed; blank is unset. Leading zeros are significant. Take it from faa_lookup_registration or a search result.',
      ),
    airworthinessClass: z
      .string()
      .optional()
      .describe(
        'FAA airworthiness class code, exact match: 1 Standard, 2 Limited, 3 Restricted, 4 Experimental, 5 Provisional, 6 Multiple, 7 Primary, 8 Special Flight Permit, 9 Light Sport. Trimmed; blank is unset.',
      ),
    yearManufacturedMin: z
      .number()
      .int()
      .min(1000)
      .max(9999)
      .optional()
      .describe(
        'Earliest year manufactured, inclusive (four-digit year). Registrations with no recorded year never match.',
      ),
    yearManufacturedMax: z
      .number()
      .int()
      .min(1000)
      .max(9999)
      .optional()
      .describe(
        'Latest year manufactured, inclusive (four-digit year). Registrations with no recorded year never match.',
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

  enrichment: {
    ...searchEnrichment,
    encodedNNumber: z
      .string()
      .optional()
      .describe(
        'N-number the searched modeSCode encodes, such as N399WM. Present only when nothing matched and the code is a US address from A00001 to ADF7C7; check it with faa_get_registration_status.',
      ),
  },

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
      reason: 'invalid_engine_code',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'engineManufacturerModelCode is not five digits after trimming.',
      recovery:
        'Pass the five-digit engineManufacturerModelCode, such as 17026, from faa_lookup_registration or a search result, not an engine model name.',
    },
    {
      reason: 'invalid_airworthiness_class',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'airworthinessClass is not one digit from 1 to 9.',
      recovery:
        'Provide airworthinessClass as 1 Standard, 2 Limited, 3 Restricted, 4 Experimental, 5 Provisional, 6 Multiple, 7 Primary, 8 Special Flight Permit, or 9 Light Sport.',
    },
    {
      reason: 'invalid_year_range',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'yearManufacturedMin is later than yearManufacturedMax.',
      recovery:
        'Set yearManufacturedMin no later than yearManufacturedMax, or pass only one of the two bounds.',
    },
    {
      reason: 'owner_search_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'ownerName was supplied while owner-PII redaction is enabled on this deployment.',
      recovery:
        'Drop the ownerName filter. Search by makeModel, manufacturerModelCode, engineManufacturerModelCode, serialNumber, state, aircraftType, airworthinessClass, yearManufacturedMin, yearManufacturedMax, or modeSCode.',
    },
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No search filter was supplied.',
      recovery:
        'Provide at least one of makeModel, manufacturerModelCode, engineManufacturerModelCode, serialNumber, state, aircraftType, airworthinessClass, yearManufacturedMin, yearManufacturedMax, or modeSCode (or ownerName when owner PII is unredacted).',
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
    const engineManufacturerModelCode = input.engineManufacturerModelCode?.trim() || undefined;
    const airworthinessClass = input.airworthinessClass?.trim() || undefined;
    const { yearManufacturedMin, yearManufacturedMax } = input;

    if (
      !ownerName &&
      !makeModel &&
      !manufacturerModelCode &&
      !serialNumber &&
      !state &&
      !aircraftType &&
      !modeSCode &&
      !engineManufacturerModelCode &&
      !airworthinessClass &&
      yearManufacturedMin === undefined &&
      yearManufacturedMax === undefined
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
        ...(engineManufacturerModelCode ? { engineManufacturerModelCode } : {}),
        ...(airworthinessClass ? { airworthinessClass } : {}),
        ...(yearManufacturedMin !== undefined ? { yearManufacturedMin } : {}),
        ...(yearManufacturedMax !== undefined ? { yearManufacturedMax } : {}),
        limit,
        offset: input.offset,
      },
      ctx,
      (snapshot) => {
        dataAsOf = snapshot.dataAsOf;
      },
    );

    const noMatches =
      'No registrations matched the supplied filters. Broaden the make/model terms, discover manufacturerModelCode with faa_search_aircraft_types, verify the state or Mode S code, or remove a filter.';
    // The search already validated modeSCode; normalizing again yields the uppercase form.
    const unmatchedModeS =
      page.totalCount === 0 ? normalizeExactFilter(modeSCode, 'modeSCode') : undefined;
    const modeS = unmatchedModeS ? describeUnmatchedModeS(unmatchedModeS) : undefined;
    enrichSearchPage(
      ctx,
      'faa_search_registrations',
      page,
      input.offset,
      dataAsOf,
      notice,
      modeS ? `${noMatches} ${modeS.sentence}` : noMatches,
    );
    if (modeS?.encodedNNumber) ctx.enrich({ encodedNNumber: modeS.encodedNNumber });

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
      if (r.engineManufacturerModelCode)
        facts.push(`Engine mfr/model code: ${escapeMarkdownInline(r.engineManufacturerModelCode)}`);
      const type = coded(r.aircraftType);
      if (type) facts.push(`Type: ${escapeMarkdownInline(type)}`);
      const airworthiness = coded(r.airworthinessClass);
      if (airworthiness) facts.push(`Airworthiness class: ${escapeMarkdownInline(airworthiness)}`);
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
