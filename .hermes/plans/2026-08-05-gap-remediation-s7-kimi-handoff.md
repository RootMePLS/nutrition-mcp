# S7 handoff — Database readiness distinct from process health

Date: 2026-08-06
Coder: coder-kimi
Slice: S7 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` (lines 507–549)
Base HEAD: `f1aee7de563f3800422787d97f743827349316cb` (clean tree at start)

## Scope delivered

- `GET /ready` performs a real `SELECT 1` through the shared PostgreSQL pool
  (`getPool()` from `src/db.ts`) under a hard 2-second ceiling. 200 only after
  the query actually succeeds; 503 with a redacted, actionable target on any
  failure. `/health` is untouched (still `c.text("ok")`, no DB access) and both
  paths are excluded from the access log. Server startup is never blocked;
  no retry loops.
- New `src/readiness.ts`:
    - `checkDatabaseReadiness(pool, options?)` —
      `Promise<{ ok: true } | { ok: false; error: string }>`. Options:
      `timeoutMs` (default `READINESS_TIMEOUT_MS = 2000`), `databaseUrl`
      (defaults to `process.env.DATABASE_URL`; an explicitly passed key, even
      `undefined`, wins so tests can simulate a missing URL).
    - `redactDatabaseUrl(url)` — pure; yields `host[:port][/database]` only.
- README: `/health` documented as pure liveness, `/ready` as DB readiness with
  a 503 troubleshooting paragraph; API endpoint table updated.

Out of scope, untouched: migrations, MCP schemas/tools, providers, captures,
S8 cleanup, version bump.

## TDD evidence

### RED (before implementation, module missing — the right reason)

```
$ bun test src/readiness.test.ts
error: Cannot find module './readiness.js' from '.../src/readiness.test.ts'
 0 pass / 1 fail / 1 error

$ DATABASE_URL=... DATABASE_URL_TEST=... bun test src/db.integration.test.ts
error: Cannot find module './readiness.js' from '.../src/db.integration.test.ts'
 0 pass / 1 fail / 1 error
```

### GREEN

```
$ bun test src/readiness.test.ts
 12 pass, 0 fail, 56 expect() calls

$ DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
  DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/db.integration.test.ts
 8 pass, 0 fail, 52 expect() calls   (5 pre-existing + 3 new readiness/route cases)
```

### REFACTOR

None (plan expected none). One semantics fix during GREEN: explicit
`databaseUrl: undefined` now beats the env fallback (`"databaseUrl" in options`),
because Bun auto-loads `.env` and `??` masked the simulated missing-URL case.

## Timeout semantics

- The probe races `pool.query("SELECT 1")` against a `setTimeout` of
  `timeoutMs` (default 2000ms — hard maximum; the `/ready` route uses the
  default, so the probe can never exceed 2s).
- On timeout the error is
  `database not ready: probe timed out after <N>ms (target <redacted>)`.
- The losing probe promise keeps its `Promise.race` handlers attached, so a
  late driver rejection cannot become an unhandled rejection; the timer is
  always cleared in `finally`. No background work or retries survive a
  failed/timed-out probe.
- Unit proof: a never-resolving stub pool with `timeoutMs: 50` fails in
  < 2s (asserted elapsed) with the timeout message. Integration proof: wrong
  port 5439 fails bounded (asserted elapsed < 5s; actual ~5ms, ECONNREFUSED).

## Redaction semantics

- Output identity is exactly `host[:port][/database]` parsed via `new URL()`;
  userinfo, query string, and fragment are structurally dropped (never
  substring-filtered), so percent-encoded credentials
  (`user%40corp:p%40ss%3Aw0rd`) leak neither raw nor decoded.
- Malformed input (unparseable, empty host) → fixed label
  `invalid DATABASE_URL`; missing/blank input → `missing DATABASE_URL`.
  Raw input is never echoed.
- Failure errors never include the raw driver message (`catch` discards it);
  only the failure class (`connection failed` / `timed out after <N>ms`) plus
  the redacted target.
- Unit fixtures proving non-leakage: password-bearing URL, percent-encoded
  credentials, query+fragment, host-only, host+db-no-port, malformed values,
  missing values, a non-ASCII credential fixture, and a meta-test asserting no
  fixture output contains its own secrets, `@`, `?`, or `#`.
- Leak grep over runtime test output for all fixture credentials
  (`s3cr3t`, `hunter2`, `长密码`, `wrong_port_pw`, `wrong_port_user`,
  `live_s3cr3t_pw`, `p%40ss`): **no matches**.

## Live-server curl evidence (temporary ports, both servers killed)

Server 1 — `PORT=49321 DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test bun src/index.ts`:

```
GET /ready  -> body: ok                              HTTP 200
GET /health -> body: ok                              HTTP 200
```

Server 2 — `PORT=49322 DATABASE_URL='postgres://live_user:live_s3cr3t_pw@localhost:5439/nope?sslmode=require#frag' bun src/index.ts`:

```
GET /health -> body: ok                              HTTP 200
GET /ready  -> body: {"error":"database not ready: connection failed (target localhost:5439/nope)"}   HTTP 503
              (wall time 0.020s; body contains no username, password, query, or fragment)
```

Listener cleanup: after `kill` + graceful shutdown, `lsof -iTCP:49321 -sTCP:LISTEN`
and `lsof -iTCP:49322 -sTCP:LISTEN` both return nothing — no listener remains.
(Note: with `sslmode=require` in the URL, the `pg` driver prints its standard
SSL-mode deprecation warning to server stderr; it contains no credentials and
never reaches the HTTP response.)

Route-level test evidence additionally lives in `src/db.integration.test.ts`:
`/ready` 200 + `/health` 200/`ok` asserted through the real app wiring
(`import("./index.js")` default export `.fetch`), proving 200 requires a real
successful `SELECT 1` against the live test DB and `/health` is unchanged.

## Gate battery (all green, run after final formatting)

```
bun run typecheck        -> src/ typechecks clean
bun run test:unit        -> Unit gate totals: 498 pass, 0 fail, 156 skip, 654 tests
bun run test:db          -> DB gate totals: 140 pass, 0 fail, 0 skip, 140 tests across 8 DB suites
                            (db.integration.test.ts 5 -> 8 pass; all other suites unchanged)
git diff --check         -> clean (silence)
bunx prettier --check src/readiness.ts src/readiness.test.ts src/index.ts \
    src/db.integration.test.ts README.md
                         -> All matched files use Prettier code style
```

Counts vs campaign baseline (unit 445/84/0, db 82/0/0/7): both grew through
S1–S6 and this slice (unit 498 pass/156 skip/0 fail; db 140/0/0 across the
8-suite gate). No shrink.

## Commits

1. `1bea699` — `feat: add database readiness probe with redacted diagnostics`
   (src/readiness.ts, src/readiness.test.ts, src/index.ts,
   src/db.integration.test.ts, README.md)
2. (this file) — `docs: record S7 readiness evidence`

## Known limitations

- The 503 body intentionally does not distinguish sub-causes beyond
  `connection failed` vs `timed out` — raw driver detail is deliberately
  suppressed to guarantee no credential/detail leakage.
- A probe that times out leaves the underlying `pg` connection attempt to
  finish on its own (handled, unretried); bounded by the driver's own connect
  behaviour, invisible to the caller.
