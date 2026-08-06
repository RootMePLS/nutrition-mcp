# S8 remediation handoff 3 (kimi): second remediation, unproven client compatibility claims removed

- Date: 2026-08-06
- Base review: `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review-2.md` (FAIL), SHA-256 `1c0ce5698584556a1686e30f5d83922657a12666d07a4d33677449dee57c4b3b`, preserved byte-identically and committed unmodified in this commit.
- Prior accepted work retained: `c3a3e0e` and the full S8 chain remain untouched except as listed below. No S9 work started.
- Scope guard: no `db/migrations`, runtime, schema, provider, or version change. One test-file repair was required and is disclosed in its own section and its own commit.

## What review-2 required and where it was fixed

### public/index.html

1. Free FAQ JSON-LD answer (`:108`) and its visible duplicate (`:2773`): the sentence "Yes, it is completely free — no premium tiers, ads, or hidden costs. You just need a Claude or ChatGPT account to connect." replaced with the exact review-2 wording: "The server does not charge a fee. Connection depends on your client's support for unauthenticated remote HTTP MCP servers; check your client's documentation." The trailing Patreon sentence is unchanged in both copies.
2. Hero imperative (`:229`): "Connect Claude or ChatGPT, then just say what you ate" replaced with the exact review-2 wording "Connect a client that supports unauthenticated remote HTTP MCP, then just say what you ate."
3. Whole-page audit conversions (definite named-client connection statements made conditional):
   - `<title>`, `og:title`, `twitter:title` (`:5`, `:19`, `:34`): "AI Meal & Macro Tracker for Claude & ChatGPT" changed to "Nutrition MCP: AI Meal & Macro Tracker MCP Server".
   - Meta description, `og:description`, `twitter:description`, JSON-LD SoftwareApplication description (`:9`, `:21`, `:36`, `:47`): "through conversation with Claude or ChatGPT" changed to "through conversation with an AI assistant".
   - Meta keywords (`:13`): "Claude AI, ChatGPT" removed from the keyword list.
   - JSON-LD "What is Nutrition MCP?" answer (`:68`) and visible duplicate (`:2704` region): "with Claude or ChatGPT" changed to "with an AI assistant".
   - Step 1 card (`:596`): "Works with any AI client that supports remote MCP servers — Claude, ChatGPT, and more." changed to "Connect from a client that supports unauthenticated remote HTTP MCP servers."
   - Install tab "Claude" panel (`:689-725`): the seven-step custom-connector walkthrough and the "Works on every Claude plan" note replaced with conditional wording: check Claude's documentation for unauthenticated remote HTTP MCP support, the server URL to enter if supported, the no-account statement, and "Whether Claude connects, and on which plans, is described in Claude's own documentation."
   - Install tab "ChatGPT" panel (`:728-764`): the eight-step app-creation walkthrough replaced with conditional wording of the same shape, plus "Whether ChatGPT connects is described in ChatGPT's documentation."
   - Install tab "Other agents" note (`:776-784`): named-client config instructions (Cursor, VS Code, Claude Code, Windsurf, and the `claude mcp add` command) replaced with "Add the config above to your MCP client's configuration if the client supports unauthenticated remote HTTP MCP servers. Setting names and file locations vary by client; check your client's documentation." The negative no-auth sentence is retained.
   - Comparison column bullet (`:2545`): "Works inside Claude or ChatGPT, free" changed to "Free; connect from a client that supports unauthenticated remote HTTP MCP".
   - Closing CTA sub (`:2642`): "Free and open source — it works with the AI you already use." changed to "Free and open source. Connect from a client that supports unauthenticated remote HTTP MCP."

### scripts/gen-alternatives.ts (source only; outputs regenerated, never hand-edited)

4. Account-sufficiency promises replaced with the review-2 safe sentence "The server has no Nutrition MCP account or sign-in step; connection depends on your client's support for unauthenticated remote HTTP MCP servers." at:
   - `:91` (MyFitnessPal migrate paragraph, replacing "the only account you need is the Claude or ChatGPT one you already have")
   - `:240` (MacroFactor extraFaq, replacing "You only need a Claude or ChatGPT account.")
   - `:244` (MacroFactor freeAnswer, replacing "You just need a Claude or ChatGPT account to connect.")
   - `:328` (Lifesum extraFaq, replacing "You only need a Claude or ChatGPT account to connect.")
   - `:684` (shared fallback freeAnswer, replacing "You only need a Claude or ChatGPT account to connect.")
