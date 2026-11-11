<div align="center">
<h1>@cyanheads/faa-aircraft-registry-mcp-server</h1>
  <p><b>Decode N-numbers to aircraft, engine, status, and owner; search the US civil aircraft registry by owner, type, or state; resolve active/deregistered/reserved status — offline via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Registration Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/faa-aircraft-registry-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Ffaa-aircraft-registry-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/faa-aircraft-registry-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

The US civil aircraft registry, searchable offline from the FAA's Releasable Aircraft Database. Decode an N-number to its aircraft, engine, and registered owner; check its current state and cancellation history; and search by serial number, make and model, state, Mode S code, or owner when redaction is off.

### Tools

| Tool | Description |
|:---|:---|
| `faa_lookup_registration` | Decode one active N-number to aircraft, engine ratings, approved operations, registration dates, Mode S code, and registered owner when redaction is off. |
| `faa_get_registration_status` | Resolve current state in active → reserved → deregistered order, with cancellation history for the N-number. |
| `faa_search_registrations` | Search active registrations by serial number, owner name, make/model, exact manufacturer/model code, state, aircraft type, or Mode S code. |
| `faa_search_aircraft_types` | Search the aircraft reference table by manufacturer/model name, type, or category to discover manufacturer-model codes. |
| `faa_get_aircraft_type` | Decode a 6–7-character manufacturer/model/series code to aircraft specs — category, type, engine, seats, weight class, cruise speed, type-certificate data. |

### Resources

| Resource | Description |
|:---|:---|
| `faa://registration/{nNumber}` | Full registration record for one N-number — the same decoded, pre-joined payload as `faa_lookup_registration`. |

The registration resource returns the same domain fields as `faa_lookup_registration`. Search results are available through the tools.

The [FAA registry guide](skills/faa-aircraft-registry-guide/SKILL.md) covers model-code discovery, serial disambiguation, snapshot-aware paging, and N-number reassignment. It ships with plugin, npm, Docker, and MCPB installs and is available over MCP as `skill://faa-aircraft-registry-guide/SKILL.md`.

## Capability reference

### `faa_lookup_registration` <sub>tool</sub>

- Accepts `N12345` or `12345`; the leading `N` is optional
- Returns decoded aircraft, engine, and status fields as raw code plus label, and the Mode S code in octal and hex (hex is the ICAO 24-bit address)
- Preserves `approvedOperationsRaw` and decodes operations using the airworthiness class; unknown codes retain their raw value without a label
- Includes known per-engine `engineHorsepower` and `engineThrustLbs`; zero or missing ratings stay absent
- Owner name and address appear only when `FAA_REDACT_OWNER_PII=false`; otherwise `ownerRedacted: true`
- Errors: `not_found` (no active registration; try `faa_get_registration_status`), `invalid_n_number`

---

### `faa_get_registration_status` <sub>tool</sub>

- Checks the active, reserved, and deregistered files in that order
- `recordType` is `active`, `deregistered`, `reserved`, or `unknown`; a number absent from the snapshot returns `unknown`, not an error
- Includes available `cancellations` newest first, with aircraft identity and export country when known. An N-number can be reassigned, so its history can span different airframes
- A cancellation row's status is the status recorded on that row, not the current registration state or a cancellation cause; no owner data is returned
- Error: `invalid_n_number`

---

### `faa_search_registrations` <sub>tool</sub>

- Filters: `ownerName`, `makeModel`, `manufacturerModelCode`, `serialNumber`, `state`, `aircraftType`, `modeSCode`; at least one required, combined with AND
- Make/model terms match token prefixes, so `Cessna 172` includes variants such as 172S. Owner terms retain whole-token matching
- Serial matching is exact after trimming and ignores case; leading zeros, punctuation, and internal spaces remain significant. Serials can repeat across manufacturers; combine with a model filter to narrow them
- `limit` defaults to 25 and clamps to 200 with a notice; `FAA_CLAMP_LIMITS=false` rejects larger requests. Responses report `totalCount` and `nextOffset` for `offset` paging
- Each result carries an N-number to pass to `faa_lookup_registration`
- Errors: `no_filters`, `invalid_code`, `invalid_state`, `invalid_mode_s_code`, `invalid_aircraft_type`, and `owner_search_disabled` (owner-name search is off while `FAA_REDACT_OWNER_PII` is on)

---

### `faa_search_aircraft_types` <sub>tool</sub>

- Filters: `query` (manufacturer/model token prefixes), `aircraftType` (1–9/H/O), `category` (1–3); at least one required
- Returns summaries with the code to pass to `faa_get_aircraft_type` or `faa_search_registrations.manufacturerModelCode`
- `limit` defaults to 25 and clamps to 200 with a notice; `FAA_CLAMP_LIMITS=false` rejects larger requests. Responses report `totalCount` and `nextOffset` for `offset` paging
- Errors: `no_filters`, `invalid_aircraft_type`, `invalid_category`

---

### `faa_get_aircraft_type` <sub>tool</sub>

- Accepts a 6–7-character uppercase alphanumeric manufacturer/model/series code; find codes with `faa_search_aircraft_types`
- Returns manufacturer, model, type, engine, category, seats, engines, weight class, cruise speed, and type-certificate data
- `weightClass` keeps the raw FAA string; `weightClassLabel` decodes it when known
- Errors: `not_found`, `invalid_code`

---

### `faa://registration/{nNumber}` <sub>resource</sub>

