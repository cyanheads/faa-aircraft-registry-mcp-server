# Developer Protocol

**Server:** faa-aircraft-registry-mcp-server
**Version:** 0.1.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What This Server Is

An offline lookup server for the US civil aircraft registry. It indexes the FAA's public-domain [Releasable Aircraft Database](https://registry.faa.gov/database/ReleasableAircraft.zip) into an embedded SQLite + FTS5 mirror (built via the framework `MirrorService`), pre-joining `MASTER` → `ACFTREF` → `ENGINE` and decoding coded fields at query time. Keyless, no runtime network — every query hits the local index.

**Server-as-source.** The mirror is the source of truth at runtime; there is no upstream API to retry. The index is built out-of-band by `mirror:init` (never on startup) and refreshed daily; a cold (never-initialized) index is a hard `ServiceUnavailable`, not a silent empty result. See the `api-mirror` skill for the MirrorService model.

**Owner-PII redaction is a first-class, fail-safe feature.** `FAA_REDACT_OWNER_PII` defaults to redacted; unset/empty/malformed resolves to redacted. When redacted, owner name/address are dropped from output AND owner-name search is disabled. The redaction gate (a single chokepoint in `registry-service`) and the baked `.mirror/` data are load-bearing — do not weaken either.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

All five tools are read-only, `openWorldHint: false` (no live network), and declare typed error contracts. Definitions live in `src/mcp-server/tools/definitions/`; the shared registration record schema + `format()` live in `_schemas.ts` (reused by the lookup tool and the resource).

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegistryService } from '@/services/registry/registry-service.js';
import { formatRegistrationRecord, registrationRecordSchema } from './_schemas.js';

export const lookupRegistrationTool = tool('faa_lookup_registration', {
  title: 'faa-aircraft-registry-mcp-server: lookup registration',
  description: 'Decode one US civil aircraft N-number to its full registration record …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    nNumber: z.string().min(1).describe('N-number to decode. Accepts "N12345" or "12345".'),
  }),
  output: registrationRecordSchema,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The N-number is well-formed but has no active registration in the MASTER file.',
      recovery: 'Call faa_get_registration_status to check deregistered/reserved, or faa_search_registrations.',
    },
  ],

  async handler(input, ctx) {
    const record = await getRegistryService().lookupRegistration(input.nNumber, ctx);
    if (!record) {
      throw ctx.fail('not_found', `No active registration for N-number "${input.nNumber}".`, {
        ...ctx.recoveryFor('not_found'),
      });
    }
    return record;
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Both surfaces must carry the same data; the linter enforces format-parity.
  format: (result) => [{ type: 'text', text: formatRegistrationRecord(result) }],
});
```

Coded fields surface BOTH the raw FAA code and the decoded label (`{ code, label? }` via `codedValueSchema`); permissible fields the FAA leaves blank are optional and rendered as absent, never fabricated.

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { registrationRecordSchema } from '@/mcp-server/tools/definitions/_schemas.js';
import { getRegistryService } from '@/services/registry/registry-service.js';

export const registrationResource = resource('faa://registration/{nNumber}', {
  name: 'faa-registration',
  title: 'faa-aircraft-registry-mcp-server: registration record',
  description: 'Full registration record for one N-number — same payload as faa_lookup_registration.',
  mimeType: 'application/json',
  params: z.object({
    nNumber: z.string().min(1).describe('N-number. Accepts "N12345" or "12345".'),
  }),
  output: registrationRecordSchema,

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The N-number is well-formed but has no active registration.',
      recovery: 'Use faa_get_registration_status for deregistered/reserved, or faa_search_registrations.',
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
```

This server has no prompts — it is a pure lookup/search/decode surface with no recurring multi-step interaction worth templating.

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  // Fail-safe: unset/empty/malformed coerces to 'true' (redacted) before stringbool sees it,
  // so only an explicit, well-formed false/0/no/off turns redaction off.
  redactOwnerPii: z
    .preprocess(redactToSafeDefault, z.stringbool())
    .describe('Fail-safe owner-PII redaction. Redacted unless explicitly set to a falsy value.'),
  mirrorPath: z.string().min(1).default('.mirror/faa-registry.db')
    .describe('Filesystem path to the SQLite registry index.'),
  databaseUrl: z.string().url().default('https://registry.faa.gov/database/ReleasableAircraft.zip')
    .describe('Source URL for the FAA ZIP (ingest-time only).'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    redactOwnerPii: 'FAA_REDACT_OWNER_PII',
    mirrorPath: 'FAA_MIRROR_PATH',
    databaseUrl: 'FAA_DATABASE_URL',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`FAA_REDACT_OWNER_PII`) not the path (`redactOwnerPii`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. The redaction flag is a privacy control: it must fail safe (default redacted) rather than throw or expose on a malformed value — hence the `preprocess` shim instead of a bare `.default()`.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'faa-aircraft-registry-mcp-server',   // machine name on every surface — never Title Case
  title: 'faa-aircraft-registry-mcp-server',  // display identity = the hyphenated repo name
  websiteUrl: 'https://github.com/cyanheads/faa-aircraft-registry-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions: 'Offline, keyless lookup of the US civil aircraft registry … The index must be built once via the mirror:init script before queries succeed.',
  setup(core) {
    initRegistryService({ /* redactOwnerPii, mirrorPath, databaseUrl */ });
    if (core.config.mcpTransportType === 'http') void scheduleDailyRefresh(); // daily mirror:refresh
  },
});
```

`name` and `title` are both the hyphenated machine name on every surface — never a Title Case display name; `description` is NOT passed here (it derives from `package.json`, the canonical source). `instructions` is session-level orientation sent on every `initialize` — here it notes the offline/keyless nature, the redaction default, and the `mirror:init` precondition. Daily refresh is scheduled only under HTTP transport (a long-lived process owns the cron); stdio operators run `mirror:refresh` out-of-band.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.fail` / `ctx.recoveryFor` | Throw a typed contract error by `reason` (`ctx.fail`); pull the declared `recovery` metadata for the throw site (`ctx.recoveryFor`). Used by every tool/resource. |
| `ctx.enrich` | Out-of-band response enrichment — `.truncated({ shown, cap })` when a search hits its limit, `.notice(msg)` when no rows match. Used by the search tools. |
| `ctx.signal` | `AbortSignal` for cancellation — threaded into the mirror sync run. |
| `ctx.requestId` | Unique request ID. |

