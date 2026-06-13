# faa-aircraft-registry-mcp-server — Design

The US civil aircraft registry as an offline lookup server. Decode an N-number to its
aircraft, make/model, engine, and registered owner; search the registry by owner, type, or
state; decode manufacturer/engine codes to specs; and resolve registration/airworthiness
status across active, deregistered, and reserved records — all from the FAA's public-domain
Releasable Aircraft Database, indexed on disk as SQLite + FTS5. Keyless, no runtime API.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `faa_lookup_registration` | The 80% tool. Decode one N-number to its full pre-joined record — aircraft make/model, engine, year, registered owner, airworthiness, and registration status. One call resolves the MASTER → ACFTREF → ENGINE join and decodes all coded fields. | `nNumber` (string, "N12345" or "12345") | `readOnlyHint: true`, `openWorldHint: false` |
| `faa_search_registrations` | Search active registrations by owner name, make/model, state, aircraft type, or Mode S code. FTS5 over the bundled registry; results are decoded summaries with N-numbers for follow-up `faa_lookup_registration` calls. | `ownerName?`, `makeModel?`, `state?`, `aircraftType?`, `modeSCode?`, `limit?` | `readOnlyHint: true`, `openWorldHint: false` |
| `faa_search_aircraft_types` | Search the aircraft reference table by manufacturer/model name, category, or aircraft type to discover manufacturer-model codes and browse specs. Fills the discovery gap before `faa_get_aircraft_type`. | `query?`, `aircraftType?`, `category?`, `limit?` | `readOnlyHint: true`, `openWorldHint: false` |
| `faa_get_aircraft_type` | Decode a 7-char manufacturer/model/series code to aircraft specs — make, model, category, aircraft type, engine type, engine count, seats, weight class, cruise speed, type-certificate data. | `code` (7-char alphanumeric) | `readOnlyHint: true`, `openWorldHint: false` |
| `faa_get_registration_status` | Resolve registration + airworthiness status for an N-number across all three status files — active (MASTER), deregistered (DEREG), reserved (RESERVED) — returning a definitive `recordType` instead of a not-found when a number is known-but-inactive. | `nNumber` (string, "N12345" or "12345") | `readOnlyHint: true`, `openWorldHint: false` |

5 tools. All read-only, deterministic against the local index, `openWorldHint: false` (no live network at runtime).

### Tool error contracts

Declared inline per tool as `errors: [{ reason, code, when, recovery }]` so `ctx.fail(reason, …)`
is type-checked and capable clients preview failures via `tools/list`. Baseline codes
(`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`)
bubble without declaring — the cold-index case below is one shared `ServiceUnavailable` raised
in the service layer, common to every tool.

| Tool | reason | code | when | recovery |
|:-----|:-------|:-----|:-----|:---------|
| `faa_lookup_registration` | `not_found` | `NotFound` | N-number normalized and valid but no active MASTER record | Call `faa_get_registration_status` to check if it is deregistered or reserved, or `faa_search_registrations` to find the right N-number. |
| `faa_lookup_registration` | `owner_redacted` | *(not an error — `ownerRedacted: true` flag on success)* | — | — |
| `faa_search_registrations` | `owner_search_disabled` | `InvalidParams` | `ownerName` supplied while `FAA_REDACT_OWNER_PII` is on | Drop the ownerName filter — owner-name search is disabled on this deployment. Search by makeModel, state, aircraftType, or modeSCode instead. |
| `faa_search_registrations` | `no_filters` | `InvalidParams` | No search filter supplied | Provide at least one of makeModel, state, aircraftType, or modeSCode (ownerName when PII is unredacted). |
| `faa_search_aircraft_types` | `no_filters` | `InvalidParams` | No search filter supplied | Provide a query, aircraftType, or category to search the reference table. |
| `faa_get_aircraft_type` | `not_found` | `NotFound` | 7-char code well-formed but absent from ACFTREF | Use `faa_search_aircraft_types` to discover valid manufacturer-model codes by name. |
| `faa_get_registration_status` | *(none — `recordType: 'unknown'` is a valid success)* | — | — | — |

The cold-mirror case (a never-initialized index) is a service-layer `ServiceUnavailable` with
recovery `Run the mirror:init script to build the local FAA registry index before querying.` —
there is no live API fallback, so it surfaces loudly rather than returning an empty result.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `faa://registration/{nNumber}` | Read-once full registration record for one N-number (same payload as `faa_lookup_registration`). Convenience for clients that inject resources as context; the tool is the reliable path. | None (single record) |