5. Connector FAQ answer (`:665`): "add https://nutrition-mcp.com/mcp as a custom connector in Claude and start logging by conversation" removed. The answer now states only that the competitor has no official connector, that the endpoint is `https://nutrition-mcp.com/mcp`, that there is no sign-in step, and that the reader must check the client's documentation for unauthenticated remote-server support.
6. Shared INSTALL fragment (`:601-631`): the Claude custom-connector walkthrough and the "covers ChatGPT, Cursor, VS Code, Claude Code, and more" note replaced with client-neutral steps: check the client's documentation for unauthenticated remote HTTP MCP support, the endpoint to enter if supported, and the no-sign-in statement.
7. Additional named-client compatibility promises found in the audit and converted:
   - `:164` (Lose It hubBlurb): "Log meals by talking to Claude or ChatGPT instead — free." changed to "Log meals by talking to your AI instead, for free."
   - `:171` (Lose It note): "without ever leaving Claude or ChatGPT" changed to "without ever leaving your AI chat".
   - `:259` (Yazio note): "lives inside Claude or ChatGPT — free and open source" changed to "lives inside your AI chat, free and open source".
   - `:295` (Lifesum hubBlurb): "log food inside Claude or ChatGPT" changed to "log food by talking to your AI".
   - `:639` (PROS bullet): "Built as an MCP server — lives inside Claude & ChatGPT" changed to "Built as an MCP server; connection depends on the client's support for unauthenticated remote HTTP MCP".
   - `:661` (shared "Does X have an MCP server?" FAQ tail): "so you can log meals and macros directly inside your AI" changed to "whether your AI assistant can connect to it depends on its support for unauthenticated remote HTTP MCP servers".
   - `:714-716` (per-app desc, ogDesc, title): "logs meals and macros inside Claude or ChatGPT", "logs ... in Claude or ChatGPT", and "Track Nutrition in Claude & ChatGPT" changed to client-neutral "by conversation with your AI" wording; the title keeps the head term as "${app.name} MCP Server? Track Nutrition by Talking to Your AI".
   - `:818-822` (per-app hero lead): "so you can't use it inside Claude or ChatGPT" removed; the lead now states the competitor has no MCP server and that connection depends on the client's support for unauthenticated remote HTTP MCP servers.
8. Hub template (review-2 item 3):
   - `:1106-1112` hero lead: "Apps like MyFitnessPal, Cronometer, and Lose It can't connect to Claude or ChatGPT." replaced with "Apps like MyFitnessPal, Cronometer, and Lose It publish no MCP server." plus the explicit conditional "Connection depends on your client's support for unauthenticated remote MCP servers."
   - `:1205-1208` CTA sub: "Free and open source — it works with Claude, ChatGPT, and any MCP client." replaced with "Free and open source. Connection depends on your client's support for unauthenticated remote HTTP MCP servers."
   - `:1053`, `:1057`, `:1059` (hub title, desc, ogDesc): "Track Food in Claude & ChatGPT", "alternative for Claude and ChatGPT", and "works inside Claude or ChatGPT" replaced with client-neutral conversation wording.

## Removed promises (complete list)

