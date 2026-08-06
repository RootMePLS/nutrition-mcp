# S8 reviewer-terra re-review 2 — FAIL

- Review date: 2026-08-06
- Reviewed remediation range: `07ab6b1032fc4cd9a3062576a3526fa486452ac0..c3a3e0ec5428714f9cd1a7c933378f1904382627`
- Reviewed full S8 chain: `3972a5fc9f7a95880e997b89eac174c133ef70f8..c3a3e0ec5428714f9cd1a7c933378f1904382627`
- Reviewed HEAD: `c3a3e0ec5428714f9cd1a7c933378f1904382627` (`origin/main` was identical during the review)
- Immutable prior review SHA-256: `25548f69a02c2d7c680f467383926663468c0e2beec67adc427734350cde6031` — verified.
- Verdict: **FAIL — request changes.** Do not create an acceptance commit or push.

## Blocking finding: unproven client compatibility remains

The remediation correctly removes all 21 positive current OAuth/account/auth-token/Supabase claims identified in the immutable first review. The surviving OAuth mentions in the narrow sweep are semantically negative statements, and are allowed: the first review's required no-auth sentence necessarily contains the word `OAuth`. The apparent prior-review tension is therefore resolved by meaning, not raw grep count: truthful negative/historical references are permitted; positive or implied current capability claims are not.

However, the handoff's claim that no client compatibility is asserted is false. This repository proves only that its own server exposes a remote HTTP MCP endpoint without the removed authentication layer. It does not independently demonstrate an unauthenticated remote-HTTP-MCP connection from Claude or ChatGPT. Definite public statements that a Claude or ChatGPT account is sufficient, that users can add this endpoint in Claude, or that the service works with Claude/ChatGPT/any MCP client imply precisely that unproven compatibility.

### Required remediation (source first; do not hand-edit generated files)

1. In `public/index.html`, replace the JSON-LD plus visible duplicate free-answer text at `:110` and `:2818`:

   `Yes, it is completely free — no premium tiers, ads, or hidden costs. You just need a Claude or ChatGPT account to connect.`

   with:

   `The server does not charge a fee. Connection depends on your client's support for unauthenticated remote HTTP MCP servers; check your client's documentation.`

   Replace the hero imperative at `:231`, `Connect Claude or ChatGPT, then just say what you ate`, with `Connect a client that supports unauthenticated remote HTTP MCP, then just say what you ate.` Do not name a client as known-compatible without an independently repeatable unauthenticated connection proof.

2. In `scripts/gen-alternatives.ts`, replace every stated Claude/ChatGPT compatibility or account-sufficiency promise at current `:91`, `:240`, `:244`, `:328`, and the fallback `:689` with wording that makes no client-specific assertion. A safe replacement for the account-sufficiency clause is:

   `The server has no Nutrition MCP account or sign-in step; connection depends on your client's support for unauthenticated remote HTTP MCP servers.`

   Rewrite the generated connector answer at `:670` to say only that the endpoint is `https://nutrition-mcp.com/mcp`, that it has no sign-in step, and that the reader must check the client's documentation for unauthenticated remote-server support. Remove `add ... as a custom connector in Claude` unless demonstrated.

3. In the alternatives-hub template in `scripts/gen-alternatives.ts`, replace current `:1111` (`can't connect to Claude or ChatGPT`) and `:1208-1209` (`it works with Claude, ChatGPT, and any MCP client`) with neutral endpoint/client-support wording. Also audit its generated `public/alternatives/index.html` output.

4. Regenerate all seven generator outputs (`public/alternatives/{myfitnesspal,cronometer,lose-it,macrofactor,yazio,lifesum,index}.html`) using `bun run scripts/gen-alternatives.ts`, apply the project formatter, run the generator and formatter a second time, and supply a zero-diff/hash-equality proof. Re-run the named-client and account-sufficiency grep after regeneration. The six application outputs and the hub must agree with `scripts/gen-alternatives.ts`.

## Auth and legal truth audit

- All 21 former positive claims have been removed or converted to semantically negative no-auth statements. The narrow command still prints four permitted README historical/negative lines and 20 negative public/source lines. Those 20 are not capability claims and are permissible under the stated semantic resolution.
- `public/index.html` JSON-LD and visible FAQ copies agree: programmatic normalized-text comparison passed for the ChatGPT, other-clients, and data-privacy answers (3/3).
- Privacy and terms no longer claim registration, an authentication provider, OAuth credential retention, account recovery, or account deletion. Their negative no-auth wording matches the static runtime inventory.
- The deletion wording is materially supported: `src/mcp.ts:4608-4653` invokes `deleteAllUserData`, and `src/db.ts:1081-1114` removes meal events and their listed child rows, `tool_analytics`, water, weight, goals, profiles, and `./exports/<user>/meals.csv`. `src/analytics.ts:85-113` persists only the listed tool telemetry fields to local PostgreSQL; the policy's description of telemetry removal by the delete tool is consistent.
- Humanizer review of new prose: the no-auth/deletion sentences are clear, concrete, and not promotional. The client-compatibility sentences above are the exception: they are invented product promises, so this review fails.

