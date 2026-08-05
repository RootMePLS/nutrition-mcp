# S8 remediation handoff 2 — public auth copy aligned with no-auth runtime

Date: 2026-08-06
Slice: S8 remediation of `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review.md` (FAIL, 21 blocking findings)
Coder: coder-kimi
Parent HEAD: `07ab6b1032fc4cd9a3062576a3526fa486452ac0` (retained as parent; nothing rebased or rewritten)
Scope honored: S8 remediation only. No S9, no `db/migrations/*`, no runtime/schema/provider/version changes. The Terra review file is preserved byte-identically: SHA-256 `25548f69a02c2d7c680f467383926663468c0e2beec67adc427734350cde6031`, verified before and after the work.

## Remediation of the 21 blocking findings

The exact safe sentence from the Terra review was used wherever grammar permitted:

`Connect using a client that supports this server's remote HTTP MCP endpoint. This checkout does not implement OAuth, Google or email/password accounts, account registration, access or refresh tokens, or authorization codes.`

1. `public/index.html:86` (JSON-LD ChatGPT answer) — rewritten. No OAuth, no sign-in, no "works on every plan" claim. States the endpoint, carries the mandated sentence verbatim, and says connection depends on the client's support for unauthenticated remote MCP servers (no undemonstrated compatibility claim).
2. `public/index.html:94` (JSON-LD other-clients answer) — now the mandated sentence verbatim plus "check your client's documentation"; the OAuth 2.0/PKCE requirement and the named-client compatibility list are gone.
3. `public/index.html:226` (hero eyebrow) — "Free · Open source · OAuth 2.0" -> "Free · Open source · No sign-up".
4. `public/index.html:636-641` (install section-sub) — now the mandated sentence verbatim inside the existing paragraph markup.
5. `public/index.html:728-732` (Claude install step) — login-page/Google/email-password copy replaced: "Click Connect. There is no login page or sign-in: this checkout has no account or authentication layer."
6. `public/index.html:779-784` (ChatGPT Authentication step) — "choose OAuth" replaced with "select the option for no authentication: this server does not implement OAuth, accounts, or authorization codes."
7. `public/index.html:793-799` (ChatGPT sign-in step) — "Sign in with Nutrition" login-page step replaced with "Start logging by saying what you ate. There is no sign-in step: this checkout has no login page, accounts, or passwords."
8. `public/index.html:826-829` (other-clients note) — "Your client handles the OAuth login automatically" replaced with "There is no login step: this checkout does not implement OAuth, accounts, access or refresh tokens, or authorization codes."
9. `public/index.html:2770-2797` (visible FAQ) — both duplicates updated consistently with their JSON-LD answers (finding 1 and 2 wording).
10. `scripts/gen-alternatives.ts:955-963` — the one source site changed once: the section-sub now carries the mandated sentence verbatim within its existing markup.
    11-16. `public/alternatives/{cronometer,lifesum,lose-it,macrofactor,myfitnesspal,yazio}.html` — regenerated with the real generator (`bun run scripts/gen-alternatives.ts`), never hand-edited; see "Generator synchronization" below.
11. `public/privacy.html:83-89` — registration/Supabase-Auth-password/Google paragraph replaced: "There is no registration. This checkout has no account or authentication layer, so we never collect an email address, a password, or a Google sign-in, and the server issues no OAuth tokens or authorization codes."
12. `public/privacy.html:146-150` — OAuth access/refresh token and authorization-code retention paragraph replaced with a negative statement: "We do not hold OAuth access tokens, refresh tokens, or authorization codes: the server has no sign-in layer, so there are no credentials of that kind to store."
13. `public/privacy.html:200-204` — "Authentication is handled by Supabase Auth" removed; the section now says PostgreSQL + DigitalOcean and "There is no authentication provider: this checkout has no account or auth layer."
14. `public/terms.html:259-263` — "Supabase for authentication" removed from the third-party list; DigitalOcean/PostgreSQL, Open Food Facts, and the AI assistant remain.
15. `public/terms.html:265-272` — "Google Sign-In if you choose that way of logging in" removed from the website third-party list; Google Analytics, Google Fonts, jsDelivr, and the GitHub API remain (truthful, unrelated to auth).

## Additional closures from the broad auth-concept sweep

These were not in Terra's 21 but violated the same no-current-capability rule, so they were fixed in the same pass:

