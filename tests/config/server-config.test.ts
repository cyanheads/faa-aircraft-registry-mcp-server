/**
 * @fileoverview Server-config tests, centred on the owner-PII redaction gate.
 * Redaction is a privacy control, so `FAA_REDACT_OWNER_PII` must fail safe:
 * every value that is not an explicit, well-formed falsy string resolves to
 * redacted. The framework's env-normalization layer now reads an empty string
 * and an unsubstituted `${…}` placeholder as unset before the schema sees them,
 * which routes those through the same `undefined` branch — these cases pin that
 * the fail-safe still lands on redacted under that layer.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_MIRROR_PATH,
  getServerConfig,
  resetServerConfig,
} from '@/config/server-config.js';

/**
 * A whole-value placeholder reference an install-time host (an MCPB manifest, a
 * plugin manifest) forwarded verbatim because nothing substituted it. Built
 * rather than written literally so it is unmistakably data, not an interpolation
 * the author forgot to close.
 */
const unsubstituted = (name: string): string => `\${${name}}`;

/** Parse the config with `FAA_REDACT_OWNER_PII` set to `value` (or unset). */
function redactionFor(value: string | undefined): boolean {
  resetServerConfig();
  if (value === undefined) vi.stubEnv('FAA_REDACT_OWNER_PII', undefined);
  else vi.stubEnv('FAA_REDACT_OWNER_PII', value);
  return getServerConfig().redactOwnerPii;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('FAA_REDACT_OWNER_PII — fail-safe redaction', () => {
  it.each([
    ['unset', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['unsubstituted placeholder', unsubstituted('FAA_REDACT_OWNER_PII')],
    ['malformed word', 'banana'],
    ['malformed numeric', '2'],
    ['a value that only looks negative', 'FALSE!'],
  ])('resolves to redacted for %s', (_label, value) => {
    expect(redactionFor(value)).toBe(true);
  });

  it.each(['false', 'FALSE', ' false ', '0', 'no', 'off'])(
    'disables redaction for the explicit falsy value %j',
    (value) => {
      expect(redactionFor(value)).toBe(false);
    },
  );

  it.each(['true', 'TRUE', '1', 'yes', 'on'])(
    'keeps redaction on for the explicit truthy value %j',
    (value) => {
      expect(redactionFor(value)).toBe(true);
    },
  );

  it('never throws on a malformed value — a startup failure would be the unsafe outcome', () => {
    resetServerConfig();
    vi.stubEnv('FAA_REDACT_OWNER_PII', '¯\\_(ツ)_/¯');
    expect(() => getServerConfig()).not.toThrow();
  });
});

describe('path and URL fields under env normalization', () => {
  it('falls back to the defaults when the vars are unset', () => {
    resetServerConfig();
    vi.stubEnv('FAA_MIRROR_PATH', undefined);
    vi.stubEnv('FAA_DATABASE_URL', undefined);
    const config = getServerConfig();
    expect(config.mirrorPath).toBe(DEFAULT_MIRROR_PATH);
    expect(config.databaseUrl).toBe(DEFAULT_DATABASE_URL);
  });

  it('reads an empty string and an unsubstituted placeholder as unset, not as a bad value', () => {
    resetServerConfig();
    vi.stubEnv('FAA_MIRROR_PATH', '');
    vi.stubEnv('FAA_DATABASE_URL', unsubstituted('FAA_DATABASE_URL'));
    const config = getServerConfig();
    expect(config.mirrorPath).toBe(DEFAULT_MIRROR_PATH);
    expect(config.databaseUrl).toBe(DEFAULT_DATABASE_URL);
  });

  it('honours a supplied path', () => {
    resetServerConfig();
    vi.stubEnv('FAA_MIRROR_PATH', '/var/lib/faa/registry.db');
    expect(getServerConfig().mirrorPath).toBe('/var/lib/faa/registry.db');
  });
});
