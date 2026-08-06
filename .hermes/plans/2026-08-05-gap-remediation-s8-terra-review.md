# S8 reviewer-terra verdict — FAIL

- Review date: 2026-08-06
- Required range: `3972a5fc9f7a95880e997b89eac174c133ef70f8..07ab6b1032fc4cd9a3062576a3526fa486452ac0`
- Reviewed HEAD: `07ab6b1032fc4cd9a3062576a3526fa486452ac0`
- Governing criterion: one truthful repository architecture, including tracked public/generated/legal copy; a handoff's future-product/legal classification cannot override this criterion.
- Verdict: **FAIL — request changes.** Do not accept or add a review commit; do not push.

## Blocking finding: repository-truth drift remains

The runtime does not provide OAuth, Google/email account registration, Supabase Auth, access/refresh tokens, or authorization codes. The tracked public website nevertheless represents those features as present. This is not an allowed README historical/negative warning: it is current-tense product, install, and legal copy. `src/index.ts` has no auth/OAuth routes or imports; the tracked runtime/auth scan found no `src/oauth.ts`, `src/supabase.ts`, `/authorize`, `/token`, or auth-provider import. The only runtime references found were unrelated Google Analytics CSP hosts.

The following surviving claims contradict the no-auth runtime:

1. `public/index.html:86` — JSON-LD says to create a ChatGPT app "using OAuth" and sign in.
2. `public/index.html:94` — JSON-LD says supported clients require OAuth 2.0 with PKCE.
3. `public/index.html:226` — current product eyebrow advertises OAuth 2.0.
4. `public/index.html:636-639` — current install copy promises OAuth 2.0/PKCE plus Google/email-password account creation/sign-in.
5. `public/index.html:727-729` — Claude install steps promise a login page, Google sign-in, and email/password sign-in.
6. `public/index.html:779-781` — ChatGPT install steps instruct the user to select OAuth.
7. `public/index.html:792-796` — ChatGPT install steps promise a Nutrition login page and Google/email-password sign-in.
8. `public/index.html:825-826` — other-client install copy says OAuth login is handled automatically.
9. `public/index.html:2770-2784` — visible FAQ duplicates the OAuth/sign-in and OAuth 2.0/PKCE claims from JSON-LD.
10. `scripts/gen-alternatives.ts:956-958` — generated source promises OAuth 2.0/PKCE and Google/email-password account creation.
11. `public/alternatives/cronometer.html:539-541` — generated OAuth/account claim.
12. `public/alternatives/lifesum.html:528-530` — generated OAuth/account claim.
13. `public/alternatives/lose-it.html:523-525` — generated OAuth/account claim.
14. `public/alternatives/macrofactor.html:533-535` — generated OAuth/account claim.
15. `public/alternatives/myfitnesspal.html:538-540` — generated OAuth/account claim.
16. `public/alternatives/yazio.html:533-535` — generated OAuth/account claim.
17. `public/privacy.html:84-88` — current registration with a Supabase Auth password and Google sign-in.
18. `public/privacy.html:149-151` — retained OAuth access/refresh tokens and authorization codes.
19. `public/privacy.html:204-206` — current Supabase Auth claim.
20. `public/terms.html:260-263` — current Supabase authentication dependency.
21. `public/terms.html:268-269` — current Google Sign-In option.

The following are the only `supabase|google-auth|oauth|account-registration` grep survivors outside `.hermes` and `db/migrations` that are acceptable, because they are line-by-line negative/historical statements rather than claims of a current capability:

- `README.md:13` — says there is no Supabase, OAuth, email/password, or account-registration step.
- `README.md:123` — says older Supabase/OAuth/email-password deployment notes are obsolete.
- `README.md:212` — says old OAuth discovery/registration/authorize/approve/token paths are not part of this runtime.
- `README.md:219` — says the checkout does not provide Supabase or OAuth services.

Unrelated mentions of Google Analytics, Google Fonts, `external_write_authorized`, and CSS selector comments were inspected and are not authentication/account claims.

## Exact required coder-kimi remediation

1. Replace every current auth claim above with no-auth copy. The exact safe replacement sentence for the install/connection contexts is:

    `Connect using a client that supports this server's remote HTTP MCP endpoint. This checkout does not implement OAuth, Google or email/password accounts, account registration, access or refresh tokens, or authorization codes.`

    Adapt only surrounding grammar/HTML structure; do not represent a specific third-party client as compatible unless its unauthenticated connection path is actually demonstrated.

2. In `public/index.html`, update both the JSON-LD answers and their visible FAQ duplicates consistently. Remove the OAuth eyebrow. Replace all Claude/ChatGPT/other-client instructions that select OAuth, open a login page, or sign in through Google/email-password with a truthful generic endpoint/configuration statement. Keep the self-host PostgreSQL edit already made.