- Same domain payload as `faa_lookup_registration`; `application/json` with a one-hour private cache hint. Tool freshness enrichment is not included
- `nNumber` accepts `N12345` or `12345`
- Errors: `not_found`, `invalid_n_number`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FAA registry-specific:

- Offline and keyless at runtime: queries hit a local SQLite + FTS5 index with no API key or rate limit
- Daily index refresh under HTTP transport, aligned to the FAA's nightly re-release
- Pre-joined records: one call returns decoded aircraft, engine, and status
- Owner name and address are redacted by default, and owner-name search is disabled until `FAA_REDACT_OWNER_PII=false`
- Builder names identified from registrant records are withheld from aircraft output and matching under redaction, including repeated kit-manufacturer names. Public manufacturer names and model-only searches remain available
- A rebuild is unavailable to readers until it completes; a failed rebuild cannot serve partial registry results
- Mode S hex codes match the ICAO 24-bit addresses used by flight-tracking feeds

Agent-friendly output:

- Coded fields carry both the raw FAA code and the decoded label
- Capped search results flag `truncated` with `shown` and `cap`
- Fields the FAA leaves blank stay absent rather than filled in
- `recordType` and `ownerRedacted` let callers branch on data
- Successful tools include `dataAsOf` when the source archive date is known, with a refresh notice when it is more than seven days old. Missing dates are disclosed, never replaced by the local build time

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

The Desktop MCPB includes Node's SQLite driver and its cross-platform prebuilts. Build the local index with the bundle's mirror CLI before querying.

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

Build the index out-of-band (never on server startup — a full parse of ~1M rows must not block start). From a source checkout, run `bun install && bun run build` first. Then, from the checkout, installed package directory, or extracted MCPB directory, run the compiled commands below. Node and Bun both work; replace `node` with `bun` to use Bun's built-in SQLite. The Docker image supports `bun run mirror:init`, `mirror:verify`, and `mirror:refresh`.

```sh
# Build the local index from the FAA download
FAA_MIRROR_PATH=/path/to/faa-registry.db node dist/cli/faa-mirror-init.js

# Verify it built (readiness + integrity check)
FAA_MIRROR_PATH=/path/to/faa-registry.db node dist/cli/faa-mirror-verify.js

# Rebuild from the latest FAA release (run on a schedule, or out-of-band for stdio)
FAA_MIRROR_PATH=/path/to/faa-registry.db node dist/cli/faa-mirror-refresh.js
```

- **Keep the path stable.** Point `FAA_MIRROR_PATH` (and the same env var in your MCP client config) at a persistent location so the built index is reused across runs. Default: `.mirror/faa-registry.db`.
- **Daily refresh.** Under HTTP transport the server schedules a daily `mirror:refresh`. From the first table replacement until successful completion, queries return retryable `ServiceUnavailable` (`mirror_loading`). An interrupted rebuild stays unavailable until a refresh succeeds. A download or archive-manifest failure before replacement preserves the complete index. Under stdio, run `mirror:refresh` out-of-band (e.g. a cron job).
- **Existing indexes.** Run `mirror:refresh` after upgrading to populate manufacturer classification, source date, and cancellation fields. Until classification is known, redacted queries conservatively withhold non-type-certificated manufacturer names. Use matching server and CLI versions when refreshing the same database.
- **Recovery after a process exit.** An immediate refresh can return `sync_locked` while the interrupted writer's lease remains valid. Wait for the lease to expire, then rerun `mirror:refresh`.
- **Docker.** The image ships the mirror CLI and a writable `.mirror` data directory owned by the runtime user. Mount a volume there and run `mirror:init` once (e.g. `docker exec <container> bun run mirror:init`, or a one-shot init job against the shared volume) so the index persists across container restarts.
- **Until the index exists,** every query fails with a `ServiceUnavailable` error whose recovery hint points to `mirror:init` — there is no live API to fall back to, so the cold state surfaces loudly rather than returning empty results.

The source URL is overridable via `FAA_DATABASE_URL` (for a private or cached mirror); it is read only at ingest time, never per request.

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+). Bun uses built-in `bun:sqlite`. Node uses the included `better-sqlite3` dependency, with bundled N-API prebuilts for macOS, Windows, and Linux (glibc/musl), on x64 and arm64.
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

4. **Compile the server and build the index** (see [First-run setup](#first-run-setup)):

```sh
bun run build
bun run mirror:init
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `FAA_REDACT_OWNER_PII` | Redact owner identity and matching builder names, and disable owner-name search. Unset, empty, or malformed counts as `true`. | `true` |
| `FAA_CLAMP_LIMITS` | Clamp search limits above 200 with a notice; `false` restores strict rejection. | `true` |
| `FAA_MIRROR_PATH` | Path to the SQLite index file; use a persistent location. | `.mirror/faa-registry.db` |
| `FAA_DATABASE_URL` | Source URL for the FAA database ZIP, read only by `mirror:init` / `mirror:refresh`. | FAA registry ZIP |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | Session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). Relative paths resolve from the server package. | `<server-package-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result (cap: `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES`, default `16384`). | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

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
  bun run test       # Vitest unit and integration tests
  bun run test:package # npm tarball + cleaned MCPB runtime checks
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
| `src/cli/` | Mirror lifecycle CLI — compiled to `dist/cli/` for `mirror:init`, `mirror:refresh`, `mirror:verify`. |
| `skills/` | Published guide for agents using the FAA tools. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

The FAA Releasable Aircraft Database is a public-domain US Government work, published by the FAA Civil Aviation Registry. This project redistributes none of that data; operators download it directly from the FAA at install time.
