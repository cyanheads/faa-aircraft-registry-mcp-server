/**
 * @fileoverview faa_search_aircraft_types — search the aircraft reference table by
 * manufacturer/model name, aircraft type, or category to discover the 7-char
 * manufacturer/model codes and browse specs. Fills the discovery gap before
 * faa_get_aircraft_type. Discloses truncation when the result set hits the limit.
 * @module mcp-server/tools/definitions/search-aircraft-types.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { codedValueSchema } from './_schemas.js';

const aircraftTypeSummarySchema = z
  .object({
    code: z
      .string()
      .describe(
        '7-char manufacturer/model/series code — pass to faa_get_aircraft_type for full specs.',
      ),
    manufacturer: z.string().optional().describe('Aircraft manufacturer name.'),
    model: z.string().optional().describe('Aircraft model name.'),
    aircraftType: codedValueSchema.optional().describe('Aircraft type as code + label.'),
    category: codedValueSchema
      .optional()
      .describe('Aircraft category (Land, Sea, Amphibian) as code + label.'),
    numberOfEngines: z.number().optional().describe('Number of engines; may be blank.'),
    numberOfSeats: z.number().optional().describe('Number of seats; may be blank.'),
  })
  .describe(
    'A decoded aircraft-reference summary; use code with faa_get_aircraft_type for full specs.',
  );

export const searchAircraftTypesTool = tool('faa_search_aircraft_types', {
  title: 'faa-aircraft-registry-mcp-server: search aircraft types',
  description:
    'Search the FAA aircraft reference table by manufacturer/model name (full-text), aircraft type code, or category code to discover 7-character manufacturer/model/series codes and browse specifications. Use this before faa_get_aircraft_type to find a code by name. At least one filter is required. When the result count hits the limit, the response discloses truncation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    query: z.string().optional().describe('Manufacturer and/or model name to match (full-text).'),
    aircraftType: z
      .string()
      .optional()
      .describe('Aircraft type code to match exactly (e.g. "6" for rotorcraft).'),
    category: z
      .string()
      .optional()
      .describe('Aircraft category code to match exactly (1 Land, 2 Sea, 3 Amphibian).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(25)
      .describe('Maximum number of results to return (1–200, default 25).'),
  }),

  output: z.object({
    aircraftTypes: z
      .array(aircraftTypeSummarySchema)
      .describe('Matching aircraft-reference summaries (up to limit).'),
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
      .describe('Guidance when no aircraft types matched the supplied filters.'),
  },

  errors: [
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No search filter was supplied.',
      recovery:
        'Provide a query (manufacturer/model name), an aircraftType code, or a category code to search.',
    },
  ],

  async handler(input, ctx) {
    const service = getRegistryService();
    const query = input.query?.trim() || undefined;
    const aircraftType = input.aircraftType?.trim() || undefined;
    const category = input.category?.trim() || undefined;

    if (!query && !aircraftType && !category) {
      throw ctx.fail('no_filters', 'At least one search filter is required.', {
        ...ctx.recoveryFor('no_filters'),
      });
    }

    const page = await service.searchAircraftTypes(
      {
        ...(query ? { query } : {}),
        ...(aircraftType ? { aircraftType } : {}),
        ...(category ? { category } : {}),
        limit: input.limit,
      },
      ctx,
    );

    if (page.items.length === 0) {
      ctx.enrich.notice(
        'No aircraft types matched the supplied filters. Broaden the name query or verify the type/category code.',
      );
    }
    if (page.truncated) {
      ctx.enrich.truncated({ shown: page.items.length, cap: page.cap });
    }

    return { aircraftTypes: page.items };
  },

  format: (result) => {
    if (result.aircraftTypes.length === 0) {
      return [{ type: 'text', text: 'No matching aircraft types.' }];
    }
    const coded = (v?: { code: string; label?: string | undefined }) =>
      v ? (v.label ? `${v.label} (${v.code})` : v.code) : undefined;
    const lines: string[] = [];
    for (const a of result.aircraftTypes) {
      lines.push(`### ${[a.manufacturer, a.model].filter(Boolean).join(' ') || a.code}`);
      const facts: string[] = [`Code: ${a.code}`];
      const type = coded(a.aircraftType);
      if (type) facts.push(`Type: ${type}`);
      const category = coded(a.category);
      if (category) facts.push(`Category: ${category}`);
      if (a.numberOfEngines !== undefined) facts.push(`Engines: ${a.numberOfEngines}`);
      if (a.numberOfSeats !== undefined) facts.push(`Seats: ${a.numberOfSeats}`);
      lines.push(facts.join(' | '));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