3. In `public/privacy.html`, remove or rewrite the registration/password/Google paragraph, OAuth-token/authorization-code retention paragraph, and Supabase Auth storage statement so the policy describes only behavior the checkout implements. Do not claim account deletion/authenticated sessions/access-token deletion unless runtime code proves them.

4. In `public/terms.html`, remove Supabase-for-authentication and Google Sign-In claims. Do not retain a current account/auth claim unless runtime code proves it.

5. Change the source of the generated alternatives once in `scripts/gen-alternatives.ts` to the exact no-auth sentence above (within its existing paragraph markup), then regenerate all six `public/alternatives/*.html` outputs. Verify byte-for-byte source/output synchronization using the project generator and a clean `git diff`; do not hand-edit outputs alone.

6. Re-run the complete case-insensitive tracked-file sweep after remediation:

    ```bash
    git grep -inE 'supabase|google-auth|oauth|account-registration' -- ':!.hermes' ':!db/migrations'
    git grep -inE 'oauth|google|email|password|account|access.?token|refresh.?token|authorization.?code|supabase' -- public/index.html public/alternatives scripts/gen-alternatives.ts public/privacy.html public/terms.html
    ```

    The first command must return only the four explicitly justified README lines above. The second must contain no current capability/product/legal claim for OAuth, Google/email accounts, Supabase Auth, tokens, authorization codes, or registration; unrelated font/analytics/contact-email mentions need not be removed.

## Non-blocking acceptance checks that passed

### Scope and deleted inventory

- Range contains 29 files: 13 deletions, one 98%-similarity rename, 14 source/doc/config modifications, and the coder handoff.
- All 12 tracked `supabase/migrations/*.sql` files are deleted at HEAD; `supabase/` is absent.
- `docs/google-auth-setup.md` is deleted.
- `db/migrations` has no changed file in the reviewed range.
- No tracked references remain to `google-auth-setup`, `supabase/migrations`, `supabase.js`, or `supabase.test` outside the allowed exclusions.
- No behavior/schema/provider/version/S9 drift was found beyond the necessary dev-harness repair.

### Rename and analytics truth

- `src/supabase.test.ts` was renamed to `src/db-helpers.test.ts` at 98% similarity. Its six describe blocks cover `mealIdempotencyKey`, three profile DB helpers, no-profile defaults, and `fetchAllPages`; the new name accurately describes that subject.
- The only body changes are two comments; test coverage was retained. Focused renamed suite passed.
- `CLAUDE.md` now accurately says analytics persist in local PostgreSQL. `src/analytics.ts:86-102` calls `getPool().query()` with `INSERT INTO tool_analytics`.

### Widget harness

- `scripts/widget-harness.ts` correctly changes the nonexistent type import from `../src/supabase.js` to `../src/db.js`.
- `MealInsertResult` requires `provenance`; the new `HARNESS_PROVENANCE` is constructed with `writeProvenanceFields({ version: 1, provenance_status: "pending", compatibility: true })`, matching the real legacy compatibility-write semantics. Both create and dedup responses supply it.
- Standalone strict TypeScript compilation of `scripts/widget-harness.ts` passed. The scoped project gate also passed.
- Started the harness at `http://127.0.0.1:8788`; `/` and `/host?widget=import-meals` returned expected content. A POST to `/tool/bulk_import_meals` with a valid row returned `status: success`, `created: 1`, `provenance_status: compatibility`, `event_version: 1`, and `has_calculation_bundle: false`. The server was explicitly killed after validation; no harness server remains.

### Commands run

- Focused affected suites: `bun test src/db-helpers.test.ts src/mcp.test.ts src/import.test.ts src/foods.test.ts src/insights.test.ts src/food-tracking-docs.test.ts` — **235 pass, 0 fail**.
- `bun run typecheck` — **src/ typechecks clean**.
- Direct strict compilation of `scripts/widget-harness.ts` — **pass**.
- `bun run test:unit` — **498 pass, 156 skip, 0 fail; 654 tests**.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` — **140 pass, 0 fail, 0 skip; 8 DB suites**: db.integration 8, meal-events 41, calculation-bundles 13, meal-captures 20, mcp-food-tracking 20, backup-policy 7, legacy-meal-tools 23, calculation-acceptance 8.
- Changed parseable files: `bunx prettier --check ...` — **pass**. `.dockerignore`, `.gitignore`, and `public/llms.txt` were intentionally omitted because Prettier has no parser for them; the all-file command confirms that limitation.
- `git diff --check <range>` and `git diff --check HEAD` — **pass**.

## Review disposition

This review file is intentionally left uncommitted, as required on FAIL. No review commit was created and nothing was pushed. After the listed public/generated/legal truth fixes and regenerated alternative outputs are supplied, request a fresh S8 review.