1. "You just need a Claude or ChatGPT account to connect." (index FAQ, JSON-LD and visible)
2. "You only need a Claude or ChatGPT account (to connect)." (MacroFactor FAQ, MacroFactor freeAnswer, Lifesum FAQ, shared fallback freeAnswer)
3. "The only account you need is the Claude or ChatGPT one you already have." (MyFitnessPal migrate)
4. "Connect Claude or ChatGPT, then just say what you ate" (index hero)
5. "Works with any AI client that supports remote MCP servers — Claude, ChatGPT, and more." (index step card)
6. The Claude custom-connector walkthrough and "Works on every Claude plan. The free plan allows one connected MCP server at a time." (index install tab)
7. The ChatGPT create-app walkthrough including "Done. It works right away and shows up in your iOS and Android apps automatically." (index install tab; the same "Done. It works right away..." line also removed from the Claude tab)
8. Named config instructions for Cursor, VS Code, Claude Code, Windsurf and the `claude mcp add --transport http` command (index Other agents tab)
9. "Works inside Claude or ChatGPT, free" (index comparison bullet)
10. "Free and open source — it works with the AI you already use." (index closing CTA)
11. "AI Meal & Macro Tracker for Claude & ChatGPT" (index title and social titles), "with Claude or ChatGPT" (index descriptions and "What is Nutrition MCP?" answers), "Claude AI, ChatGPT" (index keywords)
12. "add https://nutrition-mcp.com/mcp as a custom connector in Claude" (generator connector FAQ)
13. The Claude custom-connector walkthrough in the generator INSTALL fragment and "The full install guide covers ChatGPT, Cursor, VS Code, Claude Code, and more."
14. "Built as an MCP server — lives inside Claude & ChatGPT" (generator PROS)
15. "logs meals and macros inside Claude or ChatGPT" / "logs meals, macros, and weight in Claude or ChatGPT" / "Track Nutrition in Claude & ChatGPT" (generator per-app meta and title)
16. "so you can't use it inside Claude or ChatGPT" (generator per-app hero)
17. "Log meals by talking to Claude or ChatGPT instead — free." (Lose It hubBlurb), "without ever leaving Claude or ChatGPT" (Lose It note), "lives inside Claude or ChatGPT" (Yazio note), "log food inside Claude or ChatGPT" (Lifesum hubBlurb)
18. "Apps like MyFitnessPal, Cronometer, and Lose It can't connect to Claude or ChatGPT." (hub hero)
19. "Free and open source — it works with Claude, ChatGPT, and any MCP client." (hub CTA)
20. "Track Food in Claude & ChatGPT" / "alternative for Claude and ChatGPT" / "works inside Claude or ChatGPT" (hub title, desc, ogDesc)
21. "so you can log meals and macros directly inside your AI" (generator shared FAQ tail), made explicitly conditional

## Surviving named-client mentions, line by line

public/index.html:
- `:76` and `:2719` (JSON-LD and visible "What is the Model Context Protocol?" answers): "lets AI assistants like Claude and ChatGPT connect to external tools and data sources". Protocol-level description of what MCP is for, naming the two assistants as examples of MCP-capable clients. It makes no statement about this endpoint. Retained.
- `:81`/`:2728` ("Does it work with ChatGPT?" question text) and `:84`/`:2732` region (answers): the answers are the conditional no-auth statements accepted in review-2 ("Whether ChatGPT connects depends on its support for unauthenticated remote MCP servers"). Retained.
- `:648-763` (install tabs): `itab-claude`, `itab-chatgpt`, `seg-claude`, `seg-chatgpt`, `panel-claude`, `panel-chatgpt` ids and classes, the `fa-claude` and `fa-openai` brand icons, and the "Claude" and "ChatGPT" tab labels. Navigation chrome only. The panel bodies are now conditional documentation-referral wording ("Check Claude's documentation", "If your Claude setup supports it", "Whether Claude connects ... is described in Claude's own documentation"). No compatibility is asserted. Retained.

scripts/gen-alternatives.ts:
- `:6` and `:710`: source comments documenting Search Console bridge queries ("connect cronometer to claude", "connect <app> to claude"). Never emitted to output. Retained.
- `:80`, `:123`, `:166`, `:209`, `:254`, `:297` (per-app cons): "No MCP server — can't run inside Claude or ChatGPT". A statement about the named competitor's product (it ships no MCP server), in a competitor comparison column. It asserts nothing about this endpoint's compatibility. Retained.
- `:661` (shared FAQ): "there is no official way to connect it to Claude, ChatGPT, or other AI assistants" refers to the competitor (`${app.name}`); the Nutrition MCP tail is conditional. Retained.
- `:664-665` (connector FAQ): the question "How do I connect ${app.name} to Claude?" and the clause "There is no official ${app.name} connector for Claude" are competitor statements; the endpoint sentence is neutral. Retained.
- `:846` (per-app section sub): protocol-level description naming Claude and ChatGPT as MCP-capable assistants. `:851`: "connect ${app.name} to Claude" appears only inside a quoted user search query. Both retained.