### Prompts

None. This is a data/lookup server with no recurring multi-step interaction pattern worth templating.

---

## Overview

**What it wraps.** The FAA Releasable Aircraft Database — the entire US civil aircraft
registry, published by the FAA Civil Aviation Registry (AFS-750) as a public-domain bulk
download (`https://registry.faa.gov/database/ReleasableAircraft.zip`). The ZIP contains
comma-delimited `.txt` files. **As of at least January 2026 the registration master is split
into nine parts** (`MASTER-1.txt` through `MASTER-9.txt`, ~20 MB each) rather than a single
`MASTER.txt` — the ingestor must enumerate all nine. Other files: `ACFTREF.txt` (aircraft
make/model/series reference), `ENGINE.txt` (engine reference), `DEREG.txt` (deregistered
aircraft), `RESERVED.txt` (reserved N-numbers), plus `DEALER.txt` and `DOCINDEX.txt` (out of
scope). Refreshed daily at 11:30 PM Central.

**The shape of the work.** `MASTER` references `ACFTREF` and `ENGINE` by code; the registry
is a relational join, not a flat lookup. The server pre-joins all three into a single SQLite
index with FTS5 search columns, so a single lookup returns "2008 Cessna 172S, Lycoming
IO-360, valid registration" rather than raw codes. There is **no keyless live FAA JSON API**
— `registry.faa.gov/aircraftinquiry` is a human web portal only (verified read-only) — so the
on-disk index is not just the primary path, it is the *only* viable programmatic path. That
makes the bulk dataset the heart of the server.

**Who it's for.** Aviation journalists and OSINT researchers (jet-tracking, ownership
tracing), enthusiasts and spotters, the aviation/MRO industry, and agents resolving a tail
number or Mode S address seen in live flight data. Composes with `opensky` (live positions
keyed on registration / ICAO 24-bit Mode S address — this server is the decode step),
`ourairports` (base airport), and loosely `nhtsa-vehicle-safety` (the road-vehicle analog).

**US-only by design.** This is the FAA civil registry; other national registries are separate
and mostly not bulk-published. The `faa-` name makes the scope obvious.

---

## Requirements

- **Read-only.** No writes, no mutations. Every tool is `readOnlyHint: true`,
  `openWorldHint: false`.
- **Keyless, offline at runtime.** No API key, no runtime network dependency. All queries hit
  the local SQLite + FTS5 index.
- **N-number normalization.** Accept `N12345` or `12345`; uppercase and strip the leading `N`
  before lookup (the registry stores numbers without it). A known-but-inactive number resolves
  to its deregistered/reserved status, never a bare not-found.
- **Relational decode.** Pre-join `MASTER → ACFTREF → ENGINE` at ingest. Decode every coded
  field at query time using the authoritative `ardata.pdf` value tables (type-registrant,
  status code, type-aircraft, type-engine, region, aircraft category, builder-cert,
  airworthiness class — see Appendix). Surface both the raw code and the decoded label so the
  agent gets human-readable values without losing the canonical code.
- **REQUIRED — env-gated owner-PII redaction, fail-safe.** The registry is releasable public
  record, but `MASTER`, `DEREG`, and `RESERVED` carry registrant **names and physical
  addresses** (DEREG carries both mailing *and* physical address blocks plus five co-owner
  names; see Appendix). The server ships a first-class redaction mode controlled by
  `FAA_REDACT_OWNER_PII`, **redacted by default** — unset, empty, or malformed resolves to
  redacted, so a deployment can never leak PII by omission. When redacted: (a) drop registrant
  name, street/physical address, and all co-owner (`otherNames`) fields from every output, and
  (b) **disable owner-name search** (reject `ownerName` on `faa_search_registrations`) —
  otherwise an agent could confirm "X owns aircraft Y" by probing the search input even with
  output hidden. Aircraft facts (make/model/engine/year/specs) and registration status still
  flow, with `ownerRedacted: true` on every affected payload so the agent knows data was
  withheld and why. Full owner detail requires explicitly setting `FAA_REDACT_OWNER_PII=false`
  — fine for local/self-host, never the public hosted endpoint.
