/**
 * @fileoverview Shared Zod schemas and markdown renderers for the FAA registry
 * tools. The full registration-record schema and its `format()` text are reused
 * by `faa_lookup_registration` and the `faa://registration/{nNumber}` resource,
 * so they live here as one source of truth. Coded fields surface BOTH the raw
 * code and the decoded label; permissible fields are optional and rendered as
 * absent rather than fabricated.
 * @module mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** A coded field shown as both raw code and decoded label. */
export const codedValueSchema = z
  .object({
    code: z.string().describe('The raw code as stored in the FAA registry.'),
    label: z
      .string()
      .optional()
      .describe('The decoded human-readable label; omitted when the code is unrecognized.'),
  })
  .describe('A coded field surfaced as both its raw FAA code and the decoded label.');

/** Owner / registrant block — only present when owner-PII redaction is off. */
export const ownerDetailSchema = z
  .object({
    name: z.string().optional().describe('Registrant name.'),
    street: z.string().optional().describe('Street address line 1.'),
    street2: z.string().optional().describe('Street address line 2.'),
    city: z.string().optional().describe('City.'),
    state: z.string().optional().describe('Two-letter state/territory abbreviation.'),
    zip: z.string().optional().describe('Postal/ZIP code.'),
    county: z.string().optional().describe('County code.'),
    country: z.string().optional().describe('Country code.'),
    typeRegistrant: codedValueSchema
      .optional()
      .describe('Registrant type (Individual, LLC, Corporation, Government, …) as code + label.'),
    otherNames: z
      .array(z.string().describe('A co-owner name.'))
      .optional()
      .describe('Co-owner names (1–5 on record); only present when PII redaction is off.'),
  })
  .describe('Registrant name and address. Present only when FAA_REDACT_OWNER_PII is false.');

/** Full active-registration record schema (lookup tool + resource). */
export const registrationRecordSchema = z.object({
  nNumber: z
    .string()
    .describe('Normalized N-number without the leading "N" (the registry storage form).'),
  nNumberDisplay: z
    .string()
    .describe('N-number in conventional display form, with the leading "N".'),
  serialNumber: z.string().optional().describe('Manufacturer serial number.'),
  manufacturerModelCode: z
    .string()
    .optional()
    .describe(
      '7-char manufacturer/model/series code (join key into the aircraft reference table).',
    ),
  engineManufacturerModelCode: z
    .string()
    .optional()
    .describe('5-char engine manufacturer/model code (join key into the engine reference table).'),
  make: z
    .string()
    .optional()
    .describe('Aircraft manufacturer name, resolved from the reference table.'),
  model: z.string().optional().describe('Aircraft model name, resolved from the reference table.'),
  aircraftType: codedValueSchema
    .optional()
    .describe('Aircraft type (e.g. Fixed-wing single-engine) as code + label.'),
  engineType: codedValueSchema
    .optional()
    .describe('Engine type (e.g. Reciprocating, Turbo-fan) as code + label.'),
  engineMake: z
    .string()
    .optional()
    .describe('Engine manufacturer name, resolved from the reference table.'),
  engineModel: z
    .string()
    .optional()
    .describe('Engine model name, resolved from the reference table.'),
  yearManufactured: z
    .number()
    .optional()
    .describe('Year the aircraft was manufactured; often blank (permissible field).'),
  region: codedValueSchema.optional().describe("Registrant's FAA region as code + label."),
  lastActionDate: z
    .string()
    .optional()
    .describe('Date of the last registration action (YYYY-MM-DD).'),
  certIssueDate: z.string().optional().describe('Certificate issue date (YYYY-MM-DD).'),
  airworthinessClass: codedValueSchema
    .optional()
    .describe(
      'Airworthiness classification (Standard, Experimental, …) from CERTIFICATION char 1, as code + label.',
    ),
  approvedOperationsRaw: z
    .string()
    .optional()
    .describe(
      'Raw FAA approved-operations sub-code string; interpretation varies by airworthiness class.',
    ),
  status: codedValueSchema
    .optional()
    .describe('Registration status (e.g. Valid registration) as code + label.'),
  airworthinessDate: z.string().optional().describe('Airworthiness certificate date (YYYY-MM-DD).'),
  expirationDate: z.string().optional().describe('Registration expiration date (YYYY-MM-DD).'),
  modeSCodeOctal: z.string().optional().describe('Mode S transponder code in octal.'),
  modeSCodeHex: z
    .string()
    .optional()
    .describe(
      'Mode S code in hex — the ICAO 24-bit address used to key live flight-tracking data.',
    ),
  fractionalOwner: z.boolean().describe('True when the aircraft is under fractional ownership.'),
  uniqueId: z.string().optional().describe('FAA unique aircraft identifier.'),
  kitManufacturer: z
    .string()
    .optional()
    .describe('Kit manufacturer (amateur-built aircraft); often blank.'),
  kitModel: z.string().optional().describe('Kit model (amateur-built aircraft); often blank.'),
  owner: ownerDetailSchema
    .optional()
    .describe('Registrant name/address; present only when redaction is off.'),
  ownerRedacted: z
    .boolean()
    .describe(
      'True when owner name/address were withheld from this payload by the redaction gate.',
    ),
});

