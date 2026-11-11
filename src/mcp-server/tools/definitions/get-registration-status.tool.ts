/**
 * @fileoverview faa_get_registration_status — resolve registration + airworthiness
 * status for an N-number across all three status files (active MASTER,
 * reserved RESERVED, deregistered DEREG) in priority order, returning a
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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { mirrorLoadingError } from '../../_mirror-errors.js';
import { enrichSnapshot, snapshotEnrichment } from './_response-metadata.js';
import { codedValueSchema, renderCoded } from './_schemas.js';

const cancellationSchema = z
  .object({
    cancelDate: z.string().optional().describe('Cancellation date, YYYY-MM-DD.'),
    serialNumber: z.string().optional().describe('Manufacturer serial number.'),
    manufacturerModelCode: z.string().optional().describe('FAA manufacturer/model/series code.'),
    make: z.string().optional().describe('Aircraft manufacturer name.'),
    model: z.string().optional().describe('Aircraft model name.'),
    exportCountry: z.string().optional().describe('FAA export destination country.'),
    status: codedValueSchema.optional().describe('Status recorded on the cancellation row.'),
  })
  .describe('One cancellation record for this N-number.');

export const getRegistrationStatusTool = tool('faa_get_registration_status', {
  title: 'faa-aircraft-registry-mcp-server: get registration status',
  description:
    'Resolve whether a US civil aircraft N-number is active, reserved, deregistered, or unknown. Includes available registration and airworthiness status and cancellation history for the number. A reassigned number can have cancellations for different aircraft. Accepts "N12345" or "12345".',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    nNumber: z
      .string()
      .min(1)
      .describe(
        'US registration N-number to resolve. Accepts "N12345" or "12345" (leading N optional). Shape: 1–5 characters — a leading digit 1–9, then digits, optionally ending in 1–2 letters (I and O are unused).',
      ),
  }),

  output: z.object({
    recordType: z
      .enum(['active', 'deregistered', 'reserved', 'unknown'])
      .describe('Resolved registration state: active, deregistered, reserved, or unknown.'),
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
      .describe('6–7-character manufacturer/model/series code (deregistered records).'),
    modeSCodeHex: z
      .string()
      .optional()
      .describe('Mode S code in hex / ICAO 24-bit address (deregistered records).'),
    make: z.string().optional().describe('Aircraft manufacturer name (deregistered records).'),
    model: z.string().optional().describe('Aircraft model name (deregistered records).'),
    exportCountry: z
      .string()
      .optional()
      .describe('FAA export destination country (deregistered records).'),
    yearManufactured: z.number().optional().describe('Manufacture year (deregistered records).'),
    cancellations: z
      .array(cancellationSchema)
      .optional()
      .describe('Cancellation records for this N-number, newest first with undated records last.'),
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

  enrichment: snapshotEnrichment,

  errors: [
    mirrorLoadingError,
    {
      reason: 'invalid_n_number',
      // Raised in registry-service's shared N-number gate, not in this handler.
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input is not a structurally valid N-number (after the optional leading "N": 1–5 characters, a leading digit 1–9, then digits, optionally 1–2 trailing letters; I and O are unused).',
      recovery:
        'Supply a valid N-number such as "N172SP" or "N12345" (leading N optional), or use faa_search_registrations to find one by make/model, state, or Mode S code.',
    },
  ],

  async handler(input, ctx) {
    const service = getRegistryService();
    let dataAsOf: string | undefined;
    const result = await service.getRegistrationStatus(input.nNumber, ctx, (snapshot) => {
      dataAsOf = snapshot.dataAsOf;
    });
    // The service returns a discriminated union; flatten to the object output.
    enrichSnapshot(ctx, dataAsOf);
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
      `## ${escapeMarkdownInline(r.nNumberDisplay)} (N-number: ${escapeMarkdownInline(r.nNumber)})`,
      `**Record type:** ${label[r.recordType]}`,
    ];
    const push = (line?: string) => {
      if (line) lines.push(line);
    };
    push(
      renderCoded(
        r.recordType === 'deregistered' ? 'Status recorded at cancellation' : 'Status',
        r.status,
      ),
    );
    push(renderCoded('Airworthiness class', r.airworthinessClass));
    if (r.certIssueDate) push(`**Certificate issued:** ${escapeMarkdownInline(r.certIssueDate)}`);
    if (r.airworthinessDate)
      push(`**Airworthiness date:** ${escapeMarkdownInline(r.airworthinessDate)}`);
    if (r.expirationDate) push(`**Expires:** ${escapeMarkdownInline(r.expirationDate)}`);
    if (r.cancelDate) push(`**Cancelled:** ${escapeMarkdownInline(r.cancelDate)}`);
    if (r.serialNumber) push(`**Serial number:** ${escapeMarkdownInline(r.serialNumber)}`);
    if (r.manufacturerModelCode)
      push(`**Mfr/model code:** ${escapeMarkdownInline(r.manufacturerModelCode)}`);
    if (r.modeSCodeHex) push(`**Mode S (hex):** ${escapeMarkdownInline(r.modeSCodeHex)}`);
    if (r.make) push(`**Make:** ${escapeMarkdownInline(r.make)}`);
    if (r.model) push(`**Model:** ${escapeMarkdownInline(r.model)}`);
    if (r.exportCountry) push(`**Export country:** ${escapeMarkdownInline(r.exportCountry)}`);
    if (r.yearManufactured !== undefined) push(`**Year manufactured:** ${r.yearManufactured}`);
    push(renderCoded('Reservation type', r.typeReservation));
    if (r.reserveDate) push(`**Reserved:** ${escapeMarkdownInline(r.reserveDate)}`);
    if (r.expirationNoticeDate)
      push(`**Expiration notice sent:** ${escapeMarkdownInline(r.expirationNoticeDate)}`);
    if (r.purgeDate) push(`**Purge date:** ${escapeMarkdownInline(r.purgeDate)}`);
    if (r.nNumberForChange)
      push(`**N-number for change:** ${escapeMarkdownInline(r.nNumberForChange)}`);
    if (r.cancellations?.length) {
      lines.push('', '### Cancellation history for this N-number');
      for (const [index, row] of r.cancellations.entries()) {
        lines.push('', `#### Cancellation ${index + 1}`);
        if (row.cancelDate) push(`**Cancelled:** ${escapeMarkdownInline(row.cancelDate)}`);
        if (row.serialNumber) push(`**Serial number:** ${escapeMarkdownInline(row.serialNumber)}`);
        if (row.manufacturerModelCode)
          push(`**Mfr/model code:** ${escapeMarkdownInline(row.manufacturerModelCode)}`);
        if (row.make) push(`**Make:** ${escapeMarkdownInline(row.make)}`);
        if (row.model) push(`**Model:** ${escapeMarkdownInline(row.model)}`);
        if (row.exportCountry)
          push(`**Export country:** ${escapeMarkdownInline(row.exportCountry)}`);
        push(renderCoded('Status recorded at cancellation', row.status));
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
