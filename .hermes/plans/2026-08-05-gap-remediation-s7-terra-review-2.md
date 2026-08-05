# S7 reviewer-terra re-review — Database readiness distinct from process health

Date: 2026-08-06
Reviewer: reviewer-terra
Governing slice: `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` lines 507–549
Accepted implementation: `1bea699edda029bf3cce3728cf6887fbf2c39fbd` (`feat: add database readiness probe with redacted diagnostics`)
Remediation range: `2c837519db41597d26e84e585c8f20b836ee716c..c5926b556ff75b30e455df6e8aa02b71fc3a8d6d`
Immutable FAIL review: `.hermes/plans/2026-08-05-gap-remediation-s7-terra-review.md`

Verdict: **PASS — S7 documentation correction is truthful and the accepted readiness implementation satisfies the governing acceptance criteria.**

## Documentation re-review

1. **Immutable FAIL review retained and verified.**
   - SHA-256 of `.hermes/plans/2026-08-05-gap-remediation-s7-terra-review.md` is exactly `367daa70d034e3f49fbb8e8971ac51e60f04ffff5928d0aeb5770cbcd4bbb9ee`.
   - It remains the original FAIL review, including its required wording and its no-acceptance-commit record.

2. **The amended Kimi handoff corrects the blocking claim without contradiction.**
   - `.hermes/plans/2026-08-05-gap-remediation-s7-kimi-handoff.md:68-73` now says the helper clears its own timer and starts no retry loop; `Promise.race` handles a late query rejection; and the timed-out underlying `pg` connection/query attempt may continue until the driver finishes and is not cancelled by the helper.
   - Its known limitation at lines 155-157 says the same thing: underlying `pg` work is handled and unretried but allowed to finish independently. There is no remaining claim that no background work survives a timed-out probe.
   - This distinction is accurate for `src/readiness.ts:62-80`: the helper bounds the caller with `Promise.race`, handles a late rejection, clears its application-owned timer, and does not cancel the losing driver promise.

3. **Remediation scope is documentation only.**
   - `git diff --name-status 2c837519..c5926b55` lists exactly two `.hermes/plans/` files: the amended S7 handoff and the immutable review artifact.
   - A scoped comparison from accepted implementation commit `1bea699` through `2c837519` found no changes under `src/`, no README change, and no package/config change. The remediation therefore changed no code, configuration, test, or README file.
   - `git diff --check 2c837519..c5926b55` and the accepted implementation diff check were both clean.

## Reconfirmed implementation acceptance criteria

| Governing criterion | Evidence | Result |
| --- | --- | --- |
| `/ready` is 200 only after a real PostgreSQL `SELECT 1`; `/health` remains process-only liveness | `src/readiness.ts:62-69` executes `pool.query("SELECT 1")`; `src/index.ts:269-281` retains `GET /health` as `c.text("ok")` and calls the readiness helper for `GET /ready`. Live reachable-DB server returned `/ready` `200 ok` and `/health` `200 ok`. | PASS |
| Failure is a redacted, actionable 503 | Wrong-port live server returned `503 {"error":"database not ready: connection failed (target localhost:5439/nope)"}`. The tested credential-bearing URL’s user, password, query, fragment, and raw driver error did not appear. | PASS |
| Failure is bounded and late rejection is handled | Focused unit suite passed the 50ms hanging-probe bound. Independent 20ms timeout/late-rejection probe returned in 22ms, had 0 `unhandledRejection` events after the delayed raw credential-bearing rejection, and did not expose its credentials or `ECONNREFUSED`. This verifies helper timer/late-rejection behavior only; it does not claim cancellation of the underlying `pg` attempt. | PASS |
| Wrong-port readiness case is live-DB tested | `src/db.integration.test.ts` passed its wrong-port, bounded, redacted case and its reachable-DB route case. The complete DB gate explicitly reported `src/db.integration.test.ts: 8 pass, 0 fail, 0 skip`. | PASS |
| `/ready` and `/health` documentation is accurate | README identifies `/health` as pure process liveness and `/ready` as PostgreSQL readiness, documents 503 troubleshooting/redaction, and lists both endpoints. | PASS |

Both temporary live servers were SIGTERM-stopped. Post-stop listener checks for ports 49531 and 49532 were empty.

## Gates rerun by reviewer

| Command | Result |
| --- | --- |
| `bun test src/readiness.test.ts` | 12 pass, 0 fail, 56 expects |
| Independent timeout + delayed credential-bearing rejection probe | 22ms bounded result; 0 unhandled rejections; no credential/raw-driver leak |
| `bun run typecheck` | `src/ typechecks clean` |
| `bun run test:unit` | 498 pass, 156 skip, 0 fail; 654 tests |
| `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` | 140 pass, 0 fail, 0 skip; 140 tests across all 8 explicit DB suites |
| `bunx prettier --check src/readiness.ts src/readiness.test.ts src/index.ts src/db.integration.test.ts README.md` | passed |
| `git diff --check 2c837519..c5926b55` and accepted implementation range | clean |

## Acceptance decision

The prior FAIL was solely the inaccurate absolute handoff statement. That statement has been replaced with the required truthful separation: helper-owned timer/retry/late-rejection behavior is bounded and handled, while uncancelled underlying `pg` work may continue. The documentation remediation is strictly scoped, and the accepted implementation and all required gates are green. Accept S7.
