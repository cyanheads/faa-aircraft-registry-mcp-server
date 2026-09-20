<div align="center">
  <h1>@cyanheads/faa-aircraft-registry-mcp-server</h1>
  <p><b>Decode N-numbers to aircraft, engine, status, and owner; search the US civil aircraft registry by owner, type, or state; resolve active/deregistered/reserved status — offline via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.8-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/faa-aircraft-registry-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Ffaa-aircraft-registry-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faa-aircraft-registry-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/faa-aircraft-registry-mcp-server/releases/latest/download/faa-aircraft-registry-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=faa-aircraft-registry-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmFhLWFpcmNyYWZ0LXJlZ2lzdHJ5LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22faa-aircraft-registry-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffaa-aircraft-registry-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://faa-aircraft-registry.caseyjhand.com/mcp](https://faa-aircraft-registry.caseyjhand.com/mcp)

</div>

---

## Overview

The US civil aircraft registry, mirrored offline from the FAA's Releasable Aircraft Database — there is no live FAA registry API. Decode an N-number to its aircraft, engine, and registered owner; resolve active, deregistered, or reserved status; search by owner, make/model, state, or Mode S code; and decode manufacturer/model codes to full aircraft specs. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `faa_lookup_registration` | Decode one N-number to its full pre-joined active record — aircraft make/model, engine, year, airworthiness, registration status, Mode S code, and registered owner (when redaction is off). |
| `faa_get_registration_status` | Resolve an N-number across all three status files (active, deregistered, reserved) in priority order, returning a definitive `recordType`. |
| `faa_search_registrations` | Search active registrations by owner name, make/model, state, aircraft type, or Mode S code. |
| `faa_search_aircraft_types` | Search the aircraft reference table by manufacturer/model name, type, or category to discover manufacturer-model codes. |
| `faa_get_aircraft_type` | Decode a 6–7-character manufacturer/model/series code to aircraft specs — category, type, engine, seats, weight class, cruise speed, type-certificate data. |

### Resources

| Resource | Description |
|:---|:---|
| `faa://registration/{nNumber}` | Full registration record for one N-number — the same decoded, pre-joined payload as `faa_lookup_registration`. |

Also reachable via `faa_lookup_registration`; search collections aren't exposed as resources.

## Capability reference

### `faa_lookup_registration` <sub>tool</sub>

- Accepts `N12345` or `12345` — leading `N` optional, normalized before lookup
- Resolves `MASTER` → `ACFTREF` → `ENGINE` and decodes every coded field (aircraft type, engine type, status, airworthiness class, region) as both raw code and label
- Returns the Mode S code in octal and hex; hex is the ICAO 24-bit address used by flight-tracking feeds
- Owner name/address included only when `FAA_REDACT_OWNER_PII=false`; otherwise `ownerRedacted: true` flags that they were withheld
- Typed errors: `not_found` (well-formed but no active registration — use `faa_get_registration_status`), `invalid_n_number` (malformed input)

---

### `faa_get_registration_status` <sub>tool</sub>

- Checks active (`MASTER`), deregistered (`DEREG`), and reserved (`RESERVED`) files in priority order
- Discriminated `recordType`: `active`, `deregistered`, `reserved`, or `unknown` — a never-issued number resolves to `unknown`, not an error
- Branch-specific fields populate per state (active: status + airworthiness + dates; deregistered: cancel date + serial + mfr/model code; reserved: reservation type + reserve/expiration/purge dates)
- Owner-PII-free — status facts only
- Typed error: `invalid_n_number` for malformed input

---

### `faa_search_registrations` <sub>tool</sub>

- Filters: `ownerName`, `makeModel`, `state`, `aircraftType`, `modeSCode` — at least one required
- Owner-name search disabled when `FAA_REDACT_OWNER_PII` is on; typed `owner_search_disabled` error names the alternative filters
- `limit` 1–200 (default 25) and `offset` pagination; every response reports `totalCount`, and a truncated page carries `nextOffset`
- Each result carries an N-number to pass to `faa_lookup_registration` for full detail
- Typed error: `no_filters` when no filter is supplied

---

### `faa_search_aircraft_types` <sub>tool</sub>

- Filters: `query` (manufacturer/model name, full-text), `aircraftType` code, `category` code — at least one required
- Returns reference summaries with the code to pass to `faa_get_aircraft_type`
- `limit` 1–200 (default 25) and `offset` pagination; every response reports `totalCount`, and a truncated page carries `nextOffset`
- Typed error: `no_filters` when no filter is supplied

