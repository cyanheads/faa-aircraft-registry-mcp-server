/**
 * @fileoverview faa_get_aircraft_type — decode a 7-char manufacturer/model/series
 * code to aircraft specs from the ACFTREF reference table: make, model, category,
 * aircraft type, engine type, engine count, seats, weight class, cruise speed,
 * and type-certificate data. The discovery counterpart is faa_search_aircraft_types.
 * @module mcp-server/tools/definitions/get-aircraft-type.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { codedValueSchema, renderCoded } from './_schemas.js';

export const getAircraftTypeTool = tool('faa_get_aircraft_type', {
  title: 'faa-aircraft-registry-mcp-server: get aircraft type',
  description:
    'Decode a 7-character FAA manufacturer/model/series code to aircraft specifications from the reference table — manufacturer, model, aircraft category, aircraft type, engine type, number of engines, number of seats, weight class, cruise speed, and type-certificate data sheet/holder. Use faa_search_aircraft_types first to discover a code by manufacturer or model name.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    code: z
      .string()
      .min(1)
      .describe(
        '7-character manufacturer/model/series code (e.g. "2072714"). Discover codes via faa_search_aircraft_types.',
      ),
  }),

  output: z.object({
    code: z.string().describe('The 7-char manufacturer/model/series code.'),
    manufacturer: z.string().optional().describe('Aircraft manufacturer name.'),
    model: z.string().optional().describe('Aircraft model name.'),
    aircraftType: codedValueSchema.optional().describe('Aircraft type as code + label.'),
    engineType: codedValueSchema.optional().describe('Engine type as code + label.'),
    category: codedValueSchema
      .optional()
      .describe('Aircraft category (Land, Sea, Amphibian) as code + label.'),
    builderCertification: codedValueSchema
      .optional()
      .describe(
        'Builder certification (Type Certificated, Not Type Certificated, Light Sport) as code + label.',
      ),
    numberOfEngines: z
      .number()
      .optional()
      .describe('Number of engines; may be blank on the reference record.'),
    numberOfSeats: z
      .number()
      .optional()
      .describe('Number of seats; may be blank on the reference record.'),
    weightClass: z
      .string()
      .optional()
      .describe('Weight class as the literal FAA string (e.g. "CLASS 1").'),
    cruiseSpeedMph: z
      .number()
      .optional()
      .describe('Cruise speed in mph; often blank (permissible field).'),
    typeCertificateDataSheet: z
      .string()
      .optional()
      .describe('Type-certificate data sheet identifier.'),
    typeCertificateDataHolder: z.string().optional().describe('Type-certificate data holder.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The 7-char code is well-formed but absent from the aircraft reference table.',
      recovery: 'Use faa_search_aircraft_types to discover valid manufacturer/model codes by name.',
    },
  ],

  async handler(input, ctx) {
    const service = getRegistryService();
    const record = await service.getAircraftType(input.code, ctx);
    if (!record) {
      throw ctx.fail('not_found', `No aircraft reference record for code "${input.code}".`, {
        ...ctx.recoveryFor('not_found'),
      });
    }
    return record;
  },

  format: (r) => {
    const lines: string[] = [`## ${[r.manufacturer, r.model].filter(Boolean).join(' ') || r.code}`];
    lines.push(`**Code:** ${r.code}`);
    const push = (line?: string) => {
      if (line) lines.push(line);
    };
    push(renderCoded('Aircraft type', r.aircraftType));
    push(renderCoded('Engine type', r.engineType));
    push(renderCoded('Category', r.category));
    push(renderCoded('Builder certification', r.builderCertification));
    if (r.numberOfEngines !== undefined) lines.push(`**Engines:** ${r.numberOfEngines}`);
    if (r.numberOfSeats !== undefined) lines.push(`**Seats:** ${r.numberOfSeats}`);
    if (r.weightClass) lines.push(`**Weight class:** ${r.weightClass}`);
    if (r.cruiseSpeedMph !== undefined) lines.push(`**Cruise speed:** ${r.cruiseSpeedMph} mph`);
    if (r.typeCertificateDataSheet) lines.push(`**TC data sheet:** ${r.typeCertificateDataSheet}`);
    if (r.typeCertificateDataHolder)
      lines.push(`**TC data holder:** ${r.typeCertificateDataHolder}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