- **Public-domain, no licensing blocker.** US Government work, no copyright, no
  anti-redistribution or anti-AI clause. The only consideration is the owner PII above,
  resolved by the redaction feature. The FAA's own privacy provisions (49 U.S.C. § 44114(b)
  withholding requests, the Privacy ICAO Address program) are the upstream precedent — and the
  authoritative basis cited on page 1 of `ardata.pdf`.
- **Hostable with redaction on (DECISION 2026-06-02).** The public endpoint runs at the safe
  (redacted) default and never serves names/addresses; local/self-host installs opt into full
  detail. "Treat public surfaces as fully public" is satisfied by what the endpoint actually
  returns: aircraft identity, not owner PII. Ships to npm for local use either way.
- **Truncation disclosure.** Search tools accept `limit`; when the cap is hit, disclose via
  `ctx.enrich.truncated({ shown, cap })` so the agent never treats a partial result set as
  complete.
- **No DataCanvas.** This is a decode/search surface (find-the-record-then-drill-in over
  categorical metadata), not an analytical row set an agent would run SQL over. It fails the
  "earns its keep on shape, not size" gate. Inline results only.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `registry-service` | The on-disk SQLite + FTS5 index built from the FAA Releasable Aircraft Database (`MASTER-1`…`MASTER-9`, `ACFTREF`, `ENGINE`, `DEREG`, `RESERVED`). Built via the framework `MirrorService` (`defineMirror` + `sqliteMirrorStore`). Owns query, join, decode, and PII redaction. | All 5 tools, the resource |

This is a **server-as-source** design — the index is the source of truth at runtime, there is
no upstream API to retry. The framework resilience table (retry/backoff/parse-classification)
does not apply; the design questions are ingest, indexing, and refresh instead.

### Backend choice — MirrorService (SQLite + FTS5)

The corpus sits squarely in the embedded-SQLite tier the `MirrorService` targets (10⁴–10⁷
rows): ~300k active `MASTER` rows, ~90k `ACFTREF`, ~3k `ENGINE`, several-hundred-thousand
`DEREG`, plus `RESERVED`. That rules out a pure in-memory index (too large to hold comfortably
and to rebuild per process) and is far below the external-store threshold. SQLite + FTS5 gives
the relational join (`MASTER`→`ACFTREF`→`ENGINE`), full-text owner/make-model search, and
indexed exact lookups (N-number, Mode S code, mfr-model code) in one embedded file with zero
runtime services. `bun:sqlite` is built into the Bun runtime (the Docker base and dev
runtime), so the primary path needs no native dependency; a Node-only deployment adds
`better-sqlite3` as an optional peer. The mirror is unavailable on Cloudflare Workers (no
SQLite / no persistent FS) — this server targets stdio + Node/Bun HTTP, not Workers.

### Ingest strategy — built at image-build, refreshed daily

The dataset is one ~1M-row corpus that changes daily but is queried far more than it changes —
the canonical "mirror a bulk upstream" case. Two competing framings from the brief
("bakes into the image" vs "MirrorService") reconcile cleanly:

- **Build the index out-of-band, never on server startup.** A `mirror:init` CLI script
  downloads `ReleasableAircraft.zip`, parses the thirteen `.txt` files (nine MASTER parts +
  ACFTREF + ENGINE + DEREG + RESERVED), pre-joins, and writes the SQLite file. Run it during
  Docker image build (or a one-shot job), so the image ships with a warm index and the server
  starts instantly. Init is idempotent and resumable.
- **Refresh on a daily schedule.** Register `mirror:refresh` on a cron via `schedulerService`
  inside `setup()` (gated to HTTP transport so stdio operators run it out-of-band), aligned to
  the FAA's 11:30 PM Central re-release. A refresh rebuilds from the latest ZIP; the index
  stays transactionally queryable throughout.
- **Read path gated on `mirror.ready()`.** `ready` is true once a full init has ever completed
  — the mirror keeps serving during/after a refresh. There is no live API to fall back to, so
  a cold (never-initialized) index is a hard `ServiceUnavailable` with a recovery hint to run
  `mirror:init`, not a silent empty result.

The scaffold already anticipates this: the `Dockerfile` pre-creates the writable `.mirror`
data dir owned by the runtime user and carries the commented-out mirror-CLI stanza from the
`api-mirror` skill. Implementation un-comments that stanza and adds the three lifecycle
scripts (`mirror:init`, `mirror:refresh`, `mirror:verify`) plus the `_mirror-context.ts` shim
to `package.json` `files[]`.

