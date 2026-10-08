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
    'Fetch the full decoded registration record for one US civil aircraft N-number — the same payload as faa_lookup_registration. Owner PII is redacted unless the deployment opts in.',
  mimeType: 'application/json',
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'private' },
  params: z.object({
    nNumber: z
      .string()
      .min(1)
      .describe(
        'US registration N-number. Accepts "N12345" or "12345" (leading N optional). Shape: 1–5 characters — a leading digit 1–9, then digits, optionally ending in 1–2 letters (I and O are unused).',
      ),
  }),
  output: registrationRecordSchema,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The N-number is well-formed but has no active registration.',
      recovery:
        'Use the faa_get_registration_status tool to check for deregistered/reserved status, or faa_search_registrations to find the right N-number.',
    },
    {
      reason: 'invalid_n_number',
      // Raised in registry-service's shared N-number gate, not in this handler.
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The N-number is not structurally valid (after the optional leading "N": 1–5 characters, a leading digit 1–9, then digits, optionally 1–2 trailing letters; I and O are unused).',
      recovery:
        'Request a valid N-number such as "N172SP" or "N12345" (leading N optional), or use faa_search_registrations to find one by make/model, state, or Mode S code.',
    },
  ],

  async handler(params, ctx) {
    const record = await getRegistryService().lookupRegistration(params.nNumber, ctx);
    if (!record) {
      throw ctx.fail('not_found', `No active registration for N-number "${params.nNumber}".`);
    }
    return record;
  },
});
