# S9 — Smoke safety remediation: kimi handoff 2

- Date: 2026-08-06
- Scope: exactly the three bounded fixes from the immutable FAIL review
  `.hermes/plans/2026-08-05-gap-remediation-s9-terra-review.md`
  (SHA-256 `067497b051925f1905933d1a3c02606aab23ccae6817eaab8ddd60c427ace689`,
  verified byte-identical before and after this work). All accepted `df14db0`
  S9 coverage and the `6f237b6` README work are retained. No S10 work started.
- Implementation surface: `scripts/mcp-smoke.ts` only. No runtime, migration,
  schema, provider, version, README, or other test files touched.

## RED — adversarial evidence (pre-fix script at `df14db0`, reproduced)

The pre-fix script was re-materialized from `git show df14db0:scripts/mcp-smoke.ts`
into a disposable path and run against disposable targets; all three findings
reproduced independently of the review:

1. Unsafe arbitrary database reset: created disposable decoy database
   `nutrition_mcp_s9_decoy_kimi` with `public.non_test_sentinel` and
   `sentinel_schema.do_not_destroy`, then ran the pre-fix smoke with both
   `DATABASE_URL` and `DATABASE_URL_TEST` set to that same decoy DSN. Exit 0,
   full pass. Afterwards `public_survives=f, named_schema_survives=t` — the
   public sentinel was destroyed by `DROP SCHEMA public CASCADE`. DSN equality
   alone authorized destructive SQL against a non-test database.
2. Recursive deletion of unrelated exports: seeded
   `exports/s9-unrelated-user/sentinel.csv`, ran the pre-fix smoke with the
   required test URLs. Exit 0; sentinel `DESTROYED`; the entire repository
   `exports/` directory was absent afterwards.
3. Fixture is not an image: the old 12-byte payload written to disk was
   identified by `file` as generic `data`, and `sips -g pixelWidth -g
pixelHeight` returned `<nil>` for both dimensions.

The decoy database and the temporary pre-fix script copy were removed after
the RED runs.

## GREEN — fix 1: fail-closed database guard

The smoke now refuses (exit 2) before pool construction, clock freeze, or any
scratch creation unless all of the following hold: `DATABASE_URL` is set,
`DATABASE_URL_TEST` exactly equals it, the URL parses, and the parsed URL's
database pathname decodes (`decodeURIComponent`) to exactly
`nutrition_mcp_test`. Refusal output names the reason and the non-secret
parsed database name only — never the DSN, which may carry credentials.

Decoy guard probe (GREEN): fresh `nutrition_mcp_s9_decoy_kimi` with both
sentinels; equal decoy DSNs; result exit 2 with:

```
MCP smoke refused: database name "nutrition_mcp_s9_decoy_kimi" is not the approved disposable test database "nutrition_mcp_test"; equal DSNs alone do not authorize a destructive schema reset.
```

Post-refusal: `public_survives=t, named_schema_survives=t`,
`public_table_count=1` (no mutation of any kind), then the decoy was dropped
successfully. No media scratch was created by any refusal.

Adversarial DSN variants, all refused with exit 2 before any connection:

| Variant                                          | Exit | Refusal reason                                  |
| ------------------------------------------------ | ---- | ----------------------------------------------- |
| `DATABASE_URL_TEST` unset                        | 2    | both must be set to the same database           |
| mismatched DSNs                                  | 2    | both must be set to the same database           |
| equal, `nutrition_mcp_test_extra`                | 2    | name not the approved test database             |
| equal, `nutrition_mcp_test%2fpublic` (traversal) | 2    | decodes to `nutrition_mcp_test/public`, refused |
| equal, `Nutrition_MCP_Test` (case)               | 2    | name mismatch                                   |
| equal, unparseable `not a url`                   | 2    | URL could not be parsed                         |
| equal, no database in URL                        | 2    | decoded name `""` refused                       |

Positive control: equal DSNs spelling the approved name percent-encoded
(`nutrition%5Fmcp%5Ftest`) decode to exactly `nutrition_mcp_test` and run the
full smoke to exit 0 — the guard checks the decoded identity, not the literal
string.

## GREEN — fix 2: per-run smoke user and owned exports path

