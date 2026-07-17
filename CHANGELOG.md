# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-16

An interrupted mirror rebuild that leaves the index empty now fails loud with ServiceUnavailable instead of serving empty results as healthy, and the mirror CLI scripts now emit their logging output instead of dropping it silently.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-07-16

Rejects malformed N-numbers and aircraft codes with an actionable validation error instead of a misleading not-found/unknown answer, and blanks the FAA's 0-sentinel numeric fields (cruise speed, year manufactured, seats) instead of rendering them as real values.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-07-16

Bounds registry rebuild peak memory to the largest single file via lazy ZIP inflation, streamed line parsing, and chunked auxiliary transactions (measured ~2.35 GiB to ~0.74 GiB); syncs the Dockerfile OCI description label to package.json.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-07-15 · 🛡️ Security

Column-scopes faa_search_registrations FTS matching to close a PII-redaction bypass, adds offset pagination to both search tools, corrects 'bundled registry' description drift, and adopts mcp-ts-core ^0.10.14 with a bun install supply-chain guard.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-20

Maintenance: @cyanheads/mcp-ts-core ^0.10.6 → ^0.10.9, direct + transitive dependency refresh, re-synced agent skills and devcheck scripts, devcheck.config packaging.pluginManifests flag

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-15

Public hosted endpoint at faa-aircraft-registry.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Metadata polish — action-first package and plugin descriptions, npm-scoped README header, and a repository field on the MCPB manifest.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release — offline FAA civil aircraft registry: decode N-numbers, search registrations and aircraft types, resolve active/deregistered/reserved status, with fail-safe owner-PII redaction over an embedded SQLite + FTS5 mirror.