- `public/index.html:142` + its visible duplicate (was 2864-2873) — "Is my data private?" claimed a personal account, an authenticated session, and account deletion. Rewritten: PostgreSQL storage, never sells or shares, no account or sign-in layer, delete any entry or all stored data via the assistant (the runtime `delete_account` tool at `src/mcp.ts:4608` -> `deleteAllUserData` at `src/db.ts:1081` proves entry-level and full deletion).
- `public/index.html` "Export & own your data" card — "delete your account and data" -> "delete any entry or all of your stored data".
- `public/index.html` trust item — "Remove your account & data." -> "Remove any entry or all stored data."
- `scripts/gen-alternatives.ts:584` — "or delete your account" -> "or delete it all" (flows into all six outputs).
- `scripts/gen-alternatives.ts:630` — install step "Click Connect, sign in, and start logging" -> "Click Connect and start logging by saying what you ate. There is no sign-in step." (flows into all six outputs).
- `scripts/gen-alternatives.ts:670` — connect FAQ "..., sign in, and start logging by conversation." -> "... and start logging by conversation. There is no sign-in step." (JSON-LD + visible, all six outputs).
- `public/privacy.html` meta description/og/twitter (3x) — "how to delete your account and everything in it" -> "how to delete your stored data at any time".
- `public/privacy.html` telemetry bullet — "It is linked to your account id." removed; the recorded fields list (which includes the MCP session id, proven by `src/analytics.ts` `mcp_session_id`) stands.
- `public/privacy.html` alcohol paragraph — "or delete your account" -> "or remove all of your stored data as described below".
- `public/privacy.html` server-telemetry bullet — "linked to your account id" and "deleted ... when you delete your account" -> "not linked to what you logged" and "removed by the delete tool described below".
- `public/privacy.html` Data deletion section — rewritten: no account to close; per-entry deletion via the assistant; the server's delete tool permanently removes meal/water/weight logs, goals, profile settings, tool-usage telemetry, and any stored CSV export (matches `deleteAllUserData` exactly); immediate and irreversible; includes alcohol figures.
- `public/terms.html` meta description — "covering accounts, acceptable use" -> "covering acceptable use".
- `public/terms.html` Agreement — "By creating an account or connecting" -> "By connecting an AI assistant to the server or using the website".
- `public/terms.html` "Your account" section — renamed "Access" and rewritten: 16+ age confirmation, no account or authentication layer, no registration, no credentials, no email on file, no account recovery.
- `public/terms.html` acceptable use — "attempt to access another user's account or data, or to bypass authentication, rate limits" -> "attempt to access or delete data you did not log, or to bypass rate limits or any other technical control".
- `public/terms.html` export paragraph — "switched on for your account" -> "switched on in your settings".
- `public/terms.html` telemetry paragraph — "linked to your account id" and account-deletion tail removed, same pattern as privacy.
- `public/terms.html` deletion paragraph — "delete your account" -> "delete all of your data"; notes there is no separate account record because there is no account layer.
- `public/terms.html` Termination — "delete your account as described above" -> "remove your stored data as described above".
- Both legal pages: "Last updated: July 26, 2026" -> "August 6, 2026" (the content materially changed today).

## Generator synchronization

- Source changed once per shared site (`scripts/gen-alternatives.ts`: feature card, INSTALL step, connect FAQ, section-sub), then the real generator ran:
    - Run 1: `bun run scripts/gen-alternatives.ts` wrote all six app pages plus the hub. Raw generator output is unwrapped; the committed artifacts are Prettier-formatted, so `bunx prettier --write public/alternatives/*.html` was applied (the project formatter, not hand edits). Result: the six app pages each diff by exactly the four copy changes above; `public/alternatives/index.html` (hub) is byte-identical to HEAD (it carries none of the changed fragments).
    - Run 2 (zero-diff proof): SHA-256 of all seven outputs recorded, generator rerun, Prettier reapplied, hashes re-recorded — `diff` of the two hash lists is empty. Second run: zero diff, byte-identical.
- No generated output was hand-edited.

## Grep inventories

### Narrow sweep

`git grep -inE 'supabase|google-auth|oauth|account-registration' -- ':!.hermes' ':!db/migrations'`

- The four Terra-approved README lines survive: `README.md:13`, `:123`, `:212`, `:219` (negative/historical only).
- Every other hit is a line of the mandated negative sentence or an equivalent negative statement introduced by this remediation: `public/index.html:86,94,142,638,782,827,2775,2790,2879`; `public/alternatives/*.html` (one line each, the section-sub); `public/privacy.html:87,147`; `scripts/gen-alternatives.ts:959`. All read "does not implement / no / we do not hold" — no positive claim. Note: Terra item 1 mandates the exact sentence, which itself contains the word "OAuth", so these negative lines are the intended shape of the fix; item 6's "only four README lines" is satisfied for every pre-existing survivor — nothing old remains.

### Broad sweep

`git grep -inE 'oauth|google|email|password|account|access.?token|refresh.?token|authorization.?code|supabase' -- public/index.html public/alternatives scripts/gen-alternatives.ts public/privacy.html public/terms.html` (plus `sign.?in|sign.?up|login|register|registration|pkce|credential|authenticate`)

Surviving lines, justified line by line by class:

1. Negative no-auth statements introduced by this remediation (all "does not implement / no sign-in / no account / we do not hold") — the fix itself, not claims.
2. Third-party client account mentions: "You only need a Claude or ChatGPT account to connect" (`public/index.html:110,2820`; alternatives FAQ answers; `scripts/gen-alternatives.ts:91,240,244,328,689`) — the account belongs to the AI client, not to this service; plain non-auth use, and it asserts no capability of this checkout.
3. Competitor comparison lines: "A separate app and account" cons (`gen-alternatives.ts:83,169,257` + outputs), "no account to juggle" (`:176` + output), "no X account, no app" (`:990` + outputs), "another app, account, and paywall" (`public/index.html:2568`) — statements about the other apps, or negative statements about this one.
4. Google Analytics / Google Fonts / gtag / preconnect lines in all pages and `HEAD_ASSETS` — measurement and font loading, unrelated to authentication; the privacy policy discloses them accurately.
5. Contact email lines (`public/index.html:2715,2723,2730`; `public/terms.html:358`; `gen-alternatives.ts:16` comment) — support contact and CSS class names, not auth.
6. `public/privacy.html:171-197` — Google Analytics/Fonts disclosure paragraphs, truthful and unrelated to auth.

No current auth, account, token, authorization-code, or registration capability claim remains in the swept files.

## Humanizer audit (new prose only)

- Plain, specific, natural: every replacement says what the checkout does or does not do in short declarative sentences.
- No invented capability: no client is represented as compatible; the copy says connection depends on the client's own unauthenticated remote-MCP support. Deletion copy is limited to what `delete_account`/`deleteAllUserData` provably removes. Export/rate-limit copy was already true (`src/export.ts` 60-minute TTL; `src/rate-limit.ts` via `src/index.ts:106`).
- No em dashes were added in any new prose (pre-existing em dashes elsewhere in the pages were left alone).
- The mandated sentence appears verbatim at `public/index.html:94` (JSON-LD), `public/index.html:636-641` (install sub), `scripts/gen-alternatives.ts:957-963` and its six outputs, and in adapted form everywhere grammar required adaptation.

## Prior S8 acceptances re-verified (still true)

- All 12 `supabase/migrations/*.sql` deleted; `supabase/` absent; `docs/google-auth-setup.md` absent (`git ls-files` shows only the two historical `.hermes` plan docs, which are excluded scope).
- `src/supabase.test.ts` -> `src/db-helpers.test.ts` rename intact; old name absent.
- `CLAUDE.md:7` analytics sentence matches `src/analytics.ts:88` `INSERT INTO tool_analytics` via `getPool()`.
- `scripts/widget-harness.ts:26` imports from `../src/db.js`; `HARNESS_PROVENANCE` present at `:35`.
- `db/migrations` untouched in this remediation; no runtime, schema, provider, version, or S9 change (`git diff --stat` touches only the 10 public/generator files + the two plan docs).

## Verification results (all commands actually run)

- Harness strict compile: `bunx tsc --noEmit --strict --skipLibCheck --noUncheckedIndexedAccess --target esnext --module preserve --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax scripts/widget-harness.ts` — PASS.
- Harness run: `bun run scripts/widget-harness.ts` (listens on its default `http://localhost:8787`); `/` and `/host?widget=import-meals` returned expected content; `POST /tool/bulk_import_meals` with one valid row (`source_line:1`, `expected_row_count:1`, `expected_total_kcal:450`) returned `status: success`, `created: 1`, `provenance_status: compatibility`, `event_version: 1`, `has_calculation_bundle: false`. Process killed; `lsof -iTCP:8787 -sTCP:LISTEN` empty and curl refused — no listener remains.
- Focused affected suites: `bun test src/db-helpers.test.ts src/mcp.test.ts src/import.test.ts src/foods.test.ts src/insights.test.ts src/food-tracking-docs.test.ts` — 235 pass, 0 fail.
- `bun run typecheck` — src/ typechecks clean.
- `bun run test:unit` — 498 pass, 156 skip, 0 fail; 654 tests.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` — 140 pass, 0 fail, 0 skip; 8 DB suites (db.integration 8, meal-events 41, calculation-bundles 13, meal-captures 20, mcp-food-tracking 20, backup-policy 7, legacy-meal-tools 23, calculation-acceptance 8).
- Changed parseable files: `bunx prettier --check public/index.html public/privacy.html public/terms.html scripts/gen-alternatives.ts public/alternatives/*.html` — all pass. The immutable Terra review file is excluded from formatting by design (byte-preserved evidence); it was not Prettier-clean on arrival and must stay exactly as delivered.
- JSON-LD structure: all `application/ld+json` blocks in `public/index.html` and all seven `public/alternatives/*.html` files parse as valid JSON (script check, 15/15 blocks).
- HTML structure: tag-balance check on the three edited pages — balanced; Prettier's HTML parse of every changed file also passes.
- `git diff --check` — clean.

## Commit

One commit: `docs: align public auth copy with no-auth runtime` — the 10 modified public/generator files, this handoff, and the immutable Terra FAIL review file (added unmodified, SHA-256 above). Pushed after green gates; working tree left clean.