This server is read-only over the local mirror: no `ctx.state` (the index is the store, accessed via `registry-service`), no `ctx.elicit` (no interactive input), no `ctx.progress` (no task-mode tools).

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The N-number is well-formed but has no active registration in the MASTER file.',
    recovery: 'Call faa_get_registration_status to check deregistered/reserved, or faa_search_registrations.' },
],
async handler(input, ctx) {
  const record = await getRegistryService().lookupRegistration(input.nNumber, ctx);
  if (!record) throw ctx.fail('not_found', `No active registration for "${input.nNumber}".`, { ...ctx.recoveryFor('not_found') });
  return record;
}
```

The cold-mirror case (a never-initialized index) is a service-layer `ServiceUnavailable` raised in `registry-service`, common to every tool — its recovery hint points to `mirror:init`. There is no live API fallback, so it surfaces loudly rather than returning an empty result.

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry; inits registry service, schedules daily refresh (HTTP)
  config/
    server-config.ts                    # FAA_REDACT_OWNER_PII / FAA_MIRROR_PATH / FAA_DATABASE_URL (Zod schema)
  services/
    registry/
      registry-service.ts               # MirrorService instance; query/join/decode + the PII redaction gate
      ingest.ts                         # sync ingester: download ZIP → parse MASTER-1..9 + ACFTREF/ENGINE/DEREG/RESERVED → pre-join
      zip.ts  csv.ts                     # ZIP extraction + comma-delimited parsing
      decode.ts                         # static decode maps (status, type, region, category, …) applied at query time
      normalize.ts                      # N-number normalizer (strip leading N, uppercase)
      schema.ts                         # sqliteMirrorStore column + FTS5 + index spec
      types.ts                          # domain types
  mcp-server/
    tools/definitions/
      _schemas.ts                       # shared registration-record schema + format() (lookup tool + resource)
      lookup-registration.tool.ts       # the 80% tool
      get-registration-status.tool.ts   # cross-file status resolver (active/deregistered/reserved/unknown)
      search-registrations.tool.ts      # FTS5 search of active registrations
      search-aircraft-types.tool.ts     # FTS5 search of the aircraft reference table
      get-aircraft-type.tool.ts         # decode a 7-char mfr/model/series code
    resources/definitions/
      registration.resource.ts          # faa://registration/{nNumber} (reuses the lookup handler)
scripts/
  faa-mirror-init.ts                    # mirror:init — full out-of-band build
  faa-mirror-refresh.ts                 # mirror:refresh — incremental/full rebuild
  faa-mirror-verify.ts                  # mirror:verify — readiness + integrity check
  _mirror-context.ts                    # shared mirror-instance shim for the three CLI scripts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService reference — the embedded SQLite + FTS5 mirror this server is built on (ingester, sync state, scheduling). Read before touching `registry-service` or the ingest path. |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `npm run tree` | Generate directory structure doc |
| `npm run format` | Auto-fix formatting (safe fixes only) |
| `npm run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `npm test` | Run tests |
| `bun run mirror:init` | Build the SQLite registry index from the FAA ZIP — full out-of-band build. Run once before first use; idempotent and resumable. Never on server startup. |
| `bun run mirror:refresh` | Rebuild the index from the latest FAA release. The HTTP server schedules this daily; stdio operators run it out-of-band. |
| `bun run mirror:verify` | Report index health — readiness, sync status, record count, SQLite integrity check. Exits non-zero when not ready or integrity fails. |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `npm run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';

// Server's own code — via path alias
import { getRegistryService } from '@/services/registry/registry-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; data access goes through `registry-service` (the mirror), never persistence directly
- [ ] Owner-PII redaction holds: PII fields dropped AND owner-name search disabled when redacted; the gate is the single chokepoint in `registry-service`
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `npm run devcheck` passes
