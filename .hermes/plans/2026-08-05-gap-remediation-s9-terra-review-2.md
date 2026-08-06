# S9 reviewer-terra re-review 2 — PASS

Date: 2026-08-06

## Boundary, provenance, and scope

- Governing acceptance: Slice S9 in
  `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md:597-635`.
- Immutable prior FAIL review:
  `.hermes/plans/2026-08-05-gap-remediation-s9-terra-review.md`; independently
  verified SHA-256:
  `067497b051925f1905933d1a3c02606aab23ccae6817eaab8ddd60c427ace689`.
- Re-reviewed remediation range:
  `df14db04ff5d6625b807f36967f5a23db08ed6c9..1dfe169581216873076a46aa0fcfcea7bbc24519`.
  It contains `f5de3d9` (`scripts/mcp-smoke.ts`) and `1dfe169` (the immutable
  FAIL review plus handoff-2).
- Full S9 chain re-reviewed:
  `c7b8286..1dfe169`: `6f237b6`, `df14db0`, `f5de3d9`, and `1dfe169`.
  Changed paths are README, the smoke script, and S9 handoff/review records.
  No `src/`, `db/migrations/`, package, provider, version, S10, or runtime
  drift exists in that chain.
- Working tree was clean before this review artifact. `git diff --check` passed.

## Prior blockers independently closed

### 1. Destructive database reset guard — PASS

`scripts/mcp-smoke.ts:34-64` executes its guard before `setSystemTime`,
`mkdtempSync`, `Pool` construction, migration/reset SQL, or any MCP work. It
requires exact raw equality between `DATABASE_URL` and `DATABASE_URL_TEST`,
then parses the URL and requires `decodeURIComponent(pathname without leading
slashes)` to be exactly `nutrition_mcp_test`. Refusal uses exit 2 and reports
only a reason plus the parsed database name; it never prints a DSN.

Independent adversarial proof:

- Created disposable `nutrition_mcp_s9_review_decoy`, with a public-table
  sentinel and `named_sentinel.schema_sentinel`.
- Equal decoy URLs exited 2. Both sentinels remained `t`; the decoy was then
  dropped and confirmed absent.
- Equal traversal URL `.../nutrition_mcp_test%2Fpublic`, equal differently
  named `.../nutrition_mcp_test_extra`, equal malformed `not a url`, and
  mismatched URLs each exited 2 before connection/reset work.
- An equal credential-bearing decoy URL exited 2 and output only
  `nutrition_mcp_private_decoy`; the fabricated username, password, and DSN
  scheme were absent.
- Positive control: equal URLs using encoded approved pathname
  `nutrition%5Fmcp%5Ftest` completed the full smoke successfully (24 checks),
  proving identity is decoded rather than matched as a literal URL string.

### 2. Export cleanup isolation — PASS

The smoke creates a unique `smoke-user-<run>` and scopes its export path to
`exports/<that-user>`. Both the `finally` cleanup and process exit hook remove
only that path and the per-run media scratch root.

Independent sentinel proof with
`exports/s9-review-unrelated-user/sentinel.csv`:

| Run                                     |               Exit | Unrelated sentinel | Owned export dirs | Media scratch dirs |
| --------------------------------------- | -----------------: | ------------------ | ----------------: | -----------------: |
| Exact approved URLs, successful smoke   |                  0 | survives           |                 0 |                  0 |
| Equal approved-db URLs on closed port 1 | 1 (`ECONNREFUSED`) | survives           |                 0 |                  0 |

The unrelated sentinel was removed after both proofs. Post-run probes found
zero TCP 8080 listeners and zero `mcp-smoke.ts` processes. The forced failure
was after the fixture gate and failed during connection; its captured error
contains `ECONNREFUSED` for both `::1:1` and `127.0.0.1:1`.

### 3. PNG fixture and capture persistence — PASS

Committed bytes extracted from `scripts/mcp-smoke.ts` are 68 bytes with
SHA-256 `43739c566e26fd7cb88f69d3864ea34740372f5ee99acac169e090beffbce5c6`.
Independent decoders returned:

```text
file: PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced
sips pixelWidth: 1
sips pixelHeight: 1
```

The in-smoke signature/first-`IHDR`/13-byte chunk/dimension gate runs at lines
148-157, before `Pool` construction and any tool call. The successful smoke
then exercised the public base64 attach path, asserted the capture-scoped
`capture/<capture-id>/photo-<sha256>` storage identity, rehashed staged bytes,
and asserted one persisted `meal_event_media` row at confirmed version 1.

## S9 acceptance proof

- README commands list migrations 001 through 005; the order sentence also
  lists all five, and the destructive 002 warning remains.
- Re-ran the stated migration chain with `ON_ERROR_STOP=1` against fresh
  `nutrition_mcp_smoke_review`. All five files applied; it contained 19 public
  base tables and was dropped successfully (`migration_db_dropped=t`).
- Exact approved URLs smoke: exit 0 with 24 named checks. It covers log, bulk
  import, update; all eight reads (`today`, `by_date`, `by_date_range`, search,
  summary, goal progress, trends, patterns); export CSV; delete plus public
  re-read; and start/attach/draft/confirm/get capture flow.
- UTC handling is retained: the smoke derives the date in UTC, freezes to UTC
  noon, and invokes `setSystemTime()` from `finally`. Successful runs completed
  the `finally` cleanup path; the process-level exit cleanup covers setup/DB
  connection failure.
- The successful smoke closes client/server transports, calls `closePool()` and
  `pool.end()`, and removes owned export/media scratch. Independent post-run
  probes found no listener or residual scratch.

## Actual `tools/list` contract matrix

A fresh linked `InMemoryTransport` client called `tools/list` against
`registerTools`; inventory size was 51. S9-relevant advertised contracts were:

| Tool                        | outputSchema        |
| --------------------------- | ------------------- |
| `log_meal`                  | yes                 |
| `get_meals_today`           | no (text assertion) |
| `get_meals_by_date`         | no (text assertion) |
| `get_meals_by_date_range`   | no (text assertion) |
| `search_meals`              | no (text assertion) |
| `get_nutrition_summary`     | yes                 |
| `get_goal_progress`         | yes                 |
| `get_trends`                | yes                 |
| `get_meal_patterns`         | no (text assertion) |
| `export_meals`              | no (text assertion) |
| `delete_meal`               | no (text assertion) |
| `start_meal_capture`        | yes                 |
| `attach_meal_capture_media` | yes                 |
| `save_meal_capture_draft`   | yes                 |
| `confirm_meal_capture`      | yes                 |
| `get_meal_capture`          | yes                 |

The smoke assertions match this inventory: structured content is asserted for
advertised structured tools; text is asserted for the legacy text-only tools.
The full DB gate separately passed the strict capture lifecycle schema
inventory/runtime suites.

## Gates and format status

| Command / proof                                           | Result                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                                       | PASS — `src/ typechecks clean`                                                                                    |
| `bun run test:unit`                                       | PASS — 498 pass, 0 fail, 156 skip, 654 total                                                                      |
| Explicit `bun run test:db` with both exact approved URLs  | PASS — 140 pass, 0 fail, 0 skip; suites: 8, 41, 13, 20, 20, 7, 23, 8                                              |
| Fresh 001–005 migration chain                             | PASS — 5 files, 19 public tables, disposable DB dropped                                                           |
| Exact URL smoke                                           | PASS — 24 named checks                                                                                            |
| Changed-file Prettier (`scripts/mcp-smoke.ts`, handoff-2) | PASS                                                                                                              |
| `git diff --check` reviewed/full S9 ranges                | PASS                                                                                                              |
| `bun run format:check` baseline                           | FAIL — exactly 28 pre-existing historical `.hermes/plans` markdown files; S10-owned baseline, no S9 failure added |

## Verdict

PASS. All three immutable-FAIL blockers are independently closed and the S9
acceptance criteria are satisfied. This review adds only this review-2 record.
