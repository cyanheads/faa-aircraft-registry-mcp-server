---
name: faa-aircraft-registry-guide
description: Use the faa_* tools to resolve a model or serial number to US civil aircraft registrations, interpret an N-number's cancellation history, or establish what the FAA registry snapshot supports.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use the FAA civil registry for registration records, aircraft type references, and available cancellation history. Report a named owner as the registered owner in the snapshot. The registry cannot establish beneficial ownership or live flight eligibility.

## Identifiers

- Take the model-series `code` from `faa_search_aircraft_types`, or `manufacturerModelCode` from a registration record. Pass it to `faa_get_aircraft_type` for reference specs or use it as the exact model filter in `faa_search_registrations`. The FAA aircraft type code classifies the kind of aircraft. The six-digit hexadecimal Mode S code identifies its ICAO 24-bit address.
- Take the N-number from `faa_search_registrations` to `faa_lookup_registration` or `faa_get_registration_status`. It identifies the registration mark, which may be reassigned to another airframe.
- Keep a manufacturer's serial as a string, including leading zeros, punctuation, and internal spaces. An exact serial can match multiple aircraft. Narrow by a verified model code or corroborate with other identifiers before selecting a record.

## Gates

- Check `dataAsOf` and the notice before making a current-state claim. With a stale or undated snapshot, report what the snapshot shows and qualify its freshness. If the mirror returns a loading or unavailable error, retry as directed or report that the registry could not be checked.
- Treat `unknown` as absence from the queried snapshot. It does not establish whether the number was ever issued or is available for assignment. An empty active-registration search has narrower coverage than a status lookup for a specific N-number.
- If owner search is disabled, use a non-owner identifier where available. A withheld or blank owner field provides no evidence of who owns the aircraft. A redacted builder name can also prevent a manufacturer-name match. Try a known model or exact code if available.

## Workflows

### Find registrations of a specific variant

Start with `faa_search_aircraft_types` if you have a make or model name. Both aircraft type search and registration make/model search require every whitespace-separated term to match a token prefix. For example, `Cessna 172` can match `172S`. Use plain text and separate searches for alternatives. Boolean operators, wildcards, and quoted phrases do not act as query syntax. Where enabled, owner-name search matches whole tokens.

Confirm the intended variant before using the returned model code to find active registrations. If several codes fit the request, preserve the ambiguity or search each applicable code. Use `faa_get_aircraft_type` for reference specifications and `faa_lookup_registration` for details about a particular returned N-number.

Use `totalCount` for the match count and follow `nextOffset` with identical filters to read further pages. An empty page past the end can still have a positive count. If `dataAsOf` changes while paging, restart before reporting an exhaustive set. A matching date alone cannot establish that pages came from the same refresh.

### Trace a registration mark through reassignment

Start with `faa_get_registration_status` and read `recordType` for the snapshot's state. An active record or reservation can coexist with older cancellations. A cancellation's status describes that historical row and does not establish why the registration was cancelled.

For an active mark, use `faa_lookup_registration` to obtain the current airframe identifiers. Compare the serial and model code with the cancellation rows before attributing any cancellation to that aircraft. If those identifiers are missing or inconclusive, report the history for the N-number and leave airframe attribution open.