---

### `faa_get_aircraft_type` <sub>tool</sub>

- Accepts a 6–7-character uppercase alphanumeric manufacturer/model/series code
- Returns manufacturer, model, aircraft type, engine type, category, builder certification, seats, engines, weight class, cruise speed, and type-certificate data
- Discover codes by name first via `faa_search_aircraft_types`
- Typed errors: `not_found` (well-formed code, no reference record), `invalid_code` (malformed input)

---

### `faa://registration/{nNumber}` <sub>resource</sub>

- Same payload as `faa_lookup_registration` — `application/json`, cached 1 hour, private scope
- `nNumber` accepts `N12345` or `12345` (leading `N` optional)
- Typed errors: `not_found`, `invalid_n_number` — same conditions as the tool

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAA registry-specific:

- Offline and keyless at runtime — every query hits the local SQLite + FTS5 index; no API key, no runtime network, no rate limit
- Built on the framework `MirrorService`: `mirror:init` builds the index out-of-band, and the HTTP server schedules a daily refresh aligned to the FAA's nightly re-release
- Pre-joined `MASTER` → `ACFTREF` → `ENGINE` records — one call returns decoded aircraft, engine, and status instead of raw join codes
- Fail-safe owner-PII redaction — defaults on, drops owner name/address from output, and disables owner-name search while active
- Composes with live flight-tracking feeds — the Mode S hex code returned here is the ICAO 24-bit address that OpenSky and similar feeds key on

Agent-friendly output:

- Coded fields surface both the raw FAA code and the decoded label — the label for reasoning, the code so nothing is lost
- Truncation disclosure — search tools flag `truncated` with `shown`/`cap` when the result set is capped, so a partial page is never read as the whole
- Permissible-field honesty — fields the FAA leaves blank (year, cruise speed, co-owner names) stay absent rather than fabricated
- Discriminated output — `recordType` and `ownerRedacted` flags let callers branch on data, not string parsing

## Getting started

### Public Hosted Instance

A public instance is available at `https://faa-aircraft-registry.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "faa-aircraft-registry-mcp-server": {
      "type": "streamable-http",
      "url": "https://faa-aircraft-registry.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

> **First run requires building the local index — see [First-run setup](#first-run-setup) below.** The package does not ship the FAA data; until `mirror:init` has run once, queries fail with a clear "run mirror:init" error.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "faa-aircraft-registry-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/faa-aircraft-registry-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FAA_MIRROR_PATH": "/path/to/faa-registry.db"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "faa-aircraft-registry-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/faa-aircraft-registry-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FAA_MIRROR_PATH": "/path/to/faa-registry.db"
      }
    }
  }
}
```

Or with Docker (mount a volume at `/usr/src/app/.mirror` so the built index persists across containers — build it once with `docker exec … bun run mirror:init`):

```json
{
  "mcpServers": {
    "faa-aircraft-registry-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-v", "faa-registry:/usr/src/app/.mirror",
        "ghcr.io/cyanheads/faa-aircraft-registry-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

`FAA_MIRROR_PATH` points the server at the index that `mirror:init` builds — set it to a persistent path so the index survives across runs. Owner PII is redacted by default; set `FAA_REDACT_OWNER_PII=false` only on a trusted local install to expose owner detail.

### First-run setup

The FAA Releasable Aircraft Database is not bundled with the package — it is a public dataset (~70 MB compressed, refreshed daily by the FAA) that the operator downloads and indexes once before first use. Building the index produces a local SQLite file of a few hundred MB.

After installing, build the index out-of-band (never on server startup — a full parse of ~1M rows must not block start):

```sh
# Build the local index from the live FAA download (idempotent, resumable)
FAA_MIRROR_PATH=/path/to/faa-registry.db bun run mirror:init

# Verify it built (readiness + integrity check)
FAA_MIRROR_PATH=/path/to/faa-registry.db bun run mirror:verify