### Index schema (mirror store)

One primary table plus the two reference tables, joined at ingest into a denormalized
registration row for fast single-call lookup, with FTS5 over the searchable text columns.

- **`registration`** (from `MASTER`, pre-joined with decoded `ACFTREF`/`ENGINE` labels):
  `n_number` (PK, normalized, no leading N), `serial_number`, `mfr_mdl_code`, `eng_mfr_mdl_code`,
  `make`, `model`, `aircraft_type_code`, `engine_type_code`, `engine_make`, `engine_model`,
  `year_mfr`, `type_registrant_code`, `owner_name`, `street`, `street2`, `city`, `state`,
  `zip`, `region_code`, `county`, `country`, `last_action_date`, `cert_issue_date`,
  `airworthiness_class_code`, `approved_operations_raw`, `status_code`, `mode_s_code_octal`,
  `mode_s_code_hex`, `fractional_owner`, `airworthiness_date`, `other_names` (JSON array, 1–5),
  `expiration_date`, `unique_id`, `kit_mfr`, `kit_model`.
  - **FTS5 columns:** `owner_name`, `make`, `model`, `other_names`, `city`.
  - **Indexes:** `n_number` (unique), `mode_s_code_hex`, `mfr_mdl_code`, `state`,
    `aircraft_type_code`.
- **`aircraft_ref`** (from `ACFTREF`): `code` (PK, 7-char), `mfr`, `model`, `aircraft_type_code`,
  `engine_type_code`, `category_code`, `builder_cert_code`, `num_engines`, `num_seats`,
  `weight_class_code`, `cruise_speed`, `tc_data_sheet`, `tc_data_holder`.
  - **FTS5 columns:** `mfr`, `model`. **Index:** `aircraft_type_code`, `category_code`.
- **`engine_ref`** (from `ENGINE`): `code` (PK, 5-char), `mfr`, `model`, `engine_type_code`,
  `horsepower`, `thrust`.
- **`dereg`** (from `DEREG`, status-resolution only — not searched): `n_number` (indexed),
  `serial_number`, `mfr_mdl_code`, `status_code`, `cancel_date`, `mode_s_code_hex`, plus
  mailing-address fields (`owner_name`, `street`, `street2`, `city`, `state`, `zip`) and a
  separate physical-address block (`physical_address`, `physical_address2`, `physical_city`,
  `physical_state`, `physical_zip`, `physical_county`, `physical_country`) — all
  redaction-gated. Both address blocks must be scrubbed by the redaction gate.
- **`reserved`** (from `RESERVED`, status-resolution only): `n_number` (indexed),
  `type_reservation_code`, `reserve_date`, `expiration_notice_date`, `purge_date`,
  `n_number_for_change`, plus registrant/address fields (redaction-gated).

Decode tables (status code, type-registrant, type-aircraft, type-engine, region, category,
builder-cert, airworthiness class, reservation type) are small static maps in code, applied at
query time — see Appendix. They are not stored in the index.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `FAA_REDACT_OWNER_PII` | No (defaults to `true` / redacted) | Fail-safe owner-PII redaction. When `true`/unset/malformed: drop registrant name, street/physical address, and co-owner names from all output, and disable owner-name search. Set to `false` only on trusted local/self-host installs to expose full owner detail. Parse with `z.stringbool().default(true)`. |
| `FAA_MIRROR_PATH` | No (defaults to `.mirror/faa-registry.db`) | Filesystem path to the SQLite index file. Mount a volume here in production; the Docker image pre-creates the parent dir owned by the runtime user. |
| `FAA_DATABASE_URL` | No (defaults to the FAA registry ZIP URL) | Source URL for `ReleasableAircraft.zip`, used by `mirror:init` / `mirror:refresh`. Overridable for a private/cached mirror; never read at request time. |

Goes in `src/config/server-config.ts` as its own Zod schema, lazy-parsed via `parseEnvConfig`
(env-var-named errors). Never merged with core config.

---

## Implementation Order

1. **Config + server setup** — `server-config.ts` (the three env vars above); `createApp()`
   with `name`/`title` both set to `faa-aircraft-registry-mcp-server` (machine name on every
   surface — never a Title Case display name), `websiteUrl` to the repo, and a short
   `instructions` string noting the offline/keyless nature and the redaction default.