The smoke user is now unique per run: `smoke-user-<RUN>` (visible in analytics
lines, e.g. `user=smoke-user-rcslebje6`), and the smoke-owned exports
directory is `exports/<smoke-user-<RUN>>`. Every cleanup path — the `finally`
on normal exit and failure, and the `process.on("exit")` hook for
setup-failure exits — removes only that owned directory plus the per-run
`mkdtemp` media scratch. Nothing recursively removes repository-wide
`exports` anymore.

Unrelated-export sentinel probes with `exports/s9-unrelated-user/sentinel.csv`
seeded:

- Success run (exact required test URLs): exit 0, sentinel `SURVIVES`,
  `exports/` afterwards contains only `s9-unrelated-user`, no
  `exports/smoke-user-*` directory remains, no
  `/tmp/nutrition-mcp-smoke-media-*` scratch remains, no TCP 8080 listener.
- Forced failure (equal URLs to `localhost:1`, approved db name): exit 1 with
  `ECONNREFUSED`; sentinel `SURVIVES`; no smoke-owned exports dir, no media
  scratch, no 8080 listener.

Only the test sentinel (`exports/s9-unrelated-user`) was removed after the
proofs; the probes' evidence is recorded above.

## GREEN — fix 3: valid decodable 1x1 PNG fixture

The 12-byte header stub is replaced with a known-valid 68-byte 1x1 RGBA PNG
(SHA-256 `43739c566e26fd7cb88f69d3864ea34740372f5ee99acac169e090beffbce5c6`).
A direct pre-attachment fixture gate parses the container in the smoke itself
and requires the 8-byte PNG signature, a 13-byte `IHDR` first chunk, and
exactly 1x1 dimensions; it runs (and is asserted via `check`) before any pool
or tool work, so an invalid payload can never reach the attach path.

Independent decoder evidence (macOS image decoder, bytes extracted from the
committed script):

```
$ file /tmp/s9_fixture_from_ts.png
PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced
$ sips -g pixelWidth -g pixelHeight /tmp/s9_fixture_from_ts.png
  pixelWidth: 1
  pixelHeight: 1
```

The extracted bytes are byte-identical to the independently generated
reference fixture used for validation.

## Full tool inventory and assertions (all retained from `df14db0`)

All calls go through the real MCP transport (`InMemoryTransport` linked pair
against `registerTools`), now with the unique per-run user. The GREEN run
printed 24 `smoke ok` lines: the fixture gate plus the 23 retained checks.

0. `png fixture decodes as 1x1` (new pre-attachment gate) — signature, IHDR
   presence, 1x1 dimensions of the fixture bytes themselves.
1. `log_meal` — structuredContent `action=logged`, `date`=smoke day,
   `provenance_status=compatibility`, `event_version=1`,
   `has_calculation_bundle=false`; text contains the description.
2. `bulk_import_meals` — structuredContent `summary.created=1`.
3. `update_meal` — structuredContent `action=updated`; text contains 350.
4. `get_meals_today` — text contains both smoke meals.
5. `get_meals_by_date` — text contains both meals and "Calories: 350".
6. `get_meals_by_date_range` — text contains the day and both meals.
7. `search_meals` — text contains "smoke oatmeal".
8. `get_nutrition_summary` — `logged_days=1`, one day, two meals.
9. `get_goal_progress` — `date`=smoke day, `meal_count=2`.
10. `get_trends` — `end_date`=smoke day, 30-day window.
11. `get_meal_patterns` — text contains "Patterns".
12. `export_meals` — text reports "2 meal"; CSV under
    `exports/<unique-smoke-user>/meals.csv` contains "smoke oatmeal" and
    ",350,".
13. `delete_meal` — non-error; `get_meals_by_date` re-read excludes the
    deleted meal and keeps the bulk-imported one.
14. `start_meal_capture` — `state=receiving`, `capture_id` string,
    `event_id`/`version` null.
15. `attach_meal_capture_media` — public `bytes_base64` attach of the valid
    1x1 PNG; `capture_id` echo, `media_id` string, `storage_key` =
    `capture/<capture_id>/photo-<sha256>`, `sha256` =
    `43739c56…ce5c6`, `byte_size` = 68, `capture_state=receiving`,
    `deduplicated=false`.