Generated outputs (`public/alternatives/*.html`): the surviving lines are exactly the generated instances of the generator lines above (per-app cons bullets, competitor FAQ pairs, protocol description, quoted search query) plus Google Fonts preconnect/stylesheet and Google Analytics gtag lines, which are unrelated infrastructure. Hub output additionally keeps "Track nutrition inside the AI you already use." as the CTA headline (also present on per-app pages); it names no client and its adjacent sub now states the connection condition. Review-2 audited this headline and did not flag it. Retained.

Generic "your AI" phrasing (for example "lives inside your AI chat", "talking to your AI") names no client and is the product category description; every actual connection instruction now carries the client-support condition.

## Generator synchronization proof

Changed generator source only, then ran the real generator and the project formatter twice:

- Run 1: `bun run scripts/gen-alternatives.ts` (wrote all seven outputs), then `bunx prettier --write public/index.html scripts/gen-alternatives.ts public/alternatives/*.html`.
- Run 2: `bun run scripts/gen-alternatives.ts` again, then `bunx prettier --write public/alternatives/*.html scripts/gen-alternatives.ts` again.
- SHA-256 after run 2, byte-identical to the hashes captured after run 1 (zero diff between the two hash lists):
  - public/alternatives/cronometer.html `3b2dd23410baeaab88416f3804377a65b9cbccbc6e7ebcf148627b159156e247`
  - public/alternatives/index.html `ae26fc7d5b570733e456ea965d2724925f1e6aa4e2adba49e2b3ef41960be720`
  - public/alternatives/lifesum.html `e892688248deec7a4802b04a0577244d0386ed825daf6c92bca7e49f59c3e62f`
  - public/alternatives/lose-it.html `8afcf0705bfa7f629a6b59a67c761086bac0304936f5b327dff0e479979b2274`
  - public/alternatives/macrofactor.html `1cee872d69c6d35ec59462624ecb0abeb8f339fbf56301bb325e5d5991e13d2f`
  - public/alternatives/myfitnesspal.html `c3c515014483c4c965b058d6cd04227e21e1da4171ffee37fa30956a86295c26`
  - public/alternatives/yazio.html `d334be633e76b1c4b5843e153ea132b81ac8f652673df2d456e8db95f04437e8`
  - public/index.html `1d0377b6a4e3674857ce55086b8123d0f18a652864ea12a8a6b0583f3163d03e`
  - scripts/gen-alternatives.ts `be4059d01b4ff0463a6aa4f614e023ba4f4505a336906eb516e33ca4912ab6e5`

No generated file was hand-edited; all seven outputs agree with the generator source.

## Humanizer audit

All new prose is plain and factual: it states what the server is, states the no-fee and no-account facts, and refers the reader to client documentation for compatibility. No new text contains an em dash; replacements that removed marketing dashes use periods or semicolons. No new text names a client as compatible, and no invented capability was added. The pre-existing em dashes retained in edited strings (for example "no free-tier limits — unlike MacroFactor") are unchanged original clauses, not new text.

## Prior S8 reconfirmations

- `supabase/`, `docs/google-auth-setup.md`, and `src/supabase.test.ts` are absent; `git grep -inE 'google-auth-setup|supabase/migrations|supabase\.js|supabase\.test'` over tracked files returns nothing.
- `src/db-helpers.test.ts` still tests DB helpers (`mealIdempotencyKey`, profile helpers, `fetchAllPages`); the rename remains accurate.
- Legal no-auth truth: `public/privacy.html` and `public/terms.html` retain the negative no-auth wording (four matching lines each); deletion wording remains backed by `src/mcp.ts:4641` calling `deleteAllUserData` (`src/db.ts:1081`).
- Analytics statement: `CLAUDE.md` still states analytics persist to PostgreSQL `tool_analytics`; `src/analytics.ts:88` runs `INSERT INTO tool_analytics`.
- Harness repair intact: `scripts/widget-harness.ts:26` imports `MealInput`/`MealInsertResult` from `../src/db.js`.
- Narrow sweep `git grep -inE 'supabase|google-auth|oauth|account-registration' -- ':!.hermes' ':!db/migrations'`: four permitted README historical/negative lines plus semantically negative no-auth lines in public pages and the generator (the mandated sentence contains the word OAuth). No positive OAuth, account, token, or registration claim remains.
- Broad sweep over `public/index.html public/alternatives scripts/gen-alternatives.ts public/privacy.html public/terms.html` for oauth/google/email/password/account/token/authorization-code/supabase/sign-in/login/register/credential: only negative no-auth statements, conditional client-support wording, Google Fonts and Google Analytics infrastructure, and competitor comparison lines survive.
- Named-client grep (claude/chatgpt/cursor/windsurf/openai/any mcp client) and account-sufficiency grep over `public/index.html`, the generator, and all seven outputs: no definite compatibility promise and no account-sufficiency promise remains; survivors are itemized above.