2. **`registry-service`** — `defineMirror` + `sqliteMirrorStore` schema; the `sync` ingester
   (download ZIP → parse five `.txt` files → pre-join → yield rows); decode maps; the
   N-number normalizer; the redaction gate (single chokepoint that strips PII fields and
   flips `ownerRedacted`). Mirror lifecycle CLI scripts (`mirror:init/refresh/verify`) +
   `_mirror-context.ts`; wire daily `mirror:refresh` via `schedulerService` in `setup()`;
   un-comment the Dockerfile mirror stanza; add scripts to `package.json` `files[]`.
3. **Read-only tools** — `faa_lookup_registration`, `faa_get_aircraft_type` (the two exact-key
   lookups) first; then `faa_search_registrations`, `faa_search_aircraft_types` (FTS5); then
   `faa_get_registration_status` (multi-file resolution).
4. **Resource** — `faa://registration/{nNumber}` (reuses the lookup handler).
5. **Tests** — `createMockContext`; cover N-number normalization (with/without N, lowercase),
   the redaction gate in both modes (default-redacted *and* opt-in full), a known
   active/deregistered/reserved status split, capped-search truncation disclosure, and a sparse
   record (blank permissible fields — `year`, `cruise_speed`, `other_names` all legitimately
   empty).

There are no write tools, no prompts, and no app tools. Each step is independently testable.

---

## Workflow Analysis

`faa_get_registration_status` is the one multi-source tool — it resolves an N-number across
three index tables in priority order, returning a discriminated `recordType` so the agent gets
a definitive answer instead of a not-found for a known-but-inactive number.

| # | Lookup | Purpose | Result |
|:--|:-------|:--------|:-------|
| 1 | `registration` table by `n_number` | Active registration? | `recordType: 'active'` → status + airworthiness + expiry |
| 2 | `dereg` table by `n_number` | Previously registered, now cancelled? | `recordType: 'deregistered'` → status code + cancel date |
| 3 | `reserved` table by `n_number` | Reserved but not yet registered? | `recordType: 'reserved'` → reservation type + reserve/purge dates |
| — | none matched | Number never issued | `recordType: 'unknown'` (not an error — a valid, informative answer) |

The cross-file order matters: an N-number can legitimately appear in `dereg` (cancelled) and
later be re-issued in `reserved` or `registration`; active (MASTER) wins, so it is checked
first. This drives the service method shape (one method, three indexed point-lookups,
short-circuit on first hit) and the output schema (a discriminated union keyed on `recordType`,
each branch validated separately so `format()`-parity holds per branch).

---

## Design Decisions

- **Canonical prefix `faa_`.** Matches the federal-agency-acronym convention already in the
  fleet (`nhtsa_`, `fcc_`, `fema_`) and the self-descriptive server name. "FAA" is an
  unambiguous, well-known acronym for the domain; no descriptive suffix needed on the prefix
  (the `-aircraft-registry` lives in the server name, which gives agents the domain context).
- **Data source = the FAA Releasable Aircraft Database, bundled on disk.** It is the *only*
  programmatic path — the FAA exposes no keyless JSON registry API; `registry.faa.gov` is a
  human web portal (verified read-only). Public domain (US Government work), daily-refreshed
  comma-delimited `.txt` files in one ZIP. The corpus changes daily but is queried far more
  than it changes — textbook "mirror a bulk upstream instead of paginating it live." **Note:**
  the registration master is split across `MASTER-1.txt`…`MASTER-9.txt` (confirmed Jan 2026);
  the ingestor concatenates all nine parts.
- **Backend = MirrorService SQLite + FTS5, not in-memory, not external.** Corpus (~300k active
  + several-hundred-k deregistered + reference tables ≈ 10⁶ rows) is mid-tier: too large for a
  comfortable in-memory rebuild-per-process, far below an external store. SQLite delivers the
  relational join, FTS5 search, and indexed exact lookups in one embedded file with no runtime
  service. `bun:sqlite` is built in (no native dep on the Bun/Docker path); Node deployments
  add `better-sqlite3` as an optional peer. Not Workers-portable (no SQLite there) — acceptable
  because this server targets stdio + Node/Bun HTTP.
