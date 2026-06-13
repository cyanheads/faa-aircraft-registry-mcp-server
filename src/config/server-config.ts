/**
 * @fileoverview Server-specific configuration for the FAA aircraft registry.
 * Lazy-parsed from environment variables. Framework config (transport, logging,
 * etc.) is handled by @cyanheads/mcp-ts-core and never merged here.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Default on-disk location of the SQLite mirror index. */
export const DEFAULT_MIRROR_PATH = '.mirror/faa-registry.db';

/** Default source URL for the FAA Releasable Aircraft Database ZIP. */
export const DEFAULT_DATABASE_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

/**
 * Fail-safe owner-PII redaction default.
 *
 * `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything
 * else — but the redaction gate is a privacy control, so a malformed or empty
 * value must resolve to redacted (the safe state), never throw at startup and
 * never silently expose PII. We coerce unset/empty/unrecognized to `'true'`
 * before `stringbool` ever sees it, so only an explicit, well-formed
 * `false`/`0`/`no`/`off` turns redaction off.
 */
const redactToSafeDefault = (v: unknown): unknown => {
  if (v === undefined || v === null || v === '') return 'true';
  if (typeof v !== 'string') return 'true';
  const normalized = v.trim().toLowerCase();
  const recognized = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
  return recognized.has(normalized) ? normalized : 'true';
};

const ServerConfigSchema = z.object({
  /**
   * When true, drop registrant name/address and co-owner names from all output
   * AND disable owner-name search. Defaults to true (redacted); unset, empty, or
   * malformed resolves to true so omission never leaks PII.
   */
  redactOwnerPii: z
    .preprocess(redactToSafeDefault, z.stringbool())
    .describe('Fail-safe owner-PII redaction. Redacted unless explicitly set to a falsy value.'),
  /** Filesystem path to the SQLite mirror index file. */
  mirrorPath: z
    .string()
    .min(1)
    .default(DEFAULT_MIRROR_PATH)
    .describe('Filesystem path to the SQLite registry index.'),
  /** Source URL for ReleasableAircraft.zip, used by mirror:init / mirror:refresh only. */
  databaseUrl: z
    .string()
    .url()
    .default(DEFAULT_DATABASE_URL)
    .describe('Source URL for the FAA Releasable Aircraft Database ZIP (ingest-time only).'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and cache the server config from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    redactOwnerPii: 'FAA_REDACT_OWNER_PII',
    mirrorPath: 'FAA_MIRROR_PATH',
    databaseUrl: 'FAA_DATABASE_URL',
  });
  return _config;
}

/** Reset the cached config — test-only. */
export function resetServerConfig(): void {
  _config = undefined;
}
