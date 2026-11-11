/**
 * @fileoverview Search limit validation and pagination disclosures.
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { enrichSnapshot, snapshotEnrichment } from './_response-metadata.js';

const PAGE_LIMIT = 200;
const DEFAULT_LIMIT = 25;
const clampLimits = getServerConfig().clampLimits;

/** Keep Zod's integer check from advertising a safe-integer ceiling in clamp mode. */
export const searchLimitSchema = clampLimits
  ? z
      .number()
      .min(1)
      .refine(Number.isInteger)
      .default(DEFAULT_LIMIT)
      .meta({ type: 'integer' })
      .describe(
        `Requested page size (positive integer, default ${DEFAULT_LIMIT}); requests above ${PAGE_LIMIT} are clamped.`,
      )
  : z
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Page size from 1 to ${PAGE_LIMIT} (default ${DEFAULT_LIMIT}).`);

type SearchToolName = 'faa_search_registrations' | 'faa_search_aircraft_types';
const clampedLimits = createCounter(
  'faa.search.limit.clamped',
  'Search requests with a clamped page limit.',
);

/** Apply the advertised policy before querying and record each clamp once. */
export function applySearchLimit(ctx: Context, tool: SearchToolName, requested: number) {
  if (!clampLimits || requested <= PAGE_LIMIT) return { limit: requested };
  ctx.log.info('Clamped FAA search page limit', { requested, applied: PAGE_LIMIT });
  clampedLimits.add(1, { tool });
  return { limit: PAGE_LIMIT, notice: `Requested limit ${requested}; applied ${PAGE_LIMIT}.` };
}

/** Metadata shared by the two search responses. */
export const searchEnrichment = {
  ...snapshotEnrichment,
  totalCount: z.number().describe('Total matches across all pages. Always present.'),
  nextOffset: z.number().optional().describe('Offset for the next page, when more matches remain.'),
  truncated: z.boolean().optional().describe('Present and true when more matches remain.'),
  shown: z.number().optional().describe('Number of results on this page when truncated.'),
  cap: z.number().optional().describe('Applied page limit when truncated.'),
};

/** Disclose the page boundary, the applied limit, and the date of the same snapshot. */
export function enrichSearchPage(
  ctx: Context,
  tool: SearchToolName,
  page: { items: readonly unknown[]; totalCount: number; truncated: boolean; cap: number },
  offset: number,
  dataAsOf: string | undefined,
  clampNotice: string | undefined,
  noMatches: string,
): void {
  const { totalCount, truncated, cap } = page;
  const shown = page.items.length;
  ctx.enrich.total(totalCount);
  let pageNotice: string | undefined;
  if (truncated) {
    const nextOffset = offset + shown;
    ctx.enrich({ nextOffset, truncated, shown, cap });
    pageNotice = `Showing ${shown} of ${totalCount} matches. Call ${tool} again with the same filters and offset: ${nextOffset} for the next page.`;
  } else if (shown === 0) {
    pageNotice =
      totalCount > 0
        ? `Offset ${offset} is past the end of this result set — ${totalCount} records match, but none remain at that offset. Retry with a lower offset.`
        : noMatches;
  }
  enrichSnapshot(ctx, dataAsOf, clampNotice, pageNotice);
}
