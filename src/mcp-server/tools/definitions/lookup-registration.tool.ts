/**
 * @fileoverview faa_lookup_registration — the 80% tool. Decodes one N-number to
 * its full pre-joined active record: aircraft make/model, engine, year,
 * registration + airworthiness status, Mode S code, and (when redaction is off)
 * registered owner. One call resolves the MASTER→ACFTREF→ENGINE join and decodes
 * every coded field. A known-but-inactive number not-founds here with a pointer
 * to faa_get_registration_status.
 * @module mcp-server/tools/definitions/lookup-registration.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { formatRegistrationRecord, registrationRecordSchema } from './_schemas.js';

export const lookupRegistrationTool = tool('faa_lookup_registration', {
  title: 'faa-aircraft-registry-mcp-server: lookup registration',
  description:
    'Decode one US civil aircraft N-number to its full registration record — aircraft make/model, engine, year manufactured, airworthiness, registration status, Mode S (ICAO 24-bit) code, and registered owner (when owner-PII redaction is off). One call resolves the relational join and decodes every coded field. Accepts "N12345" or "12345" (the leading N is optional). Returns ownerRedacted: true when owner details were withheld. A number that is known but inactive (deregistered or reserved) is not found here — use faa_get_registration_status for the cross-file status answer.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    nNumber: z
      .string()
      .min(1)
      .describe(
        'US registration N-number to decode. Accepts "N12345" or "12345"; the leading N is optional.',
      ),
  }),

  output: registrationRecordSchema,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The N-number is well-formed but has no active registration in the MASTER file.',
      recovery:
        'Call faa_get_registration_status to check whether the number is deregistered or reserved, or faa_search_registrations to find the right N-number.',
    },
  ],

  async handler(input, ctx) {
    const service = getRegistryService();
    const record = await service.lookupRegistration(input.nNumber, ctx);
    if (!record) {
      throw ctx.fail('not_found', `No active registration for N-number "${input.nNumber}".`, {
        ...ctx.recoveryFor('not_found'),
      });
    }
    return record;
  },

  format: (result) => [{ type: 'text', text: formatRegistrationRecord(result) }],
});
