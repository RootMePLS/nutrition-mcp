# S7 reviewer-terra review — Database readiness distinct from process health

Date: 2026-08-06
Reviewer: reviewer-terra
Range reviewed: `f1aee7de563f3800422787d97f743827349316cb..2c837519db41597d26e84e585c8f20b836ee716c`
Verdict: **FAIL — handoff correction required; implementation behavior otherwise passes the reviewed S7 acceptance checks.**

## Blocking finding

1. **Handoff false claim: background work cannot be said not to survive a timed-out probe.**
   - `.hermes/plans/2026-08-05-gap-remediation-s7-kimi-handoff.md:68-71` says that on timeout “No background work or retries survive a failed/timed-out probe.” This is false as written.
   - The same handoff accurately documents the contrary limitation at lines 153-155: the underlying `pg` connection attempt is left to finish after the caller has received the bounded timeout result.
   - `src/readiness.ts:62-68` retains the losing `pool.query("SELECT 1")` promise after `Promise.race` resolves through the timeout. Its rejection is handled by the race, and the app-created timer is cleaned up, but the underlying driver work is not cancelled. Repeated timed-out `/ready` probes can therefore accumulate in-flight driver connection attempts until the driver's own timeout/cleanup completes. The 2-second caller ceiling is still met.

### Required coder-kimi fix

Amend the immutable handoff only; do not claim cancellation that `pg` does not provide. Replace the absolute claim at lines 68-71 with wording equivalent to:

> The probe clears its own timeout timer and starts no retry loop. `Promise.race` retains handlers for the losing query promise, so a late driver rejection is handled. A timed-out `pg` connection/query attempt itself may continue until the driver completes it; this work is invisible to the caller and is not cancelled by this helper.

Keep the existing known-limitation text, or merge it into this corrected paragraph without contradiction. The coder must provide the amended handoff and leave the implementation unchanged unless they choose to separately change the pool/driver cancellation semantics and re-test resource behavior.

## Verified implementation behavior

- `/health` remains `c.text("ok")` in `src/index.ts:269-271`, performs no database call, and returned 200/`ok` even when `DATABASE_URL` targeted unreachable `localhost:5439`.
- `/ready` calls `checkDatabaseReadiness(getPool())` (`src/index.ts:278-281`). `src/readiness.ts:62-64` directly issues `pool.query("SELECT 1")`; it returns 200 only after that promise resolves and maps failure/timeout to 503.
- The route uses the shared `getPool()` pool; startup starts normally and makes no readiness query/retry loop.
- Access middleware excludes both `/health` and `/ready` at `src/index.ts:23-32`. Live server logs included only `[req] GET /__s7_log_probe 404 ...` after requests to `/ready`, `/health`, and the control endpoint.
- Timer/later-result behavior: an independent hanging stub with 50 ms timeout returned after 53 ms; a late raw credential-bearing rejection produced zero `unhandledRejection` events and leaked neither raw driver text nor credential data. A 20-probe hanging-stub run returned 20 bounded timeouts; no app-owned active timer handles remained. This does not erase the distinct real-`pg` in-flight-attempt limitation in the blocking finding.
- Response/log leakage: live wrong-port response was exactly `{"error":"database not ready: connection failed (target localhost:5439/nope)"}`. It did not contain the username, password, query, fragment, or raw `ECONNREFUSED`. The only observed server stderr on the SSL query parameter was the pg SSL-mode deprecation warning and stack; it contained no URL userinfo or raw connection failure detail.
- Redaction adversarial matrix passed: raw and percent-encoded userinfo/password, query, fragment, Unicode host/database, missing/malformed input, IPv4, bracketed IPv6, default/custom ports, host-only, multi-segment/encoded/control-looking database paths. Outputs were only a host[:port][/first-path-segment] identity or `missing DATABASE_URL`/`invalid DATABASE_URL`; no `@`, `?`, `#`, username, password, query, or fragment appeared. Percent-encoded path data remains literal, not decoded or executed.
- Scope: the range changes only S7 readiness code/tests, route wiring, README, and the S7 handoff. No migrations, MCP/provider/capture/S8/version changes. `git diff --check` was clean.

## HTTP and resource evidence

| Server configuration | `/ready` | `/health` |
| --- | --- | --- |
| `PORT=49431`, live `postgres://localhost:5432/nutrition_mcp_test` | `200`, `ok`, 0.038209 s | `200`, `ok`, 0.000952 s |
| `PORT=49432`, unreachable credential-bearing `postgres://live_user:***@localhost:5439/nope?sslmode=require#frag` | `503`, redacted JSON above, 0.012291 s | `200`, `ok`, 0.000738 s |

Both temporary Bun servers were SIGTERM-stopped. Post-stop `lsof -nP -iTCP:49431 -sTCP:LISTEN` and port 49432 equivalents were empty; no server listener remained.

## Gates run by reviewer

| Command | Result |
| --- | --- |
| `bun test src/readiness.test.ts` | 12 pass, 0 fail, 56 expects |
| Independent late-rejection/hanging-stub test | 53 ms timeout; 0 unhandled rejections; no credential leak |
| Independent repeated-hanging-stub test | 20/20 timeouts; no app-owned active timer handles |
| `bun run typecheck` | `src/ typechecks clean` |
| `bun run test:unit` | 498 pass, 156 skip, 0 fail; 654 tests |
| `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` | 140 pass, 0 fail, 0 skip; 140 tests across all 8 DB suites |
| `bunx prettier --check src/readiness.ts src/readiness.test.ts src/index.ts src/db.integration.test.ts README.md` | passed |
| `git diff --check f1aee7d..2c83751` | clean |

## Repository state

- Review artifact intentionally left **uncommitted** because the verdict is FAIL.
- Before this review artifact was written, `HEAD` and `origin/main` were both `2c837519db41597d26e84e585c8f20b836ee716c`.
- No S7 acceptance commit was made or pushed by reviewer-terra.