16. `attach staged bytes on disk` — staged file re-hashed to the same SHA-256.
17. `save_meal_capture_draft` — draft echoes the attach identity;
    `state=ready_to_confirm`.
18. `confirm_meal_capture` — `state=confirmed`, `event_id` string,
    `version=1`, `provenance_status` in the S6 enum, `compatibility` boolean.
19. `get_meal_capture re-read` — `state=confirmed`, one media entry.
20. `get_meals_by_date shows confirmed capture` — text contains "smoke
    capture oats".
21. `confirmed event media persisted` — exactly one `meal_event_media` row for
    the confirmed event at version 1.

UTC freeze/reset retained: the smoke derives `DAY` in UTC, freezes at
`${DAY}T12:00:00.000Z`, and restores with `setSystemTime()` in `finally`.
Cleanup on setup failure is covered by the `process.on("exit")` hook, now
scoped to the owned exports directory and the per-run media scratch only.

## Migration copy-paste proof (acceptance commands, verbatim)

```
$ dropdb --if-exists nutrition_mcp_smoke && createdb nutrition_mcp_smoke
NOTICE:  database "nutrition_mcp_smoke" does not exist, skipping
$ for f in db/migrations/00{1,2,3,4,5}_*.sql; do psql postgres://localhost:5432/nutrition_mcp_smoke -v ON_ERROR_STOP=1 -f "$f"; done
== 001_initial_schema.sql: 23 statements ok
== 002_food_tracking.sql: 18 statements ok
== 003_meal_captures.sql: 5 statements ok
== 004_calculation_bundles.sql: 8 statements ok
== 005_calculation_corrections.sql: 9 statements ok
chain exit=0
```

Verification: 19 public tables on the fresh DB; `dropdb nutrition_mcp_smoke`
succeeded; `SELECT count(*) FROM pg_database WHERE
datname='nutrition_mcp_smoke'` returned 0 — no database orphan.

## Gates

- Smoke with both exact test URLs
  (`DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run
scripts/mcp-smoke.ts`) — exit 0, 24 named checks, every required tool named.
- Decoy guard probe — exit 2 refusal before mutation; both sentinels survive;
  decoy dropped (above).
- Unrelated-export sentinel probes — survives success and forced failure
  (above); only the test sentinel removed after proof; no smoke-owned
  export/media scratch remains.
- Fixture decode — `sips` 1x1, `file` PNG 1x1 RGBA, SHA-256 recorded (above).
- `bun run typecheck` — PASS (`src/ typechecks clean`).
- `bun run test:unit` — PASS: 498 pass, 0 fail, 156 skip, 654 tests
  (unchanged).
- Explicit eight-suite DB gate with matching test URLs
  (`bun run test:db`) — PASS: 140 pass, 0 fail, 0 skip across 8 suites:
  8, 41, 13, 20, 20, 7, 23, 8 (`db.integration`, `meal-events`,
  `calculation-bundles.integration`, `meal-captures.integration`,
  `mcp-food-tracking`, `backup-policy`, `legacy-meal-tools.integration`,
  `calculation-acceptance.integration`) — unchanged per-suite counts.
- Migration chain proof — exit 0 per file under `ON_ERROR_STOP=1` (above).
- Changed-file Prettier:
  `bunx prettier --check scripts/mcp-smoke.ts .hermes/plans/2026-08-05-gap-remediation-s9-kimi-handoff-2.md`
  — PASS.
- `git diff --check` — PASS.
- Repository-wide `bun run format:check` — still FAIL, pre-existing and
  untouched: the same 28 historical `.hermes/plans` markdown files recorded by
  the review. This remediation adds zero new failures (both changed/added
  files are Prettier-clean); formatting the historical files remains S10
  scope.

## Commits and push state

1. `test: harden S9 MCP smoke isolation` — `scripts/mcp-smoke.ts` only.
2. `docs: record S9 smoke safety remediation` — the immutable FAIL review
   (byte-identical, SHA-256 `067497b0…ce689`) plus this handoff.

Pushed after green; post-push `git status` clean and `HEAD` equals
`origin/main` (verified with `git rev-parse HEAD origin/main`).