- **Ingest = built at image-build / out-of-band, refreshed daily — never on startup.** A full
  parse+join of ~1M rows must not block server start. The `mirror:init` CLI writes the index
  during Docker build so the image ships warm; `mirror:refresh` runs on a daily cron
  (`schedulerService` in `setup()`, HTTP-gated) aligned to the FAA's 11:30 PM Central
  re-release. The scaffold's `Dockerfile` already pre-creates the `.mirror` dir and carries the
  mirror-CLI stanza, confirming this is the framework's intended path for the server class.
- **Decode/reference-table handling = pre-join codes, decode labels at query time, surface
  both.** `MASTER` stores `mfr_mdl_code` / `eng_mfr_mdl_code` (joined to `ACFTREF`/`ENGINE` at
  ingest for make/model/engine names) and a dozen single-char coded fields (status, type,
  region, etc.). Coded fields decode at query time from small static maps (Appendix), and every
  output carries both the raw code and the decoded label — the label for the agent's reasoning,
  the code so nothing is lost and the agent can cross-reference the FAA spec. Decode maps live
  in code, not the index, so a correction is a code change, not a re-ingest.
- **Owner PII = required, fail-safe redaction; public-domain ≠ "operate a PII-exposure
  service."** `MASTER`/`DEREG`/`RESERVED` carry registrant names and addresses (DEREG the most:
  mailing *and* physical address blocks + 5 co-owner names). `FAA_REDACT_OWNER_PII` defaults to
  redacted; unset/empty/malformed → redacted (so omission never leaks). Redaction both drops
  PII fields *and* disables owner-name search (output-hiding alone leaks via search probing).
  `ownerRedacted: true` tells the agent data was withheld and why. This is the feature that
  makes the server hostable — the public endpoint serves aircraft identity, not owner identity.
- **Licensing = no blocker.** US Government public-domain data, no copyright, no anti-AI /
  anti-redistribution clause. The only constraint is the owner PII above, fully handled by the
  redaction design. Authoritative basis: 49 U.S.C. § 44114(b), cited on page 1 of the FAA's own
  `ardata.pdf` data dictionary.
- **`faa_get_registration_status` kept distinct from `faa_lookup_registration`.** They look
  adjacent (status is a field in the full lookup), but they answer different questions over
  different data. `lookup` decodes the *active* record (MASTER + joins) and not-founds an
  inactive number; `get_registration_status` resolves *across all three status files*
  (active/deregistered/reserved) and returns a definitive `recordType` for a known-but-inactive
  number — exactly the "surface reserved/deregistered status rather than a 404" requirement.
  The distinct output (a discriminated union, not the full aircraft record) earns the separate
  tool. The reverse trap was the bigger risk: folding status-resolution into `lookup` would
  bloat the 80% tool's output and still leave the dereg/reserved cases under-served.
- **No prompts, no DataCanvas, no app tools.** Pure lookup/search/decode surface. No recurring
  multi-step interaction worth a prompt template; results are categorical records the agent
  drills into, not analytical rows it would SQL (fails the DataCanvas shape gate); no
  human-in-the-loop real-time interaction justifying an app tool's iframe/CSP cost.
- **One resource, tool-backed.** `faa://registration/{nNumber}` mirrors the 80% lookup for
  resource-capable clients; tool-only clients reach the same data via
  `faa_lookup_registration`, so no data is locked behind a resource.

---

## Known Limitations

- **MASTER file is split into nine parts.** As of at least January 2026 the ZIP contains
  `MASTER-1.txt` through `MASTER-9.txt` rather than a single `MASTER.txt`. The ingestor must
  enumerate all nine parts; code checking for `MASTER.txt` by exact name will silently ingest
  nothing and produce an empty index. Verify against the live ZIP before implementation.
- **FAA Reauthorization Act 2024 §803 PII opt-out (status: pending final rule).** Since
  April 2025 private aircraft owners may request removal of their name/address from FAA
  public-facing systems. The web portal already blanks opted-out records; whether and when the
  downloadable ZIP will reflect the same blanking depends on a forthcoming final rule (the
  statutory deadline was May 2026 but no final rule was published as of mid-2026). **Design
  implication:** some records in the ZIP may have blank NAME/address fields even without
  `FAA_REDACT_OWNER_PII=true` — the ingestor and output schema must handle empty name/address
  as a valid, non-error condition (mark them optional, never fabricate from a blank field).
  This is distinct from the server's own redaction gate.
- **US civil registry only.** No military, no experimental-only-uncertified gaps the FAA
  doesn't publish, no other nations' registries (separate, mostly not bulk-published).
