/**
 * @fileoverview faa_get_registration_status — resolve registration + airworthiness
 * status for an N-number across all three status files (active MASTER,
 * deregistered DEREG, reserved RESERVED) in priority order, returning a
 * discriminated recordType. Unlike faa_lookup_registration, a known-but-inactive
 * number resolves to a definitive deregistered/reserved answer rather than a
 * not-found; a never-issued number is a valid "unknown" result, not an error.
 *
 * The output is a single object keyed on `recordType` (the tool `output` contract
 * requires a ZodObject, not a top-level discriminated union); branch-specific
 * fields are optional and populated per record type. `format()` renders only the
 * fields relevant to the resolved type.
 * @module mcp-server/tools/definitions/get-registration-status.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { codedValueSchema, renderCoded } from './_schemas.js';

export const getRegistrationStatusTool = tool('faa_get_registration_status', {
  title: 'faa-aircraft-registry-mcp-server: get registration status',
  description:
    'Resolve registration and airworthiness status for a US civil aircraft N-number across all three status files — active (MASTER), deregistered (DEREG), and reserved (RESERVED) — in priority order, returning a definitive recordType. Use this (rather than faa_lookup_registration) when a number may be inactive: it returns "deregistered" or "reserved" for a known-but-inactive number instead of a not-found. A number that was never issued returns recordType "unknown" — a valid, informative answer, not an error. Accepts "N12345" or "12345".',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    nNumber: z
      .string()
      .min(1)
      .describe(
        'US registration N-number to resolve. Accepts "N12345" or "12345"; the leading N is optional.',
      ),
  }),

  output: z.object({
    recordType: z
      .enum(['active', 'deregistered', 'reserved', 'unknown'])
      .describe(
        'Which file the number resolved in: active (MASTER), deregistered (DEREG), reserved (RESERVED), or unknown (none).',
      ),
    nNumber: z.string().describe('Normalized N-number without the leading "N".'),
    nNumberDisplay: z.string().describe('N-number with the leading "N" for display.'),
    status: codedValueSchema
      .optional()
      .describe(
        'Registration/cancellation status as code + label (active and deregistered records).',
      ),
    airworthinessClass: codedValueSchema
      .optional()
      .describe('Airworthiness classification as code + label (active records).'),
    certIssueDate: z
      .string()
      .optional()
      .describe('Certificate issue date, YYYY-MM-DD (active records).'),
    expirationDate: z
      .string()
      .optional()
      .describe('Registration expiration date, YYYY-MM-DD (active records).'),
    airworthinessDate: z
      .string()
      .optional()
      .describe('Airworthiness certificate date, YYYY-MM-DD (active records).'),
    cancelDate: z
      .string()
      .optional()
      .describe('Cancellation date, YYYY-MM-DD (deregistered records).'),
    serialNumber: z
      .string()
      .optional()
      .describe('Manufacturer serial number (deregistered records).'),
    manufacturerModelCode: z
      .string()
      .optional()
      .describe('7-char manufacturer/model/series code (deregistered records).'),
    modeSCodeHex: z
      .string()
      .optional()
      .describe('Mode S code in hex / ICAO 24-bit address (deregistered records).'),
    typeReservation: codedValueSchema
      .optional()
      .describe('Type of reservation as code + label (reserved records).'),
    reserveDate: z
      .string()
      .optional()
      .describe('Date the number was reserved, YYYY-MM-DD (reserved records).'),
    expirationNoticeDate: z
      .string()
      .optional()
      .describe('Date an expiration notice was sent, YYYY-MM-DD (reserved records).'),
    purgeDate: z
      .string()
      .optional()
      .describe('Scheduled purge date, YYYY-MM-DD (reserved records).'),
    nNumberForChange: z
      .string()
      .optional()
      .describe('The N-number this reservation changes to/from (reserved records).'),
  }),

  async handler(input, ctx) {
    const service = getRegistryService();
    const result = await service.getRegistrationStatus(input.nNumber, ctx);
    // The service returns a discriminated union; flatten to the object output.
    return { ...result };
  },

  format: (r) => {
    /**
     * Fields render linearly (not switch-gated on recordType) so every terminal
     * field satisfies format-parity — for real data only the resolved branch
     * carries values, so unrelated lines stay absent.
     */
    const label: Record<typeof r.recordType, string> = {
      active: 'Active registration',
      deregistered: 'Deregistered (cancelled)',
      reserved: 'Reserved N-number',
      unknown:
        'Unknown — not found in the active, deregistered, or reserved files. It may never have been issued.',
    };
    const lines: string[] = [
      `## ${r.nNumberDisplay} (N-number: ${r.nNumber})`,
      `**Record type:** ${label[r.recordType]}`,
    ];
    const push = (line?: string) => {
      if (line) lines.push(line);
    };
    push(renderCoded('Status', r.status));
    push(renderCoded('Airworthiness class', r.airworthinessClass));
    if (r.certIssueDate) push(`**Certificate issued:** ${r.certIssueDate}`);
    if (r.airworthinessDate) push(`**Airworthiness date:** ${r.airworthinessDate}`);
    if (r.expirationDate) push(`**Expires:** ${r.expirationDate}`);
    if (r.cancelDate) push(`**Cancelled:** ${r.cancelDate}`);
    if (r.serialNumber) push(`**Serial number:** ${r.serialNumber}`);
    if (r.manufacturerModelCode) push(`**Mfr/model code:** ${r.manufacturerModelCode}`);
    if (r.modeSCodeHex) push(`**Mode S (hex):** ${r.modeSCodeHex}`);
    push(renderCoded('Reservation type', r.typeReservation));
    if (r.reserveDate) push(`**Reserved:** ${r.reserveDate}`);
    if (r.expirationNoticeDate) push(`**Expiration notice sent:** ${r.expirationNoticeDate}`);
    if (r.purgeDate) push(`**Purge date:** ${r.purgeDate}`);
    if (r.nNumberForChange) push(`**N-number for change:** ${r.nNumberForChange}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