## Scope and prior S8 rechecks

- Full S8 chain consists of the intended cleanup/remediation paths: 12 `supabase/migrations/*.sql` deletions, `docs/google-auth-setup.md` deletion, `src/supabase.test.ts` -> `src/db-helpers.test.ts` rename at 98% similarity, comment/doc truth edits, the harness repair, and the public/remediation files. `db/migrations` was not touched.
- `supabase/`, `docs/google-auth-setup.md`, and `src/supabase.test.ts` are absent from tracked HEAD; no tracked old-path references (`google-auth-setup`, `supabase/migrations`, `supabase.js`, `supabase.test`) survive outside the deliberate exclusions.
- `src/db-helpers.test.ts` still describes DB helpers (`mealIdempotencyKey`, profile helpers, `fetchAllPages`); the rename is accurate.
- `CLAUDE.md` accurately states that analytics persist to PostgreSQL `tool_analytics`; code uses `getPool().query(INSERT INTO tool_analytics ...)` at `src/analytics.ts:85-113`.
- `scripts/widget-harness.ts` imports `MealInput`/`MealInsertResult` from `src/db.js` and supplies compatibility provenance. No runtime/schema/provider/version/S9 drift was found in this remediation range.

## Independent verification evidence

- Narrow grep: 24 total survivors: four README historical/negative lines and 20 semantically negative no-auth public/source lines. No positive OAuth, Google/email account, Supabase Auth, token, authorization-code, or registration claim remains.
- Broad grep found the blocking client-compatibility phrases listed above, plus unrelated Google Analytics/Fonts and contact-email references.
- Generator proof: ran `bun run scripts/gen-alternatives.ts`, formatted all seven outputs, captured SHA-256 values, repeated generator plus formatting, and got zero diff between hash lists. The six pages and hub were unchanged from HEAD after this proof. Second-run hashes:
  - cronometer `42b2775cda8bd55ff43bf52dd926b8bbf134d2c7a39731ee22658b5495349bca`
  - lifesum `ed2faa7a57695b882e8d21c8e16e0af0de378e13c003b7b8ed229d40fd5e3f54`
  - lose-it `c4360b88f89f7a39e4046764fc12271c389f7958eb27f7fc9aeabe48a045e834`
  - macrofactor `4c321a32597fe3abfe4eabb69119499d563858522eba1db366b473df2440a287`
  - myfitnesspal `b294e750a6bcbbdbd737134a60c494b708b8e20c64a8a90d7b663e4c1c5afcb6`
  - yazio `f8281e12025317274b0f74f70db92d972661b0aa147cc152bbd055302fae5ecb`
  - index `4e7682d09eabd2c07d678b9ac85c88cbd339c56ab582a839639a83f7456eb3cb`
- JSON-LD: all 15/15 blocks across `public/index.html` and seven alternatives outputs parse as JSON.
- HTML: Prettier parsed and checked all changed public/generator files successfully. An independent default `html-validate` run reported 298 existing repository-style/accessibility errors (lowercase doctype, XHTML-style void tags, inline styles, landmark naming, and title length), including unchanged head/layout lines. It did not identify a remediation-line structural parse failure; this pre-existing baseline is not the S8 blocker.
- Focused affected tests: `bun test src/db-helpers.test.ts src/mcp.test.ts src/import.test.ts src/foods.test.ts src/insights.test.ts src/food-tracking-docs.test.ts` — 235 pass, 0 fail.
- `bun run typecheck` — pass (`src/ typechecks clean`).
- Strict standalone widget-harness TypeScript compile — pass.
- Harness: started on `http://127.0.0.1:8788`; `GET /` and `GET /host?widget=import-meals` returned expected content. A reset then valid import POST returned `status=success`, `created=1`, `provenance_status=compatibility`, `event_version=1`, `has_calculation_bundle=false`. Process was killed; port 8788 has no listener.
- `bun run test:unit` — 498 pass, 156 skip, 0 fail; 654 tests.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` — 140 pass, 0 fail, 0 skip across all eight required DB suites (8, 41, 13, 20, 20, 7, 23, 8).
- `bunx prettier --check public/index.html public/privacy.html public/terms.html scripts/gen-alternatives.ts public/alternatives/*.html` — pass.
- `git diff --check <full-S8-range>` and `git diff --check HEAD` — pass before this review artifact was written.

## Disposition

This immutable re-review is intentionally left uncommitted as required for FAIL. No review commit was created and no push was made. At review start and before adding this artifact, local `HEAD` and `origin/main` were both `c3a3e0ec5428714f9cd1a7c933378f1904382627`; remediation is required before S8 can be accepted.