export type RegistrationRecordOutput = z.infer<typeof registrationRecordSchema>;

/** A coded value as it appears in tool output (Zod-inferred, exactOptional-friendly). */
export type CodedValueOutput = { code: string; label?: string | undefined };

/** Render a coded value as `Label (CODE)` or just the code when undecoded. */
export function renderCoded(label: string, value?: CodedValueOutput): string | undefined {
  if (!value) return;
  return value.label
    ? `**${label}:** ${value.label} (${value.code})`
    : `**${label}:** ${value.code}`;
}

/**
 * Render a full registration record to markdown — every field the LLM needs.
 * Renders each terminal field present in the schema (format-parity: the linter
 * synthesizes a sentinel per leaf and verifies it appears here). Coded values
 * always surface both label and code; the owner block renders whenever present,
 * independent of the redaction flag (which is surfaced by its own key name).
 */
export function formatRegistrationRecord(r: RegistrationRecordOutput): string {
  const lines: string[] = [`## ${r.nNumberDisplay}  (N-number: ${r.nNumber})`];

  const makeModel = [r.make, r.model].filter(Boolean).join(' ');
  const headline = [r.yearManufactured?.toString(), makeModel].filter(Boolean).join(' ');
  if (headline) lines.push(`**Aircraft:** ${headline}`);

  const push = (line?: string) => {
    if (line) lines.push(line);
  };

  push(renderCoded('Aircraft type', r.aircraftType));
  if (r.engineMake || r.engineModel) {
    push(`**Engine:** ${[r.engineMake, r.engineModel].filter(Boolean).join(' ')}`);
  }
  push(renderCoded('Engine type', r.engineType));
  push(renderCoded('Status', r.status));
  push(renderCoded('Airworthiness class', r.airworthinessClass));
  if (r.approvedOperationsRaw) push(`**Approved operations (raw):** ${r.approvedOperationsRaw}`);
  push(renderCoded('Region', r.region));
  if (r.serialNumber) push(`**Serial number:** ${r.serialNumber}`);
  if (r.manufacturerModelCode) push(`**Mfr/model code:** ${r.manufacturerModelCode}`);
  if (r.engineManufacturerModelCode)
    push(`**Engine mfr/model code:** ${r.engineManufacturerModelCode}`);
  if (r.modeSCodeHex) push(`**Mode S (hex / ICAO 24-bit):** ${r.modeSCodeHex}`);
  if (r.modeSCodeOctal) push(`**Mode S (octal):** ${r.modeSCodeOctal}`);
  push(`**Fractional ownership (fractionalOwner):** ${r.fractionalOwner ? 'Yes' : 'No'}`);
  if (r.certIssueDate) push(`**Certificate issued:** ${r.certIssueDate}`);
  if (r.airworthinessDate) push(`**Airworthiness date:** ${r.airworthinessDate}`);
  if (r.expirationDate) push(`**Expires:** ${r.expirationDate}`);
  if (r.lastActionDate) push(`**Last action:** ${r.lastActionDate}`);
  if (r.uniqueId) push(`**Unique ID:** ${r.uniqueId}`);
  if (r.kitManufacturer || r.kitModel) {
    push(`**Kit:** ${[r.kitManufacturer, r.kitModel].filter(Boolean).join(' ')}`);
  }

  push(
    r.ownerRedacted
      ? '**Owner (ownerRedacted=true):** withheld — owner PII is redacted on this deployment.'
      : '**Owner (ownerRedacted=false):** see registrant details below.',
  );
  if (r.owner) {
    const o = r.owner;
    push('### Registrant');
    if (o.name) push(`**Name:** ${o.name}`);
    push(renderCoded('Registrant type', o.typeRegistrant));
    if (o.street) push(`**Street:** ${o.street}`);
    if (o.street2) push(`**Street 2:** ${o.street2}`);
    if (o.city) push(`**City:** ${o.city}`);
    if (o.state) push(`**State:** ${o.state}`);
    if (o.zip) push(`**ZIP:** ${o.zip}`);
    if (o.county) push(`**County:** ${o.county}`);
    if (o.country) push(`**Country:** ${o.country}`);
    if (o.otherNames && o.otherNames.length > 0) push(`**Co-owners:** ${o.otherNames.join('; ')}`);
  }

  return lines.join('\n');
}
