# S9 reviewer-terra verdict — FAIL

Date: 2026-08-06

## Review boundary and scope

- Governing acceptance: Slice S9, campaign plan lines 597-635.
- Reviewed exact range: `c7b82867c71c631bc6ee9905ec9a062ad7cce2fa..df14db04ff5d6625b807f36967f5a23db08ed6c9`.
- Boundary is exactly two commits:
    1. `6f237b6ec87ee16b0469bf814a623254bde00413` — `docs: document the full 001-005 migration chain`.
    2. `df14db04ff5d6625b807f36967f5a23db08ed6c9` — `test: extend MCP smoke to all legacy reads and capture media`.
- Changed paths are only `README.md`, `scripts/mcp-smoke.ts`, and the S9 kimi handoff. No S10 or runtime source drift was found in the range.
- `git diff --check` passed.

## Blocking findings

### 1. Unsafe arbitrary database reset

`scripts/mcp-smoke.ts:31-38` permits any DSN when `DATABASE_URL === DATABASE_URL_TEST`; it does not validate that either DSN identifies an approved disposable database. It then executes `DROP SCHEMA public CASCADE` at lines 90-104.

Independent proof: I created a disposable, deliberately non-test-named database `nurtition_mcp_s9_decoy`, containing `public.non_test_sentinel` and `sentinel_schema.do_not_destroy`, then ran the smoke with both environment variables set to that same decoy DSN. The smoke exited 0. Afterwards the sentinel result was `public_survives=false, named_schema_survives=true`: the public sentinel was destroyed. The decoy was then dropped successfully.

This disproves the script's claim that DSN equality prevents a non-test database from being touched. It is blocking because the script accepts an arbitrary same DSN before destructive SQL.

Bounded fix: before constructing the pool or creating scratch state, parse the URL and fail closed unless its database name is an approved test/disposable name (for example exactly `nutrition_mcp_test`), or require a separate explicit disposable opt-in that is itself constrained to a safe database name. Equality alone must not authorize `DROP SCHEMA`.

### 2. Recursive deletion of unrelated exports

`scripts/mcp-smoke.ts:50-61` and `449` run `rmSync(exportsDir, { recursive: true, force: true })`, deleting the repository-wide `exports` directory on normal exit, `process.on("exit")`, and setup failure.

Independent proof: I seeded `exports/s9-unrelated-user/sentinel.csv`, ran the required smoke command, and checked it afterwards. The smoke exited 0 but the sentinel was `DESTROYED`. This violates the requested operator-smoke isolation: cleanup is not limited to the smoke's own exports path.

Bounded fix: give this run a unique, controlled smoke user/path and remove only that run's `exports/<smoke-user>` directory (or inject a per-run export root). Never recursively remove repository-wide `exports`; retain an explicit post-cleanup check that an unrelated-user sentinel survives.

### 3. Claimed PNG fixture is not an image

`scripts/mcp-smoke.ts:63-67` labels 12 bytes as a tiny PNG. They are only the eight-byte PNG signature plus four arbitrary bytes; the fixture has no required `IHDR` chunk. Independent file validation identified it as generic `data`, and `sips -g pixelWidth -g pixelHeight` returned nil dimensions. The explicit structural probe reported `fixture_bytes=12; png_IHDR_present=False`.

The server accepts it because the attach path only checks an allow-listed MIME and hashes the bytes, not because it is a decodable image. S9 specifically requires a tiny fixture image.

Bounded fix: replace the payload with a known valid, decodable tiny PNG (for example a valid 1×1 image), and assert decoding/dimensions in the smoke or a directly invoked fixture validator before attachment. Keep the public MCP `bytes_base64` path and the existing hash/identity assertions.

## Acceptance mapping

| Acceptance criterion                                             | Result                                 | Evidence                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README command block lists migrations `001..005`                 | PASS                                   | `README.md:131-135` has all five `psql -v ON_ERROR_STOP=1` commands.                                                                                                                                                                                                                               |
| README order sentence lists `001..005`                           | PASS                                   | `README.md:170` lists all five in order.                                                                                                                                                                                                                                                           |
| Destructive-002 warning retained                                 | PASS                                   | `README.md:138-142` retains the explicit destructive warning and rollback limitation.                                                                                                                                                                                                              |
| Fresh copy-paste migration chain                                 | PASS                                   | `dropdb/createdb nutrition_mcp_smoke`; all five migrations completed under `ON_ERROR_STOP=1`; 19 public tables; `dropdb` completed; `pg_database` count was `0`.                                                                                                                                   |
| Eight legacy reads plus log/export/delete use real MCP transport | PASS                                   | Required smoke exited 0 over linked `InMemoryTransport`: `log_meal`, `get_meals_today`, `get_meals_by_date`, `get_meals_by_date_range`, `search_meals`, `get_nutrition_summary`, `get_goal_progress`, `get_trends`, `get_meal_patterns`, `export_meals`, and `delete_meal` all printed `smoke ok`. |
| Capture start → attach → draft → confirm and public re-reads     | PARTIAL / BLOCKED                      | Actual smoke completed all named capture steps; it verified staged hash, capture re-read, date re-read, and one `meal_event_media` row. The attached payload was not an actual PNG image.                                                                                                          |
| Structured-content claim                                         | PASS for declared, exercised contracts | See matrix below; full DB gate includes the existing exact-schema S6 suites.                                                                                                                                                                                                                       |
| Operator smoke database safety                                   | FAIL                                   | Arbitrary equal DSNs authorize destructive reset; decoy public sentinel was destroyed.                                                                                                                                                                                                             |
| Operator smoke exports isolation                                 | FAIL                                   | Unrelated exports sentinel was deleted.                                                                                                                                                                                                                                                            |
| Cleanup / no listener                                            | PARTIAL / BLOCKED                      | Per-run media scratch was absent after success and forced connection failure; forced failure left `exports` absent; no TCP 8080 listener or residual smoke process was found. The cleanup implementation is over-broad and therefore unsafe.                                                       |