- **Self-certified data.** The FAA largely relies on owner self-certification and does not
  verify identity or true ownership; LLC/shell-company registrants can obscure beneficial
  owners (GAO-20-164). The server reports what the registry says — it cannot resolve who is
  *behind* an LLC registrant.
- **Permissible fields are often blank.** "Required" vs "Permissible" data: year manufactured,
  cruise speed, co-owner names, kit fields, and others are legitimately empty on many records.
  Schemas mark these optional; `format()` and normalization preserve the gap (never fabricate a
  value from a blank upstream field).
- **Up to ~24h staleness.** The index refreshes daily against the FAA's nightly re-release; a
  registration filed today may not appear until the next refresh. The FAA also publishes daily
  incremental files — out of scope for v1 (full daily rebuild is simpler and the corpus is
  small enough).
- **Redacted hosted endpoint withholds owner data by design.** On the public endpoint
  (`FAA_REDACT_OWNER_PII=true`), owner name/address and owner-name search are unavailable. This
  is intentional, not a bug; `ownerRedacted: true` flags it. Full detail requires a local
  install with redaction off.

---

## Appendix — FAA File Layouts & Decode Tables

Source: FAA `ardata.pdf` (Aircraft Registration Master File data dictionary, rev. 2025-05-08).
All files are comma-delimited; fixed positions below are from the spec (the data ships with
header rows and trailing commas). Decode maps are applied at query time.

**File set as of Jan 2026:** `MASTER-1.txt`…`MASTER-9.txt` (nine parts, same schema, same
header row per part), `ACFTREF.txt`, `ENGINE.txt`, `DEREG.txt`, `RESERVED.txt`. The ingestor
enumerates all nine MASTER parts and concatenates them; checking for `MASTER.txt` by exact
name will fail.

### MASTER-{1..9}.txt (active registrations — 34 fields, 612-char record per row)

`N-NUMBER, SERIAL NUMBER, MFR MDL CODE (7-char: mfr 3 / model 2 / series 2), ENG MFR MDL
(5-char: mfr 3 / model 2), YEAR MFR, TYPE REGISTRANT, NAME, STREET, STREET2, CITY, STATE, ZIP
CODE, REGION, COUNTY, COUNTRY, LAST ACTION DATE, CERT ISSUE DATE, CERTIFICATION
(10-char compound: char 1 = airworthiness-class code, chars 2-10 = approved-operation
sub-codes interpreted per class — see compound field note above), TYPE AIRCRAFT, TYPE ENGINE,
STATUS CODE, MODE S CODE (octal), FRACT OWNER, AIR WORTH DATE, OTHER NAMES(1–5), EXPIRATION
DATE, UNIQUE ID, KIT MFR, KIT MODEL, MODE S CODE HEX.`

**ZIP field name:** `ZIP CODE` (two words, with space) — not `ZIP`.

**PII fields:** NAME, STREET, STREET2, CITY, OTHER NAMES(1–5).

**CERTIFICATION field (positions 238-247, 10 chars):** A compound sub-field, not a single
code. Position 238 = Airworthiness Classification char (1-9). Positions 239-247 = Approved
Operation sub-codes whose meaning depends on the class (Standard/Restricted/Experimental/
Multiple/Special Flight Permit/Light Sport each use different sub-code alphabets). In the
comma-delimited form the entire block arrives as one padded 10-char field. Parse position 1 of
the field for the class, then interpret the remaining chars per the class-specific table in the
Appendix decode section.

### ACFTREF.txt (aircraft reference — 158-char record)

`CODE (7-char), MFR, MODEL, TYPE-ACFT, TYPE-ENG, AC-CAT, BUILD-CERT-IND, NO-ENG, NO-SEATS,
AC-WEIGHT, SPEED, TC-DATA-SHEET, TC-DATA-HOLDER.`

### ENGINE.txt (engine reference — 47-char record)

`CODE (5-char), MFR, MODEL, TYPE, HORSEPOWER (types 1/2/3/7/8), THRUST (types 4/5/6).`

### DEREG.txt (deregistered — 721-char record)

Reordered from MASTER, status code at a different position, and crucially carries **two
completely independent address blocks**:

- **Mailing/registration address** (from the original registration): Street1 (pos 99-131),
  Street2 (133-165), City (167-184), State (186-187), Zip (189-198).
