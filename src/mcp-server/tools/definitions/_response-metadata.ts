/**
 * @fileoverview Snapshot date and search page disclosures for FAA tools.
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Metadata shared by every successful tool response. */
export const snapshotEnrichment = {
  dataAsOf: z.iso
    .date()
    .optional()
    .describe('Source date of the FAA registry snapshot, YYYY-MM-DD.'),
  notice: z.string().optional().describe('Refresh, limit, or search guidance when applicable.'),
};

/** Publish the date from the query snapshot and combine notices in one field. */
export function enrichSnapshot(
  ctx: Context,
  dataAsOf: string | undefined,
  ...notices: (string | undefined)[]
): void {
  if (dataAsOf) {
    ctx.enrich({ dataAsOf });
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    if (today - Date.parse(dataAsOf) > STALE_AFTER_MS) {
      notices.push(
        'The FAA registry snapshot is more than seven days old. Run mirror:refresh to refresh it.',
      );
    }
  } else {
    notices.push(
      'The FAA registry snapshot date is unavailable. Run mirror:refresh to refresh it.',
    );
  }
  const notice = notices.filter(Boolean).join(' ');
  if (notice) ctx.enrich.notice(notice);
}
