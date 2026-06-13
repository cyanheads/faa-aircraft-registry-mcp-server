/**
 * @fileoverview faa://registration/{nNumber} — read-once full registration record
 * for one N-number, the same payload as faa_lookup_registration. Convenience for
 * clients that inject resources as context; the tool is the reliable path for the
 * tool-only majority of clients.
 * @module mcp-server/resources/definitions/registration.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { registrationRecordSchema } from '@/mcp-server/tools/definitions/_schemas.js';
import { getRegistryService } from '@/services/registry/registry-service.js';

export const registrationResource = resource('faa://registration/{nNumber}', {
  name: 'faa-registration',
  title: 'faa-aircraft-registry-mcp-server: registration record',
  description:
    'Fetch the full registration record for one US civil aircraft N-number — the same decoded, pre-joined payload as faa_lookup_registration. Owner PII is redacted unless the deployment opts in.',
  mimeType: 'application/json',
  params: z.object({
    nNumber: z.string().min(1).describe('US registration N-number. Accepts "N12345" or "12345".'),
  }),
  output: registrationRecordSchema,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The N-number is well-formed but has no active registration in the MASTER file.',
      recovery:
        'Use the faa_get_registration_status tool to check for deregistered/reserved status, or faa_search_registrations to find the right N-number.',
    },
  ],

  async handler(params, ctx) {
    const record = await getRegistryService().lookupRegistration(params.nNumber, ctx);
    if (!record) {
      throw ctx.fail('not_found', `No active registration for N-number "${params.nNumber}".`, {
        ...ctx.recoveryFor('not_found'),
      });
    }
    return record;
  },
});