# Rebuild from the latest FAA release (run on a schedule, or out-of-band for stdio)
FAA_MIRROR_PATH=/path/to/faa-registry.db bun run mirror:refresh
```

- **Keep the path stable.** Point `FAA_MIRROR_PATH` (and the same env var in your MCP client config) at a persistent location so the built index is reused across runs. Default: `.mirror/faa-registry.db`.
- **Daily refresh.** Under HTTP transport the server schedules a daily `mirror:refresh` aligned to the FAA's nightly re-release (~11:30 PM Central). If an interrupted rebuild leaves the index empty, queries fail loudly with `ServiceUnavailable` until the rebuild succeeds. Under stdio, run `mirror:refresh` out-of-band (e.g. a cron job).
- **Docker.** The image ships the mirror CLI and a writable `.mirror` data directory owned by the runtime user. Mount a volume there and run `mirror:init` once (e.g. `docker exec <container> bun run mirror:init`, or a one-shot init job against the shared volume) so the index persists across container restarts.
- **Until the index exists,** every query fails with a `ServiceUnavailable` error whose recovery hint points to `mirror:init` — there is no live API to fall back to, so the cold state surfaces loudly rather than returning empty results.

The source URL is overridable via `FAA_DATABASE_URL` (for a private or cached mirror); it is read only at ingest time, never per request.

### Prerequisites

- [Bun v1.4](https://bun.sh/) or higher (or Node.js v24+). `bun:sqlite` is built into Bun; a Node-only deployment adds `better-sqlite3` (already declared as an optional peer dependency).
- Disk space for the built index (a few hundred MB) at `FAA_MIRROR_PATH`.
- Network access at `mirror:init` / `mirror:refresh` time to download the FAA ZIP. Not needed at query time.

### Installation

For local development or self-hosting from source:

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/faa-aircraft-registry-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd faa-aircraft-registry-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Build the index** (see [First-run setup](#first-run-setup)):

```sh
bun run mirror:init
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `FAA_REDACT_OWNER_PII` | Redact owner name/address from output and disable owner-name search. Fail-safe: unset, empty, or malformed resolves to redacted. Set `false` only on a trusted local install. | `true` |
| `FAA_MIRROR_PATH` | Filesystem path to the SQLite index file. Point at a persistent path; mount a volume here in production. | `.mirror/faa-registry.db` |
| `FAA_DATABASE_URL` | Source URL for the FAA Releasable Aircraft Database ZIP, used by `mirror:init` / `mirror:refresh` only. Overridable for a private/cached mirror; never read at request time. | FAA registry ZIP |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | Session mode: `auto` (resolves to stateful), `stateful`, or `stateless`. The server declares `stateless` in source because it has no multi-round-trip input; setting this overrides that declaration. | `stateless` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Owner-PII redaction

The FAA registry is releasable public record, but `MASTER`, `DEREG`, and `RESERVED` carry registrant **names and physical addresses** (deregistered records carry both mailing and physical address blocks plus co-owner names). This server ships a first-class redaction mode, **redacted by default**:

- `FAA_REDACT_OWNER_PII` defaults to `true`. Unset, empty, or malformed all resolve to redacted, so a deployment can never leak PII by omission or misconfiguration.
- When redacted: registrant name, street/physical address, and co-owner names are dropped from every output, **and owner-name search is disabled** (`faa_search_registrations` rejects `ownerName`). Disabling search matters — output-hiding alone would let an agent confirm a person↔aircraft link by probing the search input.
- Aircraft facts (make/model/engine/year/specs) and registration status still flow, with `ownerRedacted: true` on every affected payload.
- Full owner detail requires explicitly setting `FAA_REDACT_OWNER_PII=false` — appropriate for a trusted local or self-hosted install, not a shared endpoint.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Build the local index (see First-run setup)
  bun run mirror:init

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t faa-aircraft-registry-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 \
  -v faa-registry:/usr/src/app/.mirror faa-aircraft-registry-mcp-server
# Build the index once against the mounted volume:
docker run --rm -v faa-registry:/usr/src/app/.mirror faa-aircraft-registry-mcp-server bun run mirror:init
```

The Dockerfile defaults to HTTP transport with stateless sessions, ships the `mirror:init`/`mirror:refresh`/`mirror:verify` CLI, pre-creates a writable `.mirror` data directory owned by the runtime user (mount a volume there and run `mirror:init` once to build and persist the index), and logs to `/var/log/faa-aircraft-registry-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and the resource, inits the registry service, and schedules the daily refresh under HTTP transport. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/registry` | Registry service — the SQLite + FTS5 mirror, ingester, decode maps, N-number normalizer, and the owner-PII redaction gate. |
| `scripts/faa-mirror-*.ts` | Mirror lifecycle CLI — `mirror:init`, `mirror:refresh`, `mirror:verify`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- The registry index is the source of truth at runtime — there is no upstream API to retry; build and refresh it out-of-band, and never fabricate a value from a blank upstream field

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

The FAA Releasable Aircraft Database is a public-domain US Government work, published by the FAA Civil Aviation Registry. This project redistributes none of that data; operators download it directly from the FAA at install time.