- **Physical address** (separate block): Physical Address (297-329), 2nd Physical Address
  (331-363), Physical City (365-382), Physical State (384-385), Physical Zip (387-396),
  Physical County (398-400), Physical Country (402-403).

Also carries Cancel Date, Type Registration, Export Country, and 5 Other Names.
**All name/address blocks in both address sets are PII** — the redaction gate must scrub both
the mailing and physical address blocks; a gate that only clears one block still leaks the
other.

### RESERVED.txt (reserved N-numbers — 192-char record)

`N-NUMBER, REGISTRANT, STREET, STREET2, CITY, STATE, ZIP CODE, RSV DATE, TR (type reservation),
EXP DATE, N-NUM-CHG, PURGE DATE.` **PII fields:** REGISTRANT, STREET, STREET2, CITY.

### Decode tables

**Type Registrant / Type Registration:** 1 Individual · 2 Partnership · 3 Corporation ·
4 Co-Owned · 5 Government · 7 LLC · 8 Non-Citizen Corporation · 9 Non-Citizen Co-Owned.

**Type Aircraft:** 1 Glider · 2 Balloon · 3 Blimp/Dirigible · 4 Fixed-wing single-engine ·
5 Fixed-wing multi-engine · 6 Rotorcraft · 7 Weight-shift-control · 8 Powered Parachute ·
9 Gyroplane · H Hybrid Lift · O Other.

**Type Engine:** 0 None · 1 Reciprocating · 2 Turbo-prop · 3 Turbo-shaft · 4 Turbo-jet ·
5 Turbo-fan · 6 Ramjet · 7 2-Cycle · 8 4-Cycle · 9 Unknown · 10 Electric · 11 Rotary.

**Status Code (MASTER/DEREG):** A Triennial form mailed, not returned by USPS · D Expired
Dealer · E Revoked by enforcement · M Valid, assigned to mfr under Dealer Certificate ·
N Non-citizen corp, no flight-hour report · R Registration pending · S Second Triennial mailed,
not returned · T Valid (Trainee) · V Valid registration · W Certificate ineffective/invalid ·
X Enforcement letter · Z Permanent Reserved · plus numeric 1–29 (notice/expiry/cancellation
lifecycle states — e.g. 13 Registration Expired, 7 Sale Reported, 22 Revoked-Canceled). Decode
the full table from the spec.

**Registrant's Region:** 1 Eastern · 2 Southwestern · 3 Central · 4 Western-Pacific ·
5 Alaskan · 7 Southern · 8 European · C Great Lakes · E New England · S Northwest Mountain.

**Airworthiness Classification (CERTIFICATION char 1):** 1 Standard · 2 Limited · 3 Restricted ·
4 Experimental · 5 Provisional · 6 Multiple · 7 Primary · 8 Special Flight Permit · 9 Light
Sport. (Approved-operation sub-codes that follow depend on the class — Standard uses N/U/A/T/
G/B/C/O; Restricted/Experimental use 0–9 + light-sport/UAS variants. Surface the raw operations
string; decode the class char as the primary signal.)

**Aircraft Category (ACFTREF AC-CAT):** 1 Land · 2 Sea · 3 Amphibian.

**Builder Certification (ACFTREF BUILD-CERT-IND):** 0 Type Certificated · 1 Not Type
Certificated · 2 Light Sport.

**Aircraft Weight (ACFTREF AC-WEIGHT):** CLASS 1 ≤ 12,499 lb · CLASS 2 12,500–19,999 lb ·
CLASS 3 ≥ 20,000 lb · CLASS 4 UAV ≤ 55 lb. (Ships as the literal `CLASS N` string.)

**Fractional Owner (MASTER):** `Y` fractional · blank not fractional.

**Type Reservation (RESERVED TR):** AA Reserved-no fee · A Fee paid, expiry notice sent ·
HD 2-year hold for cancelled N-numbers · FN Fee paid, notice sent · FP Fee paid · MF Reserved
to mfr-no fee, no expiry · MT Reserved to mfr-temporary · NC N-number change in process ·
NN N-number change, expiry notice sent · CN N-number change, expire notice sent · CE N-number
change expired.

**Mode S note:** MASTER carries the transponder code in both octal (`MODE S CODE`) and
hexadecimal (`MODE S CODE HEX`). The hex form is the ICAO 24-bit address that `opensky` keys
on — index and expose it for the live-flight-data decode workflow.