## Test repair disclosure (separate commit `4f1fc68`)

The mandated DB gate initially failed one test in `src/legacy-meal-tools.integration.test.ts` ("log and all eight legacy reads work through the real MCP transport"). Root cause: the test hardcoded `2026-08-05` and asserts `get_meals_today` returns the meal; `get_meals_today` resolves today in UTC for a profile-less user (`src/db.ts:503-506`, `src/tz.ts:12`), so the test cannot pass once the UTC date rolls past 2026-08-05. The hardcoded date entered in `a26a058` (2026-08-05 21:48 UTC), which is why every earlier gate run saw it pass. This defect is unrelated to the docs remediation (no runtime file was modified). Repaired minimally and honestly in a separate commit `4f1fc68` ("test: compute legacy read-regression date instead of hardcoding it"): the test now computes the current UTC date at runtime; all eight read assertions are unchanged. The mandated docs commit below contains only the docs, generator, generated outputs, and plan artifacts.

## Verification evidence

- JSON-LD parse: 15/15 blocks across `public/index.html` and the seven alternatives outputs parse as JSON. JSON-LD versus visible FAQ normalized-text agreement verified for the two changed index answers (free answer and "What is Nutrition MCP?").
- HTML parse: `bunx prettier --check public/index.html public/privacy.html public/terms.html scripts/gen-alternatives.ts public/alternatives/*.html src/legacy-meal-tools.integration.test.ts`: all pass.
- Generator sync: zero diff and hash equality across two generator-plus-formatter runs (hashes above).
- Focused affected tests: `bun test src/db-helpers.test.ts src/mcp.test.ts src/import.test.ts src/foods.test.ts src/insights.test.ts src/food-tracking-docs.test.ts`: 235 pass, 0 fail.
- `bun run typecheck`: src/ typechecks clean.
- Harness strict compile: `bunx tsc --noEmit --strict --skipLibCheck --noUncheckedIndexedAccess --target esnext --module preserve --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax scripts/widget-harness.ts`: pass.
- Harness run: `HARNESS_PORT=8788 bun run scripts/widget-harness.ts`; `GET /` 200, `GET /host?widget=import-meals` 200 with expected content; `POST /tool/reset` then `POST /tool/bulk_import_meals` with one valid row (`source_line:1`, `expected_row_count:1`, `expected_total_kcal:450`) returned `status=success`, `created=1`, `provenance_status=compatibility`, `event_version=1`, `has_calculation_bundle=false`. Process killed; `lsof -iTCP:8788 -sTCP:LISTEN` empty and curl refused, no listener remains.
- `bun run test:unit`: 498 pass, 156 skip, 0 fail; 654 tests.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`: 140 pass, 0 fail, 0 skip across all eight DB suites (8, 41, 13, 20, 20, 7, 23, 8).
- `git diff --check HEAD` and `git diff --check 3972a5f..HEAD`: pass.

## Commits

- `4f1fc68` test: compute legacy read-regression date instead of hardcoding it (disclosed above).
- This remediation: `docs: remove unproven client compatibility claims` containing `public/index.html`, `scripts/gen-alternatives.ts`, all seven `public/alternatives/*.html` outputs, the immutable review-2 artifact (byte-identical), and this handoff.