## Actual MCP `tools/list` contract matrix

The inventory was fetched through a fresh linked `InMemoryTransport` against `registerTools`, not inferred from source. `yes` means the server advertises `outputSchema`; `text-only` means it honestly has no output schema and the smoke uses text assertions.

| Tool                        | `outputSchema` | Smoke assertion / result                                                                                        |
| --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `log_meal`                  | yes            | `structuredContent.action=logged`, date and provenance/version fields asserted.                                 |
| `bulk_import_meals`         | yes            | `structuredContent.summary.created=1` asserted.                                                                 |
| `update_meal`               | yes            | `structuredContent.action=updated` asserted.                                                                    |
| `get_meals_today`           | text-only      | Both smoke meals asserted in text.                                                                              |
| `get_meals_by_date`         | text-only      | Both meals and corrected calories asserted in text.                                                             |
| `get_meals_by_date_range`   | text-only      | Day and both meals asserted in text.                                                                            |
| `search_meals`              | text-only      | Oatmeal asserted in text.                                                                                       |
| `get_nutrition_summary`     | yes            | `logged_days`, one day, and two meals asserted.                                                                 |
| `get_goal_progress`         | yes            | Date and two-meal count asserted.                                                                               |
| `get_trends`                | yes            | End date and 30-day window asserted.                                                                            |
| `get_meal_patterns`         | text-only      | `Patterns` asserted in text.                                                                                    |
| `export_meals`              | text-only      | Text plus generated CSV content asserted.                                                                       |
| `delete_meal`               | text-only      | Non-error plus public re-read exclusion asserted.                                                               |
| `start_meal_capture`        | yes (S6)       | Capture ID, receiving state, null event/version asserted.                                                       |
| `attach_meal_capture_media` | yes (S6)       | Capture/media identity, storage key, SHA-256, size, state, and de-duplication asserted; fixture is invalid PNG. |
| `save_meal_capture_draft`   | yes (S6)       | Capture ID and ready-to-confirm state asserted.                                                                 |
| `confirm_meal_capture`      | yes (S6)       | Capture/event identity, version, state, provenance, and compatibility asserted.                                 |
| `get_meal_capture`          | yes (S6)       | Confirmed capture identity and one media entry asserted.                                                        |

The broader S6 definition covers nine capture lifecycle tools (including append, answer, cancel, and expire) plus the existing sweep. The unchanged full DB gate passed the existing inventory and strict runtime-schema suites. S9's smoke invokes the five capture contracts relevant to this slice; all five advertise output schemas and return structured content. The text-only legacy reads are accurately identified as text-only.

## Execution evidence

- Required test URL smoke: exit 0; 23 named checks including all eight reads, export/delete re-read, and the capture round trip.
- Persisted media identity before cleanup: the smoke asserted its public attach identity and on-disk SHA-256; its final DB assertion found exactly one `meal_event_media` row for the confirmed event/version. A post-run query found one smoke-user media row before subsequent test DB reuse.
- Forced failure: equal URLs targeting `localhost:1` exited 1 with `ECONNREFUSED`; no `nutrition-mcp-smoke-media-*` roots remained; `exports` was absent; no 8080 listener remained.
- Clock: the smoke derives `DAY` in UTC, freezes at `${DAY}T12:00:00.000Z`, and calls `setSystemTime()` in `finally`. Successful smoke execution reached that `finally`; the forced pre-try connection failure exits the process, so the process-level exit handler covers filesystem cleanup but the reset is not reached in-process. No host-clock change was observed (the Bun test clock is process-local).
- Pools and transports: successful smoke reached `client.close()`, `server.close()`, `closePool()`, and `pool.end()` in `finally`; process and listener probes found no residual smoke process and no listener on TCP 8080.

## Gate results

- `bun run typecheck`: PASS (`src/ typechecks clean`).
- `bun run test:unit`: PASS — 498 pass, 0 fail, 156 skip, 654 total.
- Explicit eight-suite DB gate with matching test URLs: PASS — 140 pass, 0 fail, 0 skip: 8, 41, 13, 20, 20, 7, 23, 8.
- Changed-file Prettier for `README.md`, `scripts/mcp-smoke.ts`, and the kimi handoff: PASS.
- `git diff --check` over the requested range: PASS.
- Repository-wide `bun run format:check`: FAIL, 28 pre-existing historical `.hermes/plans` markdown files. The S9 changed files passed; this remains a recorded repository format failure and is S10 scope per the campaign plan.

## Verdict and disposition

FAIL. No code was changed by review. The review is intentionally left uncommitted, as required for a failing verdict. Resolve the three bounded fixes above, rerun the operator-safety probes and all required gates, then submit a new S9 handoff/review cycle.
