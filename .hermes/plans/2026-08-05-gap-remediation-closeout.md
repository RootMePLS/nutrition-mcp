# 2026-08-05 gap-remediation campaign closeout (slice S11)

**Date:** 2026-08-06
**Slice:** S11 — campaign truth-sync and closeout
**Governing acceptance:** `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md`
lines 687-725 (Slice S11) plus Appendix A (lines 729-737) and Appendix B
(lines 739-741).
**Base:** accepted S10 commit `cb53f0241b4034cf8c8c5b4ae389295af3c81295`
(`docs: accept S10 plan truth index`), clean tree, `main` == `origin/main`.
**Scope:** documentation-only final truth-sync. No new code, no gate patches.
This slice creates exactly this file and modifies exactly
`.hermes/plans/INDEX.md`, in one commit `docs: close out gap-remediation campaign`.

**S11 acceptance status:** this closeout PROPOSES campaign acceptance.
Reviewer-terra runs after the coder; the S11 reviewer-terra acceptance
reference is **PENDING** at the named final review path
`.hermes/plans/2026-08-05-gap-remediation-s11-terra-review.md`. Campaign
acceptance becomes final only when that review's PASS verdict is committed. No
PASS is claimed or invented here.

## 1. Pristine-clone gate battery (verbatim evidence)

Executed from a `mktemp -d` directory per campaign plan lines 702-711:

- Clone directory: `/var/folders/j7/_t2fdn050_9bgp3bt4qmk98r0000gn/T/tmp.2Ule0kTmZt`
- Clone command: `git clone /Users/fishhead/.workspace/projects/nutrition-mcp repo`
- Clean-clone `HEAD` verified equal to the S10 base
  `cb53f0241b4034cf8c8c5b4ae389295af3c81295` and equal to `origin/main`
  before any work (commands 0a-0c below).
- `bun install` leaves the clone clean (commands 2 and 2b; re-verified
  out-of-tree by commands 10-12, see the harness note below).
- DB gate reports exactly **8 suites**; counts exceed the S0 baselines
  (Appendix A): unit 498/156/0 vs 445/84/0; DB 140/0/0/8 vs 82/0/0/7.
- MCP smoke reports all **24** `smoke ok` checks and exits 0.

**Harness note (truthful disclosure):** the battery harness initially wrote
its own per-command capture files (`*.out`/`*.err`/`*.code`) inside the clone,
so the first `git status --porcelain` runs (0b, 2b, 9 below) list only those
harness files and nothing else — no repository file was ever modified,
staged, or deleted. The captures were then moved outside the clone and clean
tree was re-verified with out-of-tree captures (commands 10-12: empty status
before and after a `bun install` re-run). Every command's complete,
untruncated stdout/stderr and exit status follows; commands with zero stdout
or zero stderr are explicitly marked.

### Command 0a — pre-work HEAD verification (supplementary)

Command: `git rev-parse HEAD`

Exit status: 0

stdout:

```text
cb53f0241b4034cf8c8c5b4ae389295af3c81295
```

stderr: (empty — zero bytes)

### Command 0b — pre-work tree status (supplementary; see harness note)

Command: `git status --porcelain`

Exit status: 0

stdout:

```text
?? 00-head.code
?? 00-head.err
?? 00-head.out
?? 00-status-pre.err
?? 00-status-pre.out
```

stderr: (empty — zero bytes)

### Command 0c — origin/main equality before work (supplementary)

Command: `git rev-parse origin/main`

Exit status: 0

stdout:

```text
cb53f0241b4034cf8c8c5b4ae389295af3c81295
```

stderr: (empty — zero bytes)

### Command 1 — pristine clone (plan line 704)

Command: `git clone /Users/fishhead/.workspace/projects/nutrition-mcp repo`

Exit status: 0

stdout: (empty — zero bytes)

stderr:

```text
Cloning into 'repo'...
done.
```

### Command 2 — dependency install (plan line 705)

Command: `bun install`

Exit status: 0

stdout:

```text
bun install v1.3.14 (d1632b29)

+ @types/bun@1.3.14
+ @modelcontextprotocol/sdk@1.29.0
+ @types/pg@8.20.4
+ hono@4.12.30
+ pg@8.22.0
+ prettier@3.9.5
+ typescript@5.9.3

113 packages installed [323.00ms]
```

stderr: (empty — zero bytes)

### Command 2b — post-install tree status (supplementary; see harness note)

Command: `git status --porcelain`

Exit status: 0

stdout:

```text
?? 00-head.code
?? 00-head.err
?? 00-head.out
?? 00-origin-main.code
?? 00-origin-main.err
?? 00-origin-main.out
?? 00-status-pre.code
?? 00-status-pre.err
?? 00-status-pre.out
?? 02-bun-install.code
?? 02-bun-install.err
?? 02-bun-install.out
?? 02b-status-post-install.err
?? 02b-status-post-install.out
```

stderr: (empty — zero bytes)

### Command 3 — typecheck gate (plan line 706)

Command: `bun run typecheck`

Exit status: 0

stdout:

```text
src/ typechecks clean
```

stderr:

```text
$ bun run scripts/typecheck.ts
```

### Command 4 — unit gate (plan line 707)

Command: `bun run test:unit`

Exit status: 0

stdout:

```text
bun test v1.3.14 (d1632b29)
src/calculation-acceptance.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set
[analytics] log_meal success 0ms user=u1
[analytics] update_meal success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] set_nutrition_goals success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] log_meal success 0ms user=u1
[analytics] update_meal success 0ms user=u1
[analytics] update_meal success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] set_alcohol_tracking success 0ms user=u1
[analytics] get_alcohol_tracking success 0ms user=u1
[analytics] get_alcohol_tracking success 0ms user=u1
[analytics] get_alcohol_tracking success 0ms user=u1
[analytics] get_alcohol_tracking success 0ms user=u1
[analytics] bulk_import_meals success 3ms user=u1
[analytics] bulk_import_meals success 1ms user=u1
[analytics] bulk_import_meals success 1ms user=u1
[analytics] bulk_import_meals success 1ms user=u1
[analytics] bulk_import_meals success 1ms user=u1
src/meal-events.test.ts: repository tests SKIPPED — DATABASE_URL_TEST is not set
src/legacy-meal-tools.integration.test.ts: SKIPPED — set matching DATABASE_URL/DATABASE_URL_TEST and RUN_LEGACY_MEAL_DB_TESTS=1 for the isolated legacy DB regression suite
src/mcp-food-tracking.test.ts: SKIPPED — DATABASE_URL_TEST is not set
src/db.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set; integration tests never claim success without a real test database
src/calculation-bundles.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set
src/backup-policy.test.ts: tombstone tests SKIPPED — DATABASE_URL_TEST is not set


src/calculation-acceptance.integration.test.ts:
(skip) calculation concurrency and correction acceptance matrix > (unnamed)
(skip) calculation concurrency and correction acceptance matrix > concurrent identical calculation bundles converge
(skip) calculation concurrency and correction acceptance matrix > concurrent identical corrections yield one new version
(skip) calculation concurrency and correction acceptance matrix > migration 005 reruns safely
(skip) calculation concurrency and correction acceptance matrix > correction rollback leaves prior state intact
(skip) calculation concurrency and correction acceptance matrix > stale-version correction with fresh idempotency key is rejected
(skip) calculation concurrency and correction acceptance matrix > direct cross-user correction is rejected
(skip) calculation concurrency and correction acceptance matrix > MCP correction round-trip
(skip) calculation concurrency and correction acceptance matrix > failed provider is readable through public provenance
(skip) calculation concurrency and correction acceptance matrix > (unnamed)

src/mcp.test.ts:
(pass) writeProvenanceFields > compatibility write discloses compatibility, no bundle [1.04ms]
(pass) writeProvenanceFields > bundle-backed version with ready evidence reports complete [0.04ms]
(pass) writeProvenanceFields > bundle-backed version with incomplete evidence reports pending [0.04ms]
(pass) formatGoalLine direction > floor keeps the 'to go' wording [0.07ms]
(pass) formatGoalLine direction > ceiling under the limit never offers the remainder [0.24ms]
(pass) formatGoalLine direction > ceiling over the limit says how far over [0.02ms]
(pass) formatGoalLine direction > ceiling wording survives being read as an average [0.01ms]
(pass) formatGoalLine direction > no target prints the bare amount in either direction [0.02ms]
(pass) formatGoalLine direction > actualText overrides how the consumed amount is printed [0.01ms]
(pass) a zero ceiling is a real limit > hasActiveTarget splits zero by direction [0.02ms]
(pass) a zero ceiling is a real limit > staying at zero is reported against the zero limit [0.02ms]
(pass) a zero ceiling is a real limit > anything at all is over a zero limit [0.01ms]
(pass) a zero ceiling is a real limit > a zero alcohol limit is echoed and then honoured [0.28ms]
(pass) a zero ceiling is a real limit > a zero sugar limit is honoured too [0.03ms]
(pass) a zero ceiling is a real limit > a zero floor is listed as not set, matching how it behaves [0.03ms]
(pass) sumMeals > accumulates fiber, sugar and alcohol, treating nulls as zero [0.02ms]
(pass) sumMeals presence contract > fully pending selection yields null core macros [0.05ms]
(pass) sumMeals presence contract > mixed pending+ready sums only calculated values [0.02ms]
(pass) sumMeals presence contract > explicit zero is a real zero, not null [0.02ms]
(pass) sumMeals presence contract > presence is per-macro: a calorie-only meal still has null protein [0.02ms]
(pass) sumMeals presence contract > distinct presence matrix: counts are per-macro, not any-macro [0.02ms]
(pass) sumMeals presence contract > an explicit zero counts as coverage for its own macro only [0.02ms]
(pass) sumMeals presence contract > an empty selection has null core macros and zero counts [0.02ms]
(pass) presenceSum > null only when no meal carries the nutrient; explicit zero sums [0.04ms]
(pass) nutrientPresence > one non-null meal makes the day carry the nutrient [0.02ms]
(pass) nutrientPresence > an explicit zero is data — only null is absence [0.03ms]
(pass) rangeAverages > a partial window averages over the days that record the nutrient [0.20ms]
(pass) rangeAverages > a genuinely zero day counts in both numerator and denominator [0.08ms]
(pass) rangeAverages > calories, protein, carbs, fat and water still divide by every day [0.04ms]
(pass) rangeAverages > a nutrient nobody recorded stays unavailable [0.03ms]
(pass) rangeAverages > an empty range has null core averages and zero counts [0.03ms]
(pass) rangeAverages > core averages are null when no day has a calculated value [0.05ms]
(pass) rangeAverages > a pending day still counts as a logged day in the core denominator [0.03ms]
(pass) rangeAverages > per-macro coverage differs across a range: calories 2/2, protein 1/2 [0.04ms]
(pass) formatProgress suppresses unrecorded nutrients > no data and no target prints no line at all [0.03ms]
(pass) formatProgress suppresses unrecorded nutrients > no data but a target set says so instead of claiming zero [0.02ms]
(pass) formatProgress suppresses unrecorded nutrients > recorded data is reported normally [0.03ms]
(pass) formatProgress suppresses unrecorded nutrients > alcohol is never suppressed by presence, only by the opt-in [0.03ms]
(pass) formatProgress renders pending core macros as no-data > null total with a target says no data yet, citing the target [0.03ms]
(pass) formatProgress renders pending core macros as no-data > null total without a target still says no data yet [0.02ms]
(pass) formatProgress renders pending core macros as no-data > an explicit zero total reports a real zero against the goal [0.02ms]
(pass) alcohol opt-in gating > progress text shows alcohol in grams AND drinks when enabled [0.02ms]
(pass) alcohol opt-in gating > progress text uses UK units when that is the preference [0.02ms]
(pass) alcohol opt-in gating > progress text omits alcohol entirely when tracking is off [0.02ms]
(pass) alcohol opt-in gating > goal list hides only the alcohol target when tracking is off [0.03ms]
(pass) alcohol opt-in gating > meal text hides only the alcohol line when tracking is off [0.06ms]
(pass) alcohol opt-in gating > a meal with no alcohol logged shows no alcohol line even when enabled [0.01ms]
(pass) alcohol opt-in gating > structured payloads null alcohol out when tracking is off [0.12ms]
(pass) gateAlcohol > zeroes the alcohol series only when tracking is off [0.03ms]
(pass) gateAlcohol > keeps alcohol out of the trends narrative when tracking is off [0.23ms]
(pass) gateAlcohol > keeps alcohol out of the weekly digest when tracking is off [0.29ms]
(pass) summary and trends agree on the same window > fiber: same number in both, over the recorded days only [0.45ms]
(pass) summary and trends agree on the same window > sugar: same number in both [0.03ms]
(pass) summary and trends agree on the same window > calories still divide by every day in both [0.02ms]
(pass) start_meal_import payload > carries the drink unit when the user tracks alcohol [0.74ms]
(pass) start_meal_import payload > drink_unit is null when alcohol tracking is off [0.05ms]
(pass) start_meal_import payload > the payload satisfies the declared outputSchema either way [1.37ms]
(pass) formatFoodResult > always shows fiber and total sugar [0.06ms]
(pass) formatFoodResult > renders n/a rather than 0 for an absent fiber or sugar figure [0.02ms]
(pass) formatFoodResult > shows alcohol only when the user tracks it [0.03ms]
(pass) formatFoodResult > omits alcohol when Open Food Facts could not resolve it [0.02ms]
(pass) structuredContent literals satisfy their schemas > totals, goals and breakdown parse with alcohol on and off [1.07ms]
(pass) structuredContent literals satisfy their schemas > goalsPayloadOf keeps every cleared target as an explicit null [0.03ms]
(pass) structuredContent literals satisfy their schemas > no goals at all is null, not a half-filled object [0.01ms]
(pass) structuredContent literals satisfy their schemas > a pending selection emits null core macros with presence counts [0.05ms]
(pass) structuredContent literals satisfy their schemas > an explicit zero survives the payload as a real zero [0.03ms]
(pass) structuredContent literals satisfy their schemas > distinct presence parses with per-macro coverage counts [0.03ms]
(pass) trendsDayPayloadOf > nulls fiber/sugar/alcohol on a day that never recorded them [0.37ms]
(pass) trendsDayPayloadOf > keeps a real recorded zero as 0, not null [0.03ms]
(pass) trendsDayPayloadOf > nulls core macros on a day with no calculated values, with counts [0.06ms]
(pass) trendsDayPayloadOf > an explicit-zero day keeps real zeros in the core macros [0.03ms]
(pass) trendsDayPayloadOf > a day with no meals at all has null core macros and zero counts [0.06ms]
(pass) trendsDayPayloadOf > a calorie-only day discloses per-macro coverage [0.05ms]
(pass) trendsDayPayloadOf > alcohol tracking off nulls alcohol_g regardless of coverage [0.02ms]
(pass) trendsDayPayloadOf > a day with no meals at all is null across all three partial nutrients [0.05ms]
(pass) trendsDayPayloadOf > covered-days average recovers the true figure once uncovered days are null [0.18ms]
(pass) legacy write provenance disclosure > log_meal structuredContent discloses the compatibility write [19.28ms]
(pass) legacy write provenance disclosure > update_meal structuredContent discloses the compatibility write [4.13ms]
(pass) write-tool numeric bounds > the goal ceiling is what numeric(6,2) can hold [0.02ms]
(pass) write-tool numeric bounds > log_meal rejects a negative gram figure before touching the DB [3.46ms]
(pass) write-tool numeric bounds > an unbounded 1e308 figure would poison every later read of that date [0.11ms]
(pass) write-tool numeric bounds > ...and log_meal now refuses to create that row in the first place [3.58ms]
(pass) write-tool numeric bounds > update_meal is bounded the same way [3.11ms]
(pass) write-tool numeric bounds > alcohol has a tighter ceiling than the other macros [3.22ms]
(pass) write-tool numeric bounds > the top of each range is still accepted [6.42ms]
(pass) write-tool numeric bounds > set_nutrition_goals rejects negatives and numeric(6,2) overflow [2.74ms]
(pass) write-tool numeric bounds > null still clears a goal [2.72ms]
(pass) alcoholHiddenNote > says nothing when the user already tracks alcohol [0.02ms]
(pass) alcoholHiddenNote > says nothing when the write carried no alcohol [0.01ms]
(pass) alcoholHiddenNote > names the setting only when both conditions hold [0.03ms]
(pass) log_meal / update_meal surface hidden alcohol > log_meal nudges when alcohol is stored but hidden [2.81ms]
(pass) log_meal / update_meal surface hidden alcohol > the nudge never turns tracking on by itself [2.58ms]
(pass) log_meal / update_meal surface hidden alcohol > no nudge once the user tracks alcohol — it is already on screen [2.27ms]
(pass) log_meal / update_meal surface hidden alcohol > no nudge for a meal with no alcohol, or with exactly zero [3.01ms]
(pass) log_meal / update_meal surface hidden alcohol > update_meal nudges on the same terms [8.50ms]
(pass) set_alcohol_tracking > enabling writes the flag and confirms it [2.19ms]
(pass) set_alcohol_tracking > disabling writes false and says so [2.06ms]
(pass) set_alcohol_tracking > drink_unit is stored when given and left alone when omitted [2.31ms]
(pass) set_alcohol_tracking > rejects a drink unit that is not us or uk [1.83ms]
(pass) set_alcohol_tracking > does not tell the user to start a new chat [1.91ms]
(pass) set_alcohol_tracking > its description does not repeat the reconnect caveat either [97.60ms]
(pass) get_alcohol_tracking > reports enabled with the saved unit [3.30ms]
(pass) get_alcohol_tracking > flags the US fallback as a default, not a choice [4.87ms]
(pass) get_alcohol_tracking > reports disabled, and that stored alcohol is kept [2.19ms]
(pass) get_alcohol_tracking > no profile row at all reads as disabled [2.03ms]
(pass) bulk_import_meals surfaces hidden alcohol > nudges once when an imported row carried alcohol [5.88ms]
(pass) bulk_import_meals surfaces hidden alcohol > stays quiet when no row carried alcohol [3.17ms]
(pass) bulk_import_meals surfaces hidden alcohol > stays quiet when the user already tracks alcohol [2.97ms]
(pass) bulk_import_meals surfaces hidden alcohol > a rejected alcohol row does not trigger it [3.20ms]
(pass) bulk_import_meals surfaces hidden alcohol > a dry run says it would be saved, not that it was [3.09ms]
(pass) calculation bundle output contracts > bundle output carries one canonical per item scope [1.53ms]
(pass) calculation bundle output contracts > provenance output carries one canonical per item scope [0.24ms]
(pass) capture lifecycle output contracts (S6) > captureStateOutput normalizes optional fields to explicit nulls [0.17ms]
(pass) capture lifecycle output contracts (S6) > capture-state schema is strict and state-locked [0.14ms]
(pass) capture lifecycle output contracts (S6) > get_meal_capture output wraps a nullable capture read [0.40ms]

src/meal-events.test.ts:
(pass) meal event domain contracts > derives explicit provenance without converting missing values to zero [0.06ms]
(pass) meal event domain contracts > does not overclaim ready when persisted bundle evidence is incomplete [0.02ms]
(pass) meal event domain contracts > marks failed or unavailable evidence as unavailable even with a fingerprint [0.01ms]
(pass) meal event domain contracts > one event accepts multiple ordered positions [0.14ms]
(pass) meal event domain contracts > explicit reported_at and consumed_at are preserved as given [0.05ms]
(pass) meal event domain contracts > omitted consumed_at resolves to the same instant as reported_at [0.02ms]
(pass) meal event domain contracts > input precedence: user text beats audio, photo-derived and assumptions [0.05ms]
(pass) meal event domain contracts > provider namespaces are exactly nutrition-local, own, myfitnesspal [0.02ms]
(pass) meal event domain contracts > provider statuses distinguish failed/unavailable from numeric results [0.02ms]
(pass) meal event domain contracts > journal authorization and state transitions are explicit [0.03ms]
(pass) meal event domain contracts > correction fingerprint is distinct from the initial create fingerprint [0.10ms]
(pass) meal event domain contracts > validation rejects an empty item list and duplicate ordinals [0.03ms]
(pass) meal event domain contracts > public event validation never throws for throwing array Proxy traps [0.34ms]
(pass) public event validation fails closed for throwing and revoked top-level Proxies [0.12ms]
(skip) meal event repository (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal event repository (requires DATABASE_URL_TEST) > create: persists event with two positions, evidence and media metadata in one transaction
(skip) meal event repository (requires DATABASE_URL_TEST) > create: omitted consumed_at is stored equal to reported_at
(skip) meal event repository (requires DATABASE_URL_TEST) > create: same idempotency-key retry returns the original and creates no duplicates
(skip) meal event repository (requires DATABASE_URL_TEST) > analyze-first then explicit add retry authorizes root and creates one journal
(skip) meal event repository (requires DATABASE_URL_TEST) > concurrent explicit add retries after analyze create one journal
(skip) meal event repository (requires DATABASE_URL_TEST) > create: concurrent same-key creates yield one aggregate
(skip) meal event repository (requires DATABASE_URL_TEST) > create: injected DB failure rolls back root, version, items, inputs, results and journal together
(skip) meal event repository (requires DATABASE_URL_TEST) > create: a failed provider is stored as a failed result; the raw event stays committed
(skip) meal event repository (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal event corrections (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: creates version 2 and advances current_version atomically
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: version 1 rows and raw inputs remain unchanged
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: reads default to current version; history returns both
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: repeated correction fingerprint returns version 2, never version 3
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: a failed correction leaves version 1 current with no partial version 2
(skip) meal event corrections (requires DATABASE_URL_TEST) > (unnamed)
(skip) canonical persistence (requires DATABASE_URL_TEST) > (unnamed)
(skip) canonical persistence (requires DATABASE_URL_TEST) > two agree plus one outlier: canonical averages the pair and records the outlier
(skip) canonical persistence (requires DATABASE_URL_TEST) > no agreeing pair: canonical persists no_consensus with the mean of all eligible
(skip) canonical persistence (requires DATABASE_URL_TEST) > one usable provider: low_confidence, value as-is, missing nutrients stay NULL
(skip) canonical persistence (requires DATABASE_URL_TEST) > item scope: per-item provider results persist a per-item canonical row
(skip) canonical persistence (requires DATABASE_URL_TEST) > (unnamed)
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > (unnamed)
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: authorized add intent inserts one pending row before any external call
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: absent authorization creates no external-write journal row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: replayed create with the same key never duplicates the journal row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: injected external failure marks the row failed and keeps local state intact
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: retry increments attempts without a duplicate row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: illegal transitions are rejected; success records external id
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: delivery drives the injectable writer and records success
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: a throwing writer leaves the row failed and local state intact
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: retry after failure re-invokes the writer without a duplicate row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: delivering a succeeded entry is rejected, never re-sent
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > (unnamed)

src/media-store.test.ts:
(pass) media store > bytes are written under MEDIA_ROOT with a generated event/version key [1.06ms]
Failed to persist analytics for log_meal: database "fishhead" does not exist
(pass) media store > returned metadata carries MIME, byte size and SHA-256 [1.22ms]
(pass) media store > unsafe keys cannot select arbitrary paths [0.25ms]
Failed to persist analytics for update_meal: database "fishhead" does not exist
Failed to persist analytics for log_meal: database "fishhead" does not exist
(pass) media store > read verifies the expected checksum and returns the bytes [0.90ms]
(pass) media store > missing file and checksum mismatch are explicit errors [0.47ms]
(pass) media store > delete uses only the generated key and is idempotent [1.25ms]
Failed to persist analytics for set_nutrition_goals: database "fishhead" does not exist
Failed to persist analytics for log_meal: database "fishhead" does not exist
(pass) media store > restore rewrites verified bytes at an already-referenced key [0.97ms]
(pass) media store > restore rejects unsafe keys before any I/O [0.06ms]

src/calculation-bundles.test.ts:
(pass) calculation bundle commit seam > requires explicit confirmation and complete correction provenance [0.10ms]
(pass) calculation bundle commit seam > correction output contract is a distinct strict schema carrying correction metadata [0.98ms]
(pass) calculation bundle commit seam > discovers additive commit tool and rejects malformed bundles [60.85ms]
(pass) calculation bundle commit seam > discovers provenance readback and correction tools [59.24ms]
(pass) calculation bundle commit seam > rejects calculation bundle scopes with unknown keys through MCP [3.14ms]
(pass) calculation bundle commit seam > fails closed through MCP when scoped durable readback is absent [6.67ms]
(pass) calculation bundle commit seam > fails closed for malformed runtime results without throwing [0.20ms]
(pass) calculation bundle commit seam > recomputes canonical and persists source IDs and raw provenance atomically [0.20ms]
(pass) calculation bundle commit seam > recomputeCalculationBundle groups consensus per scope [0.12ms]
(pass) calculation bundle commit seam > rejects tampered content before persistence [0.17ms]

src/meal-captures.integration.test.ts:
Failed to persist analytics for log_meal: database "fishhead" does not exist
Failed to persist analytics for log_meal: database "fishhead" does not exist
Failed to persist analytics for log_meal: database "fishhead" does not exist
Failed to persist analytics for log_meal: database "fishhead" does not exist
Failed to persist analytics for log_meal: database "fishhead" does not exist
Failed to persist analytics for update_meal: database "fishhead" does not exist
Failed to persist analytics for update_meal: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
(skip) durable meal capture lifecycle > (unnamed)
(skip) durable meal capture lifecycle > persists across reads, idempotent messages/answers, and valid cancel/expire transitions
(skip) durable meal capture lifecycle > saves media provenance and confirms exactly once under concurrency
(skip) durable meal capture lifecycle > rejects draft media that does not exactly match staged capture media
(skip) durable meal capture lifecycle > rolls back event aggregate when confirmation fails before capture update, then retries
(skip) durable meal capture lifecycle > (unnamed)
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > (unnamed)
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > happy path: stages bytes, persists row, on-disk hash matches
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > rollback: injected INSERT failure removes both DB row and staged file
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > retry-safe: identical bytes attached twice yield one row and one file
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > tampered caller sha256 is rejected; nothing staged or persisted
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > state guard: attach on a cancelled capture stages nothing
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > cross-user attach is rejected as not found; nothing staged
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > (unnamed)
(skip) capture media durability under rejected and duplicate retries (S5 F1) > (unnamed)
(skip) capture media durability under rejected and duplicate retries (S5 F1) > wrong-user retry of committed bytes preserves the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > same-owner retry after cancel preserves the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > same-owner retry after confirmation preserves the original row, file, and event reference
(skip) capture media durability under rejected and duplicate retries (S5 F1) > injected transactional failure on a duplicate attempt preserves the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > coordinated concurrent duplicate success and rejected/failing attempts preserve the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > dedup retry heals a missing committed file with identical bytes
(skip) capture media durability under rejected and duplicate retries (S5 F1) > (unnamed)
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > (unnamed)
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > real COMMIT succeeds then acknowledgement is lost: attach rejects but row and file survive, retry returns the original identity
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > real COMMIT succeeds then acknowledgement is lost AND reconciliation is unavailable: possible orphan is retained, never deleted
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > COMMIT rejected before being sent: reconciliation proves no row and removes the staged file
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > non-cooperating conflicting row with a different key: conflict row and file survive, redundant staged key is removed
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > (unnamed)

src/insights.test.ts:
(pass) computeWeightTrend reports latest, change, range, and goal in kg [0.82ms]
(pass) computeWeightTrend averages multiple weigh-ins on the same day [0.13ms]
(pass) computeWeightTrend renders in lb and reports gaining toward target [0.10ms]
(pass) computeWeightTrend handles an empty range [0.02ms]
(pass) buildDailyBuckets sums fiber, sugar and alcohol per day [0.13ms]
(pass) computeTrends treats fiber as a floor and sugar as a ceiling [0.19ms]
(pass) computeTrends suppresses the alcohol line when the window is all zero [0.14ms]
(pass) computeTrends shows alcohol once any day is non-zero [0.12ms]
(pass) computeWeeklyDigest reports fiber and sugar, calling a sugar goal a limit [0.10ms]
(pass) computeWeeklyDigest shows an alcohol row only when a drink was logged [0.08ms]
(pass) computeTrends averages a partial nutrient over its covered days only [0.82ms]
(pass) computeTrends counts limit misses over covered days, not the window [0.84ms]
(pass) computeTrends drops a nutrient with no data anywhere in the window [0.82ms]
(pass) computeTrends says so when a trailing window has no data at all [0.40ms]
(pass) computeTrends honours a limit of zero on a ceiling [0.11ms]
(pass) computeTrends still treats a floor target of zero as unset [0.10ms]
(pass) computeWeeklyDigest averages a partial nutrient over its covered days [0.30ms]
(pass) computeWeeklyDigest drops rows for nutrients with no data at all [0.21ms]
(pass) computeWeeklyDigest honours a limit of zero without a percentage [0.09ms]
(pass) computeWeeklyDigest reports a zero-limit nutrient held at zero as clear [0.08ms]

src/meal-captures.test.ts:
(pass) prepared drafts retain ordered items and validate timestamps [0.26ms]
(pass) prepared drafts reject duplicate ordinals and invalid dates [0.03ms]
(pass) capture messages fail closed for missing ids, invalid dates, kinds, and metadata [0.12ms]
(pass) capture and draft validators fail closed for malformed runtime payloads [0.11ms]
(pass) all public validators fail closed for null, malformed, nested-null, and primitive payloads [0.26ms]
(pass) metadata accepts shared aliases but rejects true cycles [0.07ms]
(pass) metadata rejects every non-JSON runtime value at any nesting depth [0.08ms]
(pass) public metadata validators fail closed for throwing Proxy traps [0.15ms]
(pass) public metadata validators fail closed for revoked Proxies [0.05ms]
(pass) public validators fail closed for revoked and throwing array-bearing values [0.24ms]
(pass) prepared draft validation never throws for throwing array Proxy traps [0.17ms]
(pass) capture and draft validators fail closed for throwing top-level Proxies [0.17ms]
(pass) capture and draft validators fail closed for revoked top-level Proxies [0.06ms]
(pass) validators validate identity and provenance fields and MIME syntax [0.05ms]
(pass) capture media validates identity, kind, size, hash, mime, and metadata [0.03ms]
(pass) prepared drafts reject invalid evidence sources and content hashes [0.06ms]
(pass) prepared drafts require ids, retain all evidence, and sort deterministically [0.08ms]
(pass) capture transitions > confirmation accepts only explicit add phrases [0.12ms]

src/alcohol.test.ts:
(pass) ethanol density is the CRC value, not the 0.8 shorthand [0.03ms]
(pass) all three NIAAA standard drinks compute to 14 g of ethanol [0.05ms]
(pass) mlFromFlOz uses the US fluid ounce [0.01ms]
(pass) a 330 mL 5% beer is 13.02 g — 0.93 US drinks but 1.65 UK units [0.03ms]
(pass) UK units reproduce the NHS volumetric formula (ABV x mL / 1000) [0.06ms]
(pass) gramsFromDrink treats ABV as a percentage, not a fraction [0.01ms]
(pass) zero alcohol and zero volume both yield zero grams [0.02ms]
(pass) gramsFromDrink rejects nonsensical volumes and ABVs [0.12ms]
(pass) fromDrinks is the inverse of toDrinks [0.04ms]
(pass) formatAlcohol leads with grams and glosses with drinks [0.02ms]
(pass) formatAlcohol rounds grams to 1 decimal, matching the macro fields [0.01ms]
(pass) isDrinkUnit guards us/uk only [0.03ms]

src/tz.test.ts:
Failed to persist analytics for bulk_import_meals: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for get_alcohol_tracking: database "fishhead" does not exist
(pass) dateInTz maps an instant to the local calendar day [0.65ms]
(pass) formatLocalDateTime renders wall-clock time, normalizing hour 24 to 00 [0.37ms]
(pass) hourInTz and dowInTz reflect local time [0.15ms]
(pass) zonedDayStartUtc handles DST transitions and fractional offsets [0.55ms]
(pass) zonedDayStartUtc handles zones whose DST transition is at local midnight [0.37ms]
(pass) zonedWallClockToUtc flags nonexistent local times and jumps forward [0.46ms]
(pass) zonedHourUtc anchors a date at a local hour, unlike day-start plus N hours [0.56ms]
(pass) local noon round-trips to the same calendar date in every IANA zone [1244.50ms]
(pass) zonedNextDayStartUtc is the exclusive upper bound [0.37ms]
(pass) shiftLocalDate does calendar arithmetic across month boundaries [0.06ms]
(pass) validateLoggedAt accepts past/now and rejects future & invalid [0.16ms]
(pass) validateTz accepts IANA names and rejects junk [0.13ms]

src/meal-consensus.test.ts:
Failed to persist analytics for get_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for bulk_import_meals: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for get_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for get_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
Failed to persist analytics for set_alcohol_tracking: database "fishhead" does not exist
(pass) consensus policy > all three equal -> canonical same value, all_agree, ready [0.12ms]
(pass) consensus policy > two within 10%, third beyond -> average agreeing pair, third outlier [0.11ms]
(pass) consensus policy > exactly 10% boundary agrees; just over threshold disagrees [0.10ms]
(pass) consensus policy > zero/near-zero denominator uses absolute epsilon, not division by zero [0.08ms]
(pass) consensus policy > missing/failed results are excluded and never treated as zero [0.09ms]
(pass) consensus policy > three usable values with no agreeing pair -> mean of all, no_consensus [0.05ms]
(pass) consensus policy > one usable result -> low_confidence, no fabricated canonical number [0.07ms]
(pass) consensus policy > nutrients evaluate independently; policy metadata is emitted [0.07ms]

src/legacy-meal-tools.integration.test.ts:
(skip) legacy meal MCP tools use the event projection > (unnamed)
(skip) legacy meal MCP tools use the event projection > log and all eight legacy reads work through the real MCP transport
(skip) legacy meal MCP tools use the event projection > bulk import, update, delete and export use current append-only projections
(skip) legacy meal MCP tools use the event projection > correction and cleanup are user scoped and preserve another user's rows
(skip) legacy meal MCP tools use the event projection > projection reads only current event scope, excludes deleted rows, preserves nulls, and respects timezone boundaries
(skip) legacy meal MCP tools use the event projection > bulk import covers multi-row control totals and duplicate retry idempotency
(skip) legacy meal MCP tools use the event projection > pending event-scope nutrition retains nulls end to end and never fabricates zeros
(skip) legacy meal MCP tools use the event projection > mixed and explicit-zero days keep partial sums and real zeros distinct
(skip) legacy meal MCP tools use the event projection > distinct per-nutrient presence, unlogged days and empty ranges disclose per-macro coverage
(skip) legacy meal MCP tools use the event projection > timezone local midnight assigns events to the correct local day on both sides
(skip) legacy meal MCP tools use the event projection > export carries the active correction before deletion excludes the event
(skip) legacy meal MCP tools use the event projection > public calculation MCP round-trips strict provenance and authorization
(skip) legacy meal MCP tools use the event projection > account cleanup removes every event child and preserves unrelated user data
(skip) legacy meal MCP tools use the event projection > log_meal discloses compatibility provenance, honestly on idempotent retry
(skip) legacy meal MCP tools use the event projection > update_meal discloses compatibility provenance on the new version
(skip) legacy meal MCP tools use the event projection > a committed calculation bundle completes a legacy write's disclosed provenance
(skip) legacy meal MCP tools use the event projection > bulk_import_meals reports per-row provenance and nulls for unwritten rows
(skip) legacy meal MCP tools use the event projection > (unnamed)
(skip) S6 sweep tools declare and return structured outputs > (unnamed)
(skip) S6 sweep tools declare and return structured outputs > inventory: every sweep tool advertises a declared outputSchema
(skip) S6 sweep tools declare and return structured outputs > water tools return parseable structuredContent on every success path
(skip) S6 sweep tools declare and return structured outputs > weight log and date reads return parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > weight today/update/delete return parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > get_weight_trends returns parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > widget display tools return parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > start_meal_import returns parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > (unnamed)

src/nutrition-bundle.test.ts:
(pass) calculation bundles accept supplied provider provenance [0.04ms]
(pass) calculation bundles reject non-finite values and duplicate scopes [0.05ms]
(pass) bundle fingerprints are independent of provider completion order [0.02ms]
(pass) bundle fingerprint includes resolved input and rejects tampering [0.03ms]
(pass) failed and unavailable provider rows require honest errors [0.03ms]
(pass) calculation bundles reject malformed scopes without throwing [0.12ms]
(pass) calculation bundles accept null and non-negative integer item scopes [0.09ms]

src/net.test.ts:
Failed to persist analytics for bulk_import_meals: database "fishhead" does not exist
Failed to persist analytics for bulk_import_meals: database "fishhead" does not exist
(pass) maskIp drops the host octet of an IPv4 address [0.07ms]
(pass) maskIp uses only the first hop of x-forwarded-for [0.02ms]
(pass) maskIp keeps the /48 prefix of an IPv6 address [0.02ms]
(pass) maskIp handles compressed IPv6 without mangling [0.01ms]
(pass) maskIp never leaks a full address — malformed/loopback collapse to '-' [0.05ms]

src/rate-limit.test.ts:
(pass) checkRateLimit allows 60 requests per user per minute, then blocks [0.21ms]
(pass) rate limit is per-user and independent [0.04ms]
(pass) _resetBuckets clears rate-limit windows [0.04ms]

src/search.test.ts:
Failed to persist analytics for bulk_import_meals: database "fishhead" does not exist
(pass) escapes LIKE metacharacters [0.08ms]
(pass) leaves plain text untouched
(pass) splits on whitespace, lowercases, drops empties [0.50ms]
(pass) caps at 5 tokens [0.13ms]
(pass) returns empty array for blank query [0.01ms]
(pass) merges case, whitespace, and trailing-punctuation variants [0.25ms]
(pass) keeps distinct descriptions as distinct groups [0.04ms]
(pass) sorts by count desc, ties broken by recency [0.05ms]
(pass) label and lastLoggedAt come from the newest entry in the group [0.03ms]
(pass) typical macros are medians of non-null values [0.03ms]
(pass) all-null macros yield null [0.03ms]
(pass) renders counts, typical macros, and last-logged date [0.90ms]
(pass) renders header with all query alternatives [0.10ms]
(pass) renders last-logged date in the user's timezone [0.09ms]
(pass) caps variations and reports the hidden count [0.20ms]
(pass) caps recent entries and includes ids [0.20ms]
(pass) renders '(no macros logged)' when every entry lacks macros [0.07ms]

src/foods.test.ts:
(pass) normalizeBarcode > keeps valid digit strings [0.06ms]
(pass) normalizeBarcode > strips spaces and separators [0.01ms]
(pass) normalizeBarcode > accepts EAN-8 lower bound and GTIN-14 upper bound [0.01ms]
(pass) normalizeBarcode > rejects too-short and too-long inputs [0.01ms]
(pass) normalizeBarcode > rejects non-numeric junk
(pass) fetchProductFromOFF > normalizes per-serving values when a serving size is present [1.09ms]
(pass) fetchProductFromOFF > maps fiber and total sugars per serving [0.08ms]
(pass) fetchProductFromOFF > falls back to per-100g fiber and sugars [0.06ms]
(pass) fetchProductFromOFF > leaves fiber and sugar null when OFF carries neither [0.05ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > converts ABV to grams of ethanol using the mL serving volume [0.09ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > keeps a genuine 0% ABV as 0 g, distinct from unknown [0.06ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > is null when OFF parsed no serving quantity [0.06ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > is null when the serving quantity is a mass, not a volume [0.04ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > is null on the per-100g basis, which would mix bases [0.07ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > is null when the unit is not '% vol' [0.10ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > is null for an out-of-range ABV instead of throwing [0.11ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > a spirit's ABV is never mistaken for grams [0.05ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > falls back to per-100g basis when no serving energy [0.06ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > returns null when OFF reports status 0 [0.04ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > returns null on HTTP 404 [0.03ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > throws on unexpected HTTP error so the caller can degrade [0.05ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > treats a stub product with no macros as not found (no empty cache) [0.04ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > keeps a product that has at least one macro even if others are null [0.04ms]
(pass) fetchProductFromOFF alcohol (ABV, not grams) > sends the configured User-Agent and throws when it is unset [0.12ms]
(pass) formatFoodResult > includes brand, serving, macros, and source [0.03ms]
(pass) formatFoodResult > renders n/a for missing macros and omits empty brand [0.02ms]

src/mcp-food-tracking.test.ts:
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > (unnamed)
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > accepts a multi-item event and returns the full structured payload
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > explicit add authorization returns pending, never synced
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > duplicate retry returns the original event and never duplicates the journal
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > rejects safe but unrelated media storage keys
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > validation rejects malformed input before any write
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > (unnamed)
(skip) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > (unnamed)
(skip) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > commits an event+item bundle and reads item canonicals back through public provenance
(skip) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal capture MCP lifecycle tools > (unnamed)
(skip) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations
(skip) meal capture MCP lifecycle tools > discovers and calls get/cancel/expire with user scoping and states
(skip) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations without persisting rows
(skip) meal capture MCP lifecycle tools > (unnamed)
(skip) attach_meal_capture_media MCP tool > (unnamed)
(skip) attach_meal_capture_media MCP tool > start -> attach -> draft referencing media -> confirm persists event media
(skip) attach_meal_capture_media MCP tool > retry through MCP returns the same media identity without duplicating row or file
(skip) attach_meal_capture_media MCP tool > rejects cross-user capture media attach
(skip) attach_meal_capture_media MCP tool > malformed input matrix: invalid base64, disallowed MIME, kind mismatch, oversized
(skip) attach_meal_capture_media MCP tool > attach on a confirmed capture is rejected and stages nothing
(skip) attach_meal_capture_media MCP tool > (unnamed)
(pass) confirm_meal_capture exported output schema (S6) > parses a valid confirm payload through the exact export [0.37ms]
(pass) confirm_meal_capture exported output schema (S6) > rejects extra keys under its own .strict() boundary [0.11ms]
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > (unnamed)
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > inventory: all nine capture lifecycle tools advertise a declared outputSchema
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > start -> append -> answer -> draft -> get -> cancel returns schema-exact structuredContent
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > expire_meal_capture returns schema-exact structuredContent for overdue captures
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > confirm and attach parse through their exact exported contracts
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > (unnamed)

src/readiness.test.ts:
(pass) redactDatabaseUrl > strips username and password from a password-bearing URL [0.10ms]
(pass) redactDatabaseUrl > never surfaces percent-encoded credentials, decoded or raw [0.03ms]
(pass) redactDatabaseUrl > drops query string and fragment [0.02ms]
(pass) redactDatabaseUrl > keeps host-only identity when port and database are absent [0.01ms]
(pass) redactDatabaseUrl > keeps host and database when port is absent [0.01ms]
(pass) redactDatabaseUrl > labels malformed URLs as invalid without echoing input [0.04ms]
(pass) redactDatabaseUrl > labels missing values as missing [0.01ms]
(pass) redactDatabaseUrl > no fixture output contains its own credentials [0.08ms]
(pass) checkDatabaseReadiness > resolves ok after a real successful SELECT 1 [0.21ms]
(pass) checkDatabaseReadiness > maps a query failure to a redacted, driver-free error [0.11ms]
(pass) checkDatabaseReadiness > a hanging probe fails at the hard timeout, bounded [52.16ms]
(pass) checkDatabaseReadiness > a missing DATABASE_URL is reported as a fixed label, not echoed [0.10ms]

src/chunk.test.ts:
(pass) empty input produces no chunks and no split dates [0.10ms]
(pass) fewer rows than max stay in one chunk [0.12ms]
(pass) the reported bug: a 50-row boundary falling mid-date no longer overflows [0.23ms]
(pass) a date boundary landing exactly on the cap keeps working [0.08ms]
(pass) a single date alone over the cap is split, and reported in splitDates [0.06ms]
(pass) an oversized date closes the preceding chunk before splitting [0.07ms]
(pass) an oversized date is followed by normal dates that chunk independently [0.07ms]
(pass) multiple oversized dates are each reported [0.07ms]
(pass) a bare date (no time) is still grouped correctly [0.03ms]
(pass) respects a custom max [0.03ms]

src/csv.test.ts:
(pass) parses quoted fields containing delimiters, quotes and newlines [0.72ms]
(pass) source line numbers survive a quoted newline [0.06ms]
(pass) handles CRLF without leaving carriage returns in the last cell [0.13ms]
(pass) handles a final row with no trailing newline [0.04ms]
(pass) skips blank rows and trailing blank lines [0.04ms]
(pass) pads ragged rows and warns [0.07ms]
(pass) an empty or header-only file yields no rows [0.05ms]
(pass) decodeBytes honours the BOM, including UTF-16 [1.06ms]
(pass) a UTF-8 BOM does not become part of the first header name [0.11ms]
(pass) stripBom only removes a leading BOM [0.02ms]
(pass) sniffs a semicolon delimiter even when text fields contain commas [0.11ms]
(pass) sniffs tab-delimited files [0.04ms]
(pass) detects a comma decimal separator and parses it correctly [0.08ms]
(pass) parseNumber distinguishes absent from zero [0.04ms]
(pass) parseNumber strips units and thousands separators [0.04ms]
(pass) isBlankCell recognises the tokens real exports use [0.05ms]
(pass) splitAmount unpacks Cronometer's value-plus-unit cell [0.10ms]
(pass) normalizeHeader folds unit suffixes and the micro sign [0.06ms]
(pass) normalizeHeader folds accents so an accented header matches its alias [0.10ms]
(pass) duplicate header names are kept positional and warned about [0.09ms]
(pass) findColumn matches across alias spellings and reports absence [0.04ms]
(pass) totals rows are excluded rather than imported as a phantom meal [0.12ms]
(pass) isTotalsRow does not fire on a food that merely starts with the word [0.05ms]
(pass) isDeletedRow reads a Lose It! style Deleted column [0.08ms]
(pass) parses a MyFitnessPal-shaped export (meal-level rows, BOM, CRLF) [0.16ms]
(pass) parses a Cronometer-shaped export (Day/Time, packed Amount, dup columns) [0.11ms]
(pass) parses a Lose It!-shaped export (MM/DD/YYYY, n/a, Deleted) [0.12ms]
(pass) parses a MacroFactor-shaped export whose header contains a comma [0.07ms]
(pass) a parsed export feeds straight into runImport [2.37ms]
(pass) parses the server's own export format round-trip [0.10ms]
(pass) sniffDateFormat detects day-first from a value whose day exceeds 12 [0.17ms]
(pass) sniffDateFormat detects month-first and plain ISO [0.03ms]
(pass) sniffDateFormat flags samples it cannot decide so the UI must ask [0.04ms]
(pass) sniffDateFormat ignores blank and unparseable cells rather than skewing [0.03ms]
(pass) toIsoDate converts both component orders and zero-pads [0.15ms]
(pass) toIsoDate rejects dates that do not exist instead of rolling over [0.04ms]
(pass) toIsoDate expands a 2-digit year once the format states the order [0.06ms]
(pass) sniffDateFormat reads day-vs-month from 2-digit years but flags the guess [0.04ms]
(pass) toIsoDate output is accepted by the server's resolveLoggedAt [0.55ms]
(pass) normalizeTime pads an unpadded 24-hour hour [0.08ms]
(pass) normalizeTime converts 12-hour AM/PM to 24-hour [0.04ms]
(pass) normalizeTime accepts the export-observed AM/PM spellings [0.04ms]
(pass) normalizeTime preserves seconds when present [0.02ms]
(pass) normalizeTime rejects out-of-range and unparseable values [0.05ms]
(pass) normalizeTime output is accepted by the server's resolveLoggedAt [0.49ms]
(pass) sniffEnergyUnit reads the unit from the header first [0.14ms]
(pass) sniffEnergyUnit falls back to magnitude only for an uninformative header [0.05ms]
(pass) toKcal divides kJ by 4.184 and rounds to a whole kcal [0.03ms]
(pass) toKcal rounds a kcal column too [0.02ms]

src/import.test.ts:
(pass) resolveLoggedAt accepts the three documented forms [1.55ms]
(pass) resolveLoggedAt resolves offset-less local time using the HISTORICAL offset [0.46ms]
(pass) resolveLoggedAt rejects dates that would silently roll over [0.06ms]
(pass) resolveLoggedAt rejects a local date that never existed in the zone [0.89ms]
(pass) resolveLoggedAt bounds the date range without blocking backfill [1.62ms]
(pass) normalizeMealType treats blank-ish source cells as absent, not snack [0.05ms]
(pass) inferMealType uses local-time cutoffs [3.31ms]
(pass) synthesizeDescription only fires when the meal type came from the file [0.05ms]
(pass) a row with neither description nor meal_type is rejected, not invented [0.42ms]
(pass) validateRow produces a MealInput ready for insertMeal [0.34ms]
(pass) validateRow rounds fractional calories to the integer column [0.39ms]
(pass) rows differing only below the kcal rounding boundary both import [1.04ms]
(pass) validateRow carries fiber, sugar and alcohol through to the MealInput [0.80ms]
(pass) alcohol is stored even though display of it is opt-in [0.46ms]
(pass) validateRow bounds alcohol far tighter than the other macros [4.74ms]
(pass) validateRow rejects implausible and malformed numbers with the observed value [1.33ms]
(pass) validateRow rejects text that Postgres could not store [0.39ms]
(pass) validateRow does not pre-decode escape sequences [0.35ms]
(pass) validateRow rejects a bad source_line [0.04ms]
(pass) identical rows in one batch get DISTINCT keys via the occurrence ordinal [0.73ms]
(pass) keys exclude source_line so a re-exported file still dedupes [0.66ms]
(pass) fiber, sugar and alcohol are EXCLUDED from the content digest [2.74ms]
(pass) checkBatch catches a row-count mismatch [0.03ms]
(pass) checkBatch requires unique, increasing source lines [0.04ms]
(pass) checkBatch does not warn about a leading offset (header row or chunk 2) [0.03ms]
(pass) checkBatch warns about interior gaps not explained by rows_skipped [0.04ms]
(pass) checkBatch reconciles the kcal control total within tolerance [0.04ms]
(pass) checkBatch warns rather than fails when the kcal check cannot run [0.06ms]
(pass) runImport writes two rows for two identical same-date rows [0.78ms]
(pass) runImport is a perfect no-op when the same payload is replayed [2.04ms]
(pass) runImport dry run writes nothing and predicts deduplication [2.46ms]
(pass) runImport never reports a dry run as failed just because nothing was written [0.38ms]
(pass) runImport isolates a per-row database failure [1.25ms]
(pass) runImport on_error=abort writes nothing when a row fails validation [0.46ms]
(pass) runImport on_error=continue imports the good rows and reports the bad [0.73ms]
(pass) runImport reports failed when every row is bad [0.06ms]
(pass) runImport aborts the whole batch on a control-total mismatch [0.09ms]
(pass) runImport rejects an over-large batch with a structured report [0.09ms]
(pass) runImport surfaces provenance for inferred and synthesized values [0.85ms]
(pass) runImport echoes skipped_by_caller without folding it into the row identity [0.38ms]
(pass) buildSummaryText names failing lines and stays prose, not JSON [0.38ms]
(pass) runImport warns when an unconfigured timezone placed the rows [0.72ms]
(pass) rows carrying their own offset do not trigger the timezone warning [0.08ms]
(pass) a configured timezone never triggers the warning [0.38ms]
(pass) serialized output validates against the declared outputSchema on every path [3.29ms]
(pass) written rows disclose compatibility provenance; unwritten rows null it [2.06ms]
(pass) buildSummaryText explains a batch-gate failure that has no per-row results [0.07ms]

src/export.test.ts:
(pass) emits a header even with no meals [0.07ms]
(pass) header and data rows have identical field counts [0.97ms]
(pass) every value lands under its own header name [0.16ms]
(pass) header column order is stable and importer-compatible [0.03ms]
(pass) renders timestamps in UTC when tz is UTC [0.06ms]
(pass) renders timestamps in the user's timezone when set [0.08ms]
(pass) leaves null macros and notes as empty fields [0.13ms]
(pass) quotes and escapes fields containing commas, quotes, and newlines [0.07ms]

src/alt-pages.test.ts:
(pass) ALT_PAGES is non-empty and parsed [0.02ms]
(pass) every ALT_PAGES route maps to a non-empty public file [0.16ms]
(pass) every ALT_PAGES route is listed in sitemap.xml [0.43ms]

src/db.integration.test.ts:
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > (unnamed)
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: fresh DB applies 001 then 002 and exposes the new schema
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: existing DB loses legacy meals rows but keeps profiles/goals/water/weight
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: rerunning 002 is safe and never half-applies
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: normal meal event writes source_id after 004
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: public_landing_stats counts meal_events current versions
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > (unnamed)
(skip) database readiness probe (requires DATABASE_URL_TEST) > readiness succeeds against the live test database
(skip) database readiness probe (requires DATABASE_URL_TEST) > readiness fails in bounded time against a wrong port, redacted
(skip) database readiness probe (requires DATABASE_URL_TEST) > routes: /ready is 200 with a reachable database, /health stays ok

src/widgets.test.ts:
(pass) nutrition-summary assembles into a self-contained widget [3.06ms]
(pass) goal-progress assembles into a self-contained widget [1.67ms]
(pass) meal-logged assembles into a self-contained widget [2.21ms]
(pass) trends assembles into a self-contained widget [1.62ms]
(pass) weight-trends assembles into a self-contained widget [1.02ms]
(pass) import-meals assembles into a self-contained widget [3.43ms]
(pass) component-gallery assembles into a self-contained widget [1.62ms]
(pass) nutrition-summary inlines each @include'd partial in full [0.54ms]
(pass) goal-progress inlines each @include'd partial in full [0.36ms]
(pass) meal-logged inlines each @include'd partial in full [0.37ms]
(pass) trends inlines each @include'd partial in full [0.46ms]
(pass) weight-trends inlines each @include'd partial in full [0.27ms]
(pass) import-meals inlines each @include'd partial in full [0.36ms]
(pass) component-gallery inlines each @include'd partial in full [0.49ms]
(pass) trends widget preserves null and explicit zero averages [0.15ms]
(pass) trends renders no-data rather than zero for null core macros [0.15ms]
(pass) goal-progress renders no-data rather than zero for null core macros [0.11ms]
(pass) nutrition-summary renders no-data rather than zero for null core macros [0.11ms]
(pass) meal-logged renders no-data rather than zero for null core macros [0.10ms]
(pass) unknown widget key throws [0.06ms]

src/units.test.ts:
(pass) toGrams converts kg to integer grams [0.05ms]
(pass) toGrams converts lb to integer grams using the exact pound [0.01ms]
(pass) fromGrams converts grams back, rounded to 1 decimal [0.02ms]
(pass) kg round-trips through grams exactly at 1-decimal precision [0.03ms]
(pass) lb round-trips through grams at 1-decimal precision [0.02ms]
(pass) lb->kg reference conversion is correct [0.01ms]
(pass) toGrams rejects non-finite values [0.04ms]
(pass) formatWeight renders unit-suffixed string [0.02ms]
(pass) pickWriteUnit prefers the explicit unit over the saved preference [0.02ms]
(pass) pickWriteUnit falls back to the saved preference when no explicit unit
(pass) pickWriteUnit throws when no explicit unit and no preference (never guesses) [0.03ms]
(pass) isPlausibleWeightGrams accepts human weights and rejects magnitude errors [0.04ms]
(pass) isWeightUnit guards kg/lb only [0.03ms]
(pass) toStoredInteger rounds fractional values for the integer columns [0.02ms]

src/calculation-bundles.integration.test.ts:
(skip) calculation bundle PostgreSQL integration > (unnamed)
(skip) calculation bundle PostgreSQL integration > persists every provider field and recomputes canonical values
(skip) calculation bundle PostgreSQL integration > same event, version, and fingerprint is idempotent
(skip) calculation bundle PostgreSQL integration > rejects tampered or conflicting content without mutation
(skip) calculation bundle PostgreSQL integration > rolls back all rows when transaction hook fails after persistence
(skip) calculation bundle PostgreSQL integration > persists an immutable correction with audit and journal provenance
(skip) calculation bundle PostgreSQL integration > rejects same-key retries whose correction identity is altered
(skip) calculation bundle PostgreSQL integration > keeps an exact same correction request idempotent
(skip) calculation bundle PostgreSQL integration > materializes one canonical row per scope with scope-local source IDs
(skip) calculation bundle PostgreSQL integration > isolates extreme item-scope values from the event canonical
(skip) calculation bundle PostgreSQL integration > marks item scopes without usable provider data as pending, siblings unaffected
(skip) calculation bundle PostgreSQL integration > retry with the same fingerprint keeps exactly one canonical row per scope
(skip) calculation bundle PostgreSQL integration > correction materializes per-scope canonicals and leaves the prior version immutable
(skip) calculation bundle PostgreSQL integration > rolls back every per-scope row when the transaction hook fails
(skip) calculation bundle PostgreSQL integration > (unnamed)

src/backup-policy.test.ts:
(pass) backup retention policy > policy returns independent DB and media targets [0.04ms]
(pass) backup retention policy > daily retention is exactly 30 days [0.04ms]
(pass) backup retention policy > monthly retention is forever (no expiry) [0.01ms]
(pass) permanent delete orchestration > permanent delete refuses without explicit confirmation [0.26ms]
(pass) permanent delete orchestration > permanent delete removes live data and calls both backup adapters [0.12ms]
(pass) permanent delete orchestration > an unconfirmed backup adapter yields a partial receipt, never claimed success [0.08ms]
(skip) ordinary delete tombstone (requires DATABASE_URL_TEST) > (unnamed)
(skip) ordinary delete tombstone (requires DATABASE_URL_TEST) > tombstone keeps versions, media metadata and backup manifests untouched
(skip) ordinary delete tombstone (requires DATABASE_URL_TEST) > (unnamed)

src/db-helpers.test.ts:
(pass) mealIdempotencyKey > fiber, sugar and alcohol are EXCLUDED from the derived key [0.11ms]
(pass) mealIdempotencyKey > each new field is excluded on its own, not just in combination [0.07ms]
(pass) mealIdempotencyKey > two meals differing only in fiber dedupe to one — the accepted cost [0.02ms]
(pass) mealIdempotencyKey > every field that IS hashed changes the key [0.11ms]
(pass) mealIdempotencyKey > is deterministic and marked as server-derived [0.05ms]
(pass) mealIdempotencyKey > an absent field and an explicitly null-ish one hash alike [0.02ms]
(pass) mealIdempotencyKey > stays in step with rowContentDigest in src/import.ts [0.03ms]
(pass) widgetsEnabledFromProfile > defaults to true when there is no profile row [0.02ms]
(pass) widgetsEnabledFromProfile > defaults to true when the column is absent [0.03ms]
(pass) widgetsEnabledFromProfile > honours an explicit opt-out [0.01ms]
(pass) alcoholTrackingEnabledFromProfile > defaults to FALSE when there is no profile row — alcohol is opt-in [0.01ms]
(pass) alcoholTrackingEnabledFromProfile > defaults to false when the column is absent [0.02ms]
(pass) alcoholTrackingEnabledFromProfile > an existing profile that never opted in stays off
(pass) alcoholTrackingEnabledFromProfile > honours an explicit opt-in
(pass) preferredDrinkUnitFromProfile > returns null when there is no profile row or no preference [0.02ms]
(pass) preferredDrinkUnitFromProfile > returns a saved preference [0.01ms]
(pass) preferredDrinkUnitFromProfile > degrades unrecognised column values to null [0.02ms]
(pass) no-profile defaults, together > a user with no profile row gets widgets on, alcohol off, no drink unit [0.02ms]
(pass) fetchAllPages > returns everything when it all fits in one short page [0.15ms]
(pass) fetchAllPages > empty source returns an empty array from a single fetch [0.04ms]
(pass) fetchAllPages > pages through a total larger than one page (the reported bug) [0.14ms]
(pass) fetchAllPages > total an exact multiple of pageSize still terminates [0.13ms]
(pass) fetchAllPages > honours a custom page size [0.05ms]
(pass) fetchAllPages > preserves row order across page boundaries [0.07ms]

src/meal-event-projection.test.ts:
(pass) renders current ordered items and joins current notes without fabricating nutrition [0.09ms]

src/food-tracking-docs.test.ts:
(pass) agent-driven food-tracking docs state the shipped boundary [0.08ms]
(pass) agent-driven docs enumerate the forward migration chain [0.40ms]
(pass) docs do not promise provider or transport work owned by Hermes [0.08ms]

public/widgets/macros.test.ts:
(pass) a ceiling under its limit reads as being under it, not as budget left [0.33ms]
(pass) a ceiling exceeded reads as over, and is flagged [0.03ms]
(pass) exactly at a ceiling is its own state, not '0 g under' [0.03ms]
(pass) a ceiling target of 0 is a real limit [0.04ms]
(pass) a floor target of 0 is still no goal [0.02ms]
(pass) floors are unchanged, and only floors take the wording override [0.03ms]
(pass) an interactive tile names its value and goal state, then the action [0.42ms]
(pass) a tile made interactive by sub-components alone still names its value [0.09ms]
(pass) no goal is still a value, not a bare action [0.05ms]
(pass) every interactive tile carries its formatted value, and none is spoken as '·' [0.28ms]
(pass) a static tile keeps its ring label and goal caption exposed [0.07ms]
(pass) a file with alcohol data says so when tracking is off [0.81ms]
(pass) no notice when the user tracks alcohol — the column just imports [0.16ms]
(pass) no notice when the file has no alcohol column [0.15ms]
(pass) the notice reuses the gate's alias list, not a looser match [0.15ms]
(pass) the importer defaults to alcohol tracking OFF [0.23ms]

public/widgets/import-time.test.ts:
(pass) a 12-hour Time column (Cronometer) produces a zero-padded 24-hour logged_at [1.34ms]
(pass) an unpadded 24-hour Time column is zero-padded too [0.19ms]
(pass) a time embedded in the date cell is normalized the same way [0.24ms]
(pass) an unparseable time is dropped, not failed — the row still imports, dateless [0.17ms]

public/widgets/import-run.test.ts:
(pass) a failed dry run surfaces the server's reason in chunkErrors, not silently [1.56ms]
(pass) a failed dry run stops before writing anything for real [0.21ms]
(pass) a failed dry run with no warnings still leaves a visible reason [0.17ms]
(pass) a passing dry run proceeds to write for real (happy path unaffected) [0.19ms]

156 tests skipped:
(skip) calculation concurrency and correction acceptance matrix > (unnamed)
(skip) calculation concurrency and correction acceptance matrix > concurrent identical calculation bundles converge
(skip) calculation concurrency and correction acceptance matrix > concurrent identical corrections yield one new version
(skip) calculation concurrency and correction acceptance matrix > migration 005 reruns safely
(skip) calculation concurrency and correction acceptance matrix > correction rollback leaves prior state intact
(skip) calculation concurrency and correction acceptance matrix > stale-version correction with fresh idempotency key is rejected
(skip) calculation concurrency and correction acceptance matrix > direct cross-user correction is rejected
(skip) calculation concurrency and correction acceptance matrix > MCP correction round-trip
(skip) calculation concurrency and correction acceptance matrix > failed provider is readable through public provenance
(skip) calculation concurrency and correction acceptance matrix > (unnamed)
(skip) meal event repository (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal event repository (requires DATABASE_URL_TEST) > create: persists event with two positions, evidence and media metadata in one transaction
(skip) meal event repository (requires DATABASE_URL_TEST) > create: omitted consumed_at is stored equal to reported_at
(skip) meal event repository (requires DATABASE_URL_TEST) > create: same idempotency-key retry returns the original and creates no duplicates
(skip) meal event repository (requires DATABASE_URL_TEST) > analyze-first then explicit add retry authorizes root and creates one journal
(skip) meal event repository (requires DATABASE_URL_TEST) > concurrent explicit add retries after analyze create one journal
(skip) meal event repository (requires DATABASE_URL_TEST) > create: concurrent same-key creates yield one aggregate
(skip) meal event repository (requires DATABASE_URL_TEST) > create: injected DB failure rolls back root, version, items, inputs, results and journal together
(skip) meal event repository (requires DATABASE_URL_TEST) > create: a failed provider is stored as a failed result; the raw event stays committed
(skip) meal event repository (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal event corrections (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: creates version 2 and advances current_version atomically
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: version 1 rows and raw inputs remain unchanged
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: reads default to current version; history returns both
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: repeated correction fingerprint returns version 2, never version 3
(skip) meal event corrections (requires DATABASE_URL_TEST) > correction: a failed correction leaves version 1 current with no partial version 2
(skip) meal event corrections (requires DATABASE_URL_TEST) > (unnamed)
(skip) canonical persistence (requires DATABASE_URL_TEST) > (unnamed)
(skip) canonical persistence (requires DATABASE_URL_TEST) > two agree plus one outlier: canonical averages the pair and records the outlier
(skip) canonical persistence (requires DATABASE_URL_TEST) > no agreeing pair: canonical persists no_consensus with the mean of all eligible
(skip) canonical persistence (requires DATABASE_URL_TEST) > one usable provider: low_confidence, value as-is, missing nutrients stay NULL
(skip) canonical persistence (requires DATABASE_URL_TEST) > item scope: per-item provider results persist a per-item canonical row
(skip) canonical persistence (requires DATABASE_URL_TEST) > (unnamed)
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > (unnamed)
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: authorized add intent inserts one pending row before any external call
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: absent authorization creates no external-write journal row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: replayed create with the same key never duplicates the journal row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: injected external failure marks the row failed and keeps local state intact
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: retry increments attempts without a duplicate row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: illegal transitions are rejected; success records external id
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: delivery drives the injectable writer and records success
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: a throwing writer leaves the row failed and local state intact
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: retry after failure re-invokes the writer without a duplicate row
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: delivering a succeeded entry is rejected, never re-sent
(skip) sync journal and add authorization (requires DATABASE_URL_TEST) > (unnamed)
(skip) durable meal capture lifecycle > (unnamed)
(skip) durable meal capture lifecycle > persists across reads, idempotent messages/answers, and valid cancel/expire transitions
(skip) durable meal capture lifecycle > saves media provenance and confirms exactly once under concurrency
(skip) durable meal capture lifecycle > rejects draft media that does not exactly match staged capture media
(skip) durable meal capture lifecycle > rolls back event aggregate when confirmation fails before capture update, then retries
(skip) durable meal capture lifecycle > (unnamed)
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > (unnamed)
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > happy path: stages bytes, persists row, on-disk hash matches
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > rollback: injected INSERT failure removes both DB row and staged file
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > retry-safe: identical bytes attached twice yield one row and one file
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > tampered caller sha256 is rejected; nothing staged or persisted
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > state guard: attach on a cancelled capture stages nothing
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > cross-user attach is rejected as not found; nothing staged
(skip) capture media byte lifecycle (attachCaptureMediaBytes) > (unnamed)
(skip) capture media durability under rejected and duplicate retries (S5 F1) > (unnamed)
(skip) capture media durability under rejected and duplicate retries (S5 F1) > wrong-user retry of committed bytes preserves the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > same-owner retry after cancel preserves the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > same-owner retry after confirmation preserves the original row, file, and event reference
(skip) capture media durability under rejected and duplicate retries (S5 F1) > injected transactional failure on a duplicate attempt preserves the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > coordinated concurrent duplicate success and rejected/failing attempts preserve the original row and file
(skip) capture media durability under rejected and duplicate retries (S5 F1) > dedup retry heals a missing committed file with identical bytes
(skip) capture media durability under rejected and duplicate retries (S5 F1) > (unnamed)
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > (unnamed)
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > real COMMIT succeeds then acknowledgement is lost: attach rejects but row and file survive, retry returns the original identity
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > real COMMIT succeeds then acknowledgement is lost AND reconciliation is unavailable: possible orphan is retained, never deleted
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > COMMIT rejected before being sent: reconciliation proves no row and removes the staged file
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > non-cooperating conflicting row with a different key: conflict row and file survive, redundant staged key is removed
(skip) capture media commit-outcome reconciliation (S5 remediation 2) > (unnamed)
(skip) legacy meal MCP tools use the event projection > (unnamed)
(skip) legacy meal MCP tools use the event projection > log and all eight legacy reads work through the real MCP transport
(skip) legacy meal MCP tools use the event projection > bulk import, update, delete and export use current append-only projections
(skip) legacy meal MCP tools use the event projection > correction and cleanup are user scoped and preserve another user's rows
(skip) legacy meal MCP tools use the event projection > projection reads only current event scope, excludes deleted rows, preserves nulls, and respects timezone boundaries
(skip) legacy meal MCP tools use the event projection > bulk import covers multi-row control totals and duplicate retry idempotency
(skip) legacy meal MCP tools use the event projection > pending event-scope nutrition retains nulls end to end and never fabricates zeros
(skip) legacy meal MCP tools use the event projection > mixed and explicit-zero days keep partial sums and real zeros distinct
(skip) legacy meal MCP tools use the event projection > distinct per-nutrient presence, unlogged days and empty ranges disclose per-macro coverage
(skip) legacy meal MCP tools use the event projection > timezone local midnight assigns events to the correct local day on both sides
(skip) legacy meal MCP tools use the event projection > export carries the active correction before deletion excludes the event
(skip) legacy meal MCP tools use the event projection > public calculation MCP round-trips strict provenance and authorization
(skip) legacy meal MCP tools use the event projection > account cleanup removes every event child and preserves unrelated user data
(skip) legacy meal MCP tools use the event projection > log_meal discloses compatibility provenance, honestly on idempotent retry
(skip) legacy meal MCP tools use the event projection > update_meal discloses compatibility provenance on the new version
(skip) legacy meal MCP tools use the event projection > a committed calculation bundle completes a legacy write's disclosed provenance
(skip) legacy meal MCP tools use the event projection > bulk_import_meals reports per-row provenance and nulls for unwritten rows
(skip) legacy meal MCP tools use the event projection > (unnamed)
(skip) S6 sweep tools declare and return structured outputs > (unnamed)
(skip) S6 sweep tools declare and return structured outputs > inventory: every sweep tool advertises a declared outputSchema
(skip) S6 sweep tools declare and return structured outputs > water tools return parseable structuredContent on every success path
(skip) S6 sweep tools declare and return structured outputs > weight log and date reads return parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > weight today/update/delete return parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > get_weight_trends returns parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > widget display tools return parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > start_meal_import returns parseable structuredContent
(skip) S6 sweep tools declare and return structured outputs > (unnamed)
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > (unnamed)
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > accepts a multi-item event and returns the full structured payload
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > explicit add authorization returns pending, never synced
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > duplicate retry returns the original event and never duplicates the journal
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > rejects safe but unrelated media storage keys
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > validation rejects malformed input before any write
(skip) log_meal_event MCP tool (requires DATABASE_URL_TEST) > (unnamed)
(skip) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > (unnamed)
(skip) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > commits an event+item bundle and reads item canonicals back through public provenance
(skip) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > (unnamed)
(skip) meal capture MCP lifecycle tools > (unnamed)
(skip) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations
(skip) meal capture MCP lifecycle tools > discovers and calls get/cancel/expire with user scoping and states
(skip) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations without persisting rows
(skip) meal capture MCP lifecycle tools > (unnamed)
(skip) attach_meal_capture_media MCP tool > (unnamed)
(skip) attach_meal_capture_media MCP tool > start -> attach -> draft referencing media -> confirm persists event media
(skip) attach_meal_capture_media MCP tool > retry through MCP returns the same media identity without duplicating row or file
(skip) attach_meal_capture_media MCP tool > rejects cross-user capture media attach
(skip) attach_meal_capture_media MCP tool > malformed input matrix: invalid base64, disallowed MIME, kind mismatch, oversized
(skip) attach_meal_capture_media MCP tool > attach on a confirmed capture is rejected and stages nothing
(skip) attach_meal_capture_media MCP tool > (unnamed)
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > (unnamed)
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > inventory: all nine capture lifecycle tools advertise a declared outputSchema
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > start -> append -> answer -> draft -> get -> cancel returns schema-exact structuredContent
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > expire_meal_capture returns schema-exact structuredContent for overdue captures
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > confirm and attach parse through their exact exported contracts
(skip) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > (unnamed)
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > (unnamed)
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: fresh DB applies 001 then 002 and exposes the new schema
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: existing DB loses legacy meals rows but keeps profiles/goals/water/weight
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: rerunning 002 is safe and never half-applies
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: normal meal event writes source_id after 004
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > migration: public_landing_stats counts meal_events current versions
(skip) food-tracking migrations (requires DATABASE_URL_TEST) > (unnamed)
(skip) database readiness probe (requires DATABASE_URL_TEST) > readiness succeeds against the live test database
(skip) database readiness probe (requires DATABASE_URL_TEST) > readiness fails in bounded time against a wrong port, redacted
(skip) database readiness probe (requires DATABASE_URL_TEST) > routes: /ready is 200 with a reachable database, /health stays ok
(skip) calculation bundle PostgreSQL integration > (unnamed)
(skip) calculation bundle PostgreSQL integration > persists every provider field and recomputes canonical values
(skip) calculation bundle PostgreSQL integration > same event, version, and fingerprint is idempotent
(skip) calculation bundle PostgreSQL integration > rejects tampered or conflicting content without mutation
(skip) calculation bundle PostgreSQL integration > rolls back all rows when transaction hook fails after persistence
(skip) calculation bundle PostgreSQL integration > persists an immutable correction with audit and journal provenance
(skip) calculation bundle PostgreSQL integration > rejects same-key retries whose correction identity is altered
(skip) calculation bundle PostgreSQL integration > keeps an exact same correction request idempotent
(skip) calculation bundle PostgreSQL integration > materializes one canonical row per scope with scope-local source IDs
(skip) calculation bundle PostgreSQL integration > isolates extreme item-scope values from the event canonical
(skip) calculation bundle PostgreSQL integration > marks item scopes without usable provider data as pending, siblings unaffected
(skip) calculation bundle PostgreSQL integration > retry with the same fingerprint keeps exactly one canonical row per scope
(skip) calculation bundle PostgreSQL integration > correction materializes per-scope canonicals and leaves the prior version immutable
(skip) calculation bundle PostgreSQL integration > rolls back every per-scope row when the transaction hook fails
(skip) calculation bundle PostgreSQL integration > (unnamed)
(skip) ordinary delete tombstone (requires DATABASE_URL_TEST) > (unnamed)
(skip) ordinary delete tombstone (requires DATABASE_URL_TEST) > tombstone keeps versions, media metadata and backup manifests untouched
(skip) ordinary delete tombstone (requires DATABASE_URL_TEST) > (unnamed)

 498 pass
 156 skip
 0 fail
 2436 expect() calls
Ran 654 tests across 35 files. [1.95s]
Unit gate totals: 498 pass, 0 fail, 156 skip, 654 tests (DB suites are run by test:db).
```

stderr:

```text
$ bun run scripts/test-unit-gate.ts
```

### Command 5 — DB gate, both URLs explicit (plan line 708)

Command:
`DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`

Exit status: 0

stdout:

```text
=== src/db.integration.test.ts ===
bun test v1.3.14 (d1632b29)
Nutrition MCP server listening on 0.0.0.0:8080


src/db.integration.test.ts:
(pass) food-tracking migrations (requires DATABASE_URL_TEST) > migration: fresh DB applies 001 then 002 and exposes the new schema [74.19ms]
(pass) food-tracking migrations (requires DATABASE_URL_TEST) > migration: existing DB loses legacy meals rows but keeps profiles/goals/water/weight [55.92ms]
(pass) food-tracking migrations (requires DATABASE_URL_TEST) > migration: rerunning 002 is safe and never half-applies [58.23ms]
(pass) food-tracking migrations (requires DATABASE_URL_TEST) > migration: normal meal event writes source_id after 004 [70.14ms]
(pass) food-tracking migrations (requires DATABASE_URL_TEST) > migration: public_landing_stats counts meal_events current versions [50.53ms]
(pass) database readiness probe (requires DATABASE_URL_TEST) > readiness succeeds against the live test database [5.55ms]
(pass) database readiness probe (requires DATABASE_URL_TEST) > readiness fails in bounded time against a wrong port, redacted [4.67ms]
(pass) database readiness probe (requires DATABASE_URL_TEST) > routes: /ready is 200 with a reachable database, /health stays ok [109.78ms]

 8 pass
 0 fail
 52 expect() calls
Ran 8 tests across 1 file. [483.00ms]
=== src/meal-events.test.ts ===
bun test v1.3.14 (d1632b29)


src/meal-events.test.ts:
(pass) meal event domain contracts > derives explicit provenance without converting missing values to zero [0.07ms]
(pass) meal event domain contracts > does not overclaim ready when persisted bundle evidence is incomplete [0.01ms]
(pass) meal event domain contracts > marks failed or unavailable evidence as unavailable even with a fingerprint [0.01ms]
(pass) meal event domain contracts > one event accepts multiple ordered positions [0.20ms]
(pass) meal event domain contracts > explicit reported_at and consumed_at are preserved as given [0.06ms]
(pass) meal event domain contracts > omitted consumed_at resolves to the same instant as reported_at [0.01ms]
(pass) meal event domain contracts > input precedence: user text beats audio, photo-derived and assumptions [0.07ms]
(pass) meal event domain contracts > provider namespaces are exactly nutrition-local, own, myfitnesspal [0.02ms]
(pass) meal event domain contracts > provider statuses distinguish failed/unavailable from numeric results [0.02ms]
(pass) meal event domain contracts > journal authorization and state transitions are explicit [0.03ms]
(pass) meal event domain contracts > correction fingerprint is distinct from the initial create fingerprint [0.15ms]
(pass) meal event domain contracts > validation rejects an empty item list and duplicate ordinals [0.04ms]
(pass) meal event domain contracts > public event validation never throws for throwing array Proxy traps [0.32ms]
(pass) public event validation fails closed for throwing and revoked top-level Proxies [0.10ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > create: persists event with two positions, evidence and media metadata in one transaction [90.41ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > create: omitted consumed_at is stored equal to reported_at [69.70ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > create: same idempotency-key retry returns the original and creates no duplicates [75.78ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > analyze-first then explicit add retry authorizes root and creates one journal [72.92ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > concurrent explicit add retries after analyze create one journal [77.29ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > create: concurrent same-key creates yield one aggregate [69.16ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > create: injected DB failure rolls back root, version, items, inputs, results and journal together [79.09ms]
(pass) meal event repository (requires DATABASE_URL_TEST) > create: a failed provider is stored as a failed result; the raw event stays committed [63.20ms]
(pass) meal event corrections (requires DATABASE_URL_TEST) > correction: creates version 2 and advances current_version atomically [95.01ms]
(pass) meal event corrections (requires DATABASE_URL_TEST) > correction: version 1 rows and raw inputs remain unchanged [80.33ms]
(pass) meal event corrections (requires DATABASE_URL_TEST) > correction: reads default to current version; history returns both [68.99ms]
(pass) meal event corrections (requires DATABASE_URL_TEST) > correction: repeated correction fingerprint returns version 2, never version 3 [66.82ms]
(pass) meal event corrections (requires DATABASE_URL_TEST) > correction: a failed correction leaves version 1 current with no partial version 2 [67.57ms]
(pass) canonical persistence (requires DATABASE_URL_TEST) > two agree plus one outlier: canonical averages the pair and records the outlier [85.88ms]
(pass) canonical persistence (requires DATABASE_URL_TEST) > no agreeing pair: canonical persists no_consensus with the mean of all eligible [113.47ms]
(pass) canonical persistence (requires DATABASE_URL_TEST) > one usable provider: low_confidence, value as-is, missing nutrients stay NULL [65.63ms]
(pass) canonical persistence (requires DATABASE_URL_TEST) > item scope: per-item provider results persist a per-item canonical row [64.66ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: authorized add intent inserts one pending row before any external call [83.79ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: absent authorization creates no external-write journal row [77.05ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: replayed create with the same key never duplicates the journal row [62.14ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: injected external failure marks the row failed and keeps local state intact [68.22ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: retry increments attempts without a duplicate row [80.04ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: illegal transitions are rejected; success records external id [66.90ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: delivery drives the injectable writer and records success [63.35ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: a throwing writer leaves the row failed and local state intact [69.51ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: retry after failure re-invokes the writer without a duplicate row [78.29ms]
(pass) sync journal and add authorization (requires DATABASE_URL_TEST) > journal: delivering a succeeded entry is rejected, never re-sent [64.99ms]

 41 pass
 0 fail
 220 expect() calls
Ran 41 tests across 1 file. [2.06s]
=== src/calculation-bundles.integration.test.ts ===
bun test v1.3.14 (d1632b29)


src/calculation-bundles.integration.test.ts:
(pass) calculation bundle PostgreSQL integration > persists every provider field and recomputes canonical values [98.51ms]
(pass) calculation bundle PostgreSQL integration > same event, version, and fingerprint is idempotent [58.24ms]
(pass) calculation bundle PostgreSQL integration > rejects tampered or conflicting content without mutation [64.32ms]
(pass) calculation bundle PostgreSQL integration > rolls back all rows when transaction hook fails after persistence [63.27ms]
(pass) calculation bundle PostgreSQL integration > persists an immutable correction with audit and journal provenance [71.97ms]
(pass) calculation bundle PostgreSQL integration > rejects same-key retries whose correction identity is altered [82.94ms]
(pass) calculation bundle PostgreSQL integration > keeps an exact same correction request idempotent [73.78ms]
(pass) calculation bundle PostgreSQL integration > materializes one canonical row per scope with scope-local source IDs [67.10ms]
(pass) calculation bundle PostgreSQL integration > isolates extreme item-scope values from the event canonical [66.62ms]
(pass) calculation bundle PostgreSQL integration > marks item scopes without usable provider data as pending, siblings unaffected [63.44ms]
(pass) calculation bundle PostgreSQL integration > retry with the same fingerprint keeps exactly one canonical row per scope [69.66ms]
(pass) calculation bundle PostgreSQL integration > correction materializes per-scope canonicals and leaves the prior version immutable [69.96ms]
(pass) calculation bundle PostgreSQL integration > rolls back every per-scope row when the transaction hook fails [65.13ms]

 13 pass
 0 fail
 81 expect() calls
Ran 13 tests across 1 file. [995.00ms]
=== src/meal-captures.integration.test.ts ===
bun test v1.3.14 (d1632b29)


src/meal-captures.integration.test.ts:
(pass) durable meal capture lifecycle > persists across reads, idempotent messages/answers, and valid cancel/expire transitions [16.39ms]
(pass) durable meal capture lifecycle > saves media provenance and confirms exactly once under concurrency [12.34ms]
(pass) durable meal capture lifecycle > rejects draft media that does not exactly match staged capture media [3.31ms]
(pass) durable meal capture lifecycle > rolls back event aggregate when confirmation fails before capture update, then retries [11.34ms]
(pass) capture media byte lifecycle (attachCaptureMediaBytes) > happy path: stages bytes, persists row, on-disk hash matches [8.77ms]
(pass) capture media byte lifecycle (attachCaptureMediaBytes) > rollback: injected INSERT failure removes both DB row and staged file [5.85ms]
(pass) capture media byte lifecycle (attachCaptureMediaBytes) > retry-safe: identical bytes attached twice yield one row and one file [6.51ms]
(pass) capture media byte lifecycle (attachCaptureMediaBytes) > tampered caller sha256 is rejected; nothing staged or persisted [2.78ms]
(pass) capture media byte lifecycle (attachCaptureMediaBytes) > state guard: attach on a cancelled capture stages nothing [2.57ms]
(pass) capture media byte lifecycle (attachCaptureMediaBytes) > cross-user attach is rejected as not found; nothing staged [1.23ms]
(pass) capture media durability under rejected and duplicate retries (S5 F1) > wrong-user retry of committed bytes preserves the original row and file [9.11ms]
(pass) capture media durability under rejected and duplicate retries (S5 F1) > same-owner retry after cancel preserves the original row and file [7.82ms]
(pass) capture media durability under rejected and duplicate retries (S5 F1) > same-owner retry after confirmation preserves the original row, file, and event reference [12.41ms]
(pass) capture media durability under rejected and duplicate retries (S5 F1) > injected transactional failure on a duplicate attempt preserves the original row and file [9.82ms]
(pass) capture media durability under rejected and duplicate retries (S5 F1) > coordinated concurrent duplicate success and rejected/failing attempts preserve the original row and file [8.83ms]
(pass) capture media durability under rejected and duplicate retries (S5 F1) > dedup retry heals a missing committed file with identical bytes [6.83ms]
(pass) capture media commit-outcome reconciliation (S5 remediation 2) > real COMMIT succeeds then acknowledgement is lost: attach rejects but row and file survive, retry returns the original identity [11.80ms]
(pass) capture media commit-outcome reconciliation (S5 remediation 2) > real COMMIT succeeds then acknowledgement is lost AND reconciliation is unavailable: possible orphan is retained, never deleted [9.49ms]
(pass) capture media commit-outcome reconciliation (S5 remediation 2) > COMMIT rejected before being sent: reconciliation proves no row and removes the staged file [8.39ms]
(pass) capture media commit-outcome reconciliation (S5 remediation 2) > non-cooperating conflicting row with a different key: conflict row and file survive, redundant staged key is removed [6.46ms]

 20 pass
 0 fail
 129 expect() calls
Ran 20 tests across 1 file. [551.00ms]
=== src/mcp-food-tracking.test.ts ===
bun test v1.3.14 (d1632b29)
[analytics] log_meal_event success 19ms user=u1
[analytics] log_meal_event success 10ms user=u1
[analytics] log_meal_event success 10ms user=u1
[analytics] log_meal_event success 5ms user=u1


src/mcp-food-tracking.test.ts:
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > accepts a multi-item event and returns the full structured payload [151.24ms]
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > explicit add authorization returns pending, never synced [88.50ms]
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > duplicate retry returns the original event and never duplicates the journal [102.19ms]
[analytics] log_meal_event error=rate_limited 3ms user=u1
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > rejects safe but unrelated media storage keys [87.46ms]
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > validation rejects malformed input before any write [74.77ms]
(pass) calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST) > commits an event+item bundle and reads item canonicals back through public provenance [123.01ms]
(pass) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations [98.31ms]
(pass) meal capture MCP lifecycle tools > discovers and calls get/cancel/expire with user scoping and states [210.97ms]
(pass) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations without persisting rows [94.28ms]
(pass) attach_meal_capture_media MCP tool > start -> attach -> draft referencing media -> confirm persists event media [92.57ms]
(pass) attach_meal_capture_media MCP tool > retry through MCP returns the same media identity without duplicating row or file [91.99ms]
(pass) attach_meal_capture_media MCP tool > rejects cross-user capture media attach [75.40ms]
(pass) attach_meal_capture_media MCP tool > malformed input matrix: invalid base64, disallowed MIME, kind mismatch, oversized [175.51ms]
(pass) attach_meal_capture_media MCP tool > attach on a confirmed capture is rejected and stages nothing [80.31ms]
(pass) confirm_meal_capture exported output schema (S6) > parses a valid confirm payload through the exact export [0.44ms]
(pass) confirm_meal_capture exported output schema (S6) > rejects extra keys under its own .strict() boundary [0.13ms]
(pass) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > inventory: all nine capture lifecycle tools advertise a declared outputSchema [147.89ms]
(pass) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > start -> append -> answer -> draft -> get -> cancel returns schema-exact structuredContent [77.66ms]
(pass) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > expire_meal_capture returns schema-exact structuredContent for overdue captures [75.83ms]
(pass) capture lifecycle structured output contracts (S6, requires DATABASE_URL_TEST) > confirm and attach parse through their exact exported contracts [71.13ms]

 20 pass
 0 fail
 212 expect() calls
Ran 20 tests across 1 file. [2.06s]
=== src/backup-policy.test.ts ===
bun test v1.3.14 (d1632b29)


src/backup-policy.test.ts:
(pass) backup retention policy > policy returns independent DB and media targets [0.08ms]
(pass) backup retention policy > daily retention is exactly 30 days [0.05ms]
(pass) backup retention policy > monthly retention is forever (no expiry) [0.01ms]
(pass) permanent delete orchestration > permanent delete refuses without explicit confirmation [0.41ms]
(pass) permanent delete orchestration > permanent delete removes live data and calls both backup adapters [0.20ms]
(pass) permanent delete orchestration > an unconfirmed backup adapter yields a partial receipt, never claimed success [0.14ms]
(pass) ordinary delete tombstone (requires DATABASE_URL_TEST) > tombstone keeps versions, media metadata and backup manifests untouched [100.90ms]

 7 pass
 0 fail
 27 expect() calls
Ran 7 tests across 1 file. [168.00ms]
=== src/legacy-meal-tools.integration.test.ts ===
bun test v1.3.14 (d1632b29)
[analytics] log_meal success 21ms user=u1
[analytics] get_meals_by_date success 3ms user=u1
[analytics] get_meals_today success 3ms user=u1
[analytics] get_meals_by_date_range success 2ms user=u1
[analytics] get_nutrition_summary success 7ms user=u1
[analytics] get_goal_progress success 6ms user=u1
[analytics] get_trends success 5ms user=u1
[analytics] get_meal_patterns success 3ms user=u1
[analytics] search_meals success 2ms user=u1
[analytics] bulk_import_meals success 7ms user=u1
[analytics] update_meal success 9ms user=u1
[analytics] update_meal success 4ms user=u1
[analytics] delete_meal success 0ms user=u1
[analytics] export_meals success 1ms user=u1
[analytics] log_meal success 6ms user=u1
[analytics] log_meal success 5ms user=u2
[analytics] get_meals_by_date success 5ms user=u1
[analytics] get_nutrition_summary success 3ms user=u1
[analytics] search_meals success 2ms user=u1
[analytics] export_meals success 2ms user=u1
[analytics] get_meals_by_date success 1ms user=u2
[analytics] search_meals success 1ms user=u2
[analytics] export_meals success 1ms user=u2
[analytics] delete_meal success 0ms user=u2
[analytics] bulk_import_meals success 12ms user=u1
[analytics] bulk_import_meals success 6ms user=u1
[analytics] get_meals_by_date success 3ms user=u1
[analytics] get_nutrition_summary success 4ms user=u1
[analytics] get_goal_progress success 5ms user=u1
[analytics] get_trends success 5ms user=u1
[analytics] export_meals success 4ms user=u1
[analytics] get_nutrition_summary success 5ms user=u1
[analytics] get_goal_progress success 4ms user=u1
[analytics] get_goal_progress success 3ms user=u1
[analytics] get_trends success 4ms user=u1
[analytics] export_meals success 2ms user=u1
[analytics] get_nutrition_summary success 5ms user=u1
[analytics] get_goal_progress success 9ms user=u1
[analytics] get_trends success 3ms user=u1
[analytics] get_nutrition_summary success 2ms user=u1
[analytics] export_meals success 1ms user=u1
[analytics] get_meals_by_date success 3ms user=u1
[analytics] get_meals_by_date success 2ms user=u1
[analytics] get_nutrition_summary success 4ms user=u1
[analytics] log_meal success 10ms user=u1
[analytics] update_meal success 13ms user=u1
[analytics] export_meals success 2ms user=u1
[analytics] delete_meal success 0ms user=u1
[analytics] export_meals success 1ms user=u1
[analytics] log_meal success 11ms user=u1
[analytics] log_meal success 5ms user=u1
[analytics] log_meal success 10ms user=u1
[analytics] update_meal success 7ms user=u1
[analytics] update_meal success 7ms user=u1
[analytics] log_meal success 15ms user=u1
[analytics] log_meal success 4ms user=u1
[analytics] bulk_import_meals success 2ms user=u1
[analytics] bulk_import_meals success 9ms user=u1
[analytics] bulk_import_meals success 6ms user=u1
[analytics] bulk_import_meals success 6ms user=u1
[analytics] log_water success 2ms user=u1
[analytics] log_water success 1ms user=u1
[analytics] get_water_by_date success 1ms user=u1
[analytics] get_water_by_date success 1ms user=u1
[analytics] delete_water success 0ms user=u1
[analytics] delete_water success 0ms user=u1
[analytics] log_weight success 2ms user=u1
[analytics] log_weight success 1ms user=u1
[analytics] log_weight success 1ms user=u1
[analytics] get_weight_by_date success 1ms user=u1
[analytics] get_weight_by_date success 1ms user=u1
[analytics] get_weight_by_date_range success 1ms user=u1
[analytics] get_weight_by_date_range success 1ms user=u1
[analytics] log_weight success 1ms user=u1
[analytics] get_weight_today success 2ms user=u1
[analytics] update_weight success 1ms user=u1
[analytics] delete_weight success 0ms user=u1
[analytics] delete_weight success 0ms user=u1
[analytics] log_weight success 3ms user=u1
[analytics] get_weight_trends success 4ms user=u1
[analytics] set_widget_display success 1ms user=u1
[analytics] get_widget_display success 1ms user=u1
[analytics] set_widget_display success 1ms user=u1
[analytics] start_meal_import success 3ms user=u1


src/legacy-meal-tools.integration.test.ts:
(pass) legacy meal MCP tools use the event projection > log and all eight legacy reads work through the real MCP transport [175.66ms]
(pass) legacy meal MCP tools use the event projection > bulk import, update, delete and export use current append-only projections [86.24ms]
[analytics] update_meal error=unknown 1ms user=u2
(pass) legacy meal MCP tools use the event projection > correction and cleanup are user scoped and preserve another user's rows [83.10ms]
[analytics] update_meal error=unknown 0ms user=u2
(pass) legacy meal MCP tools use the event projection > projection reads only current event scope, excludes deleted rows, preserves nulls, and respects timezone boundaries [100.10ms]
[analytics] bulk_import_meals reported-failure=import_failed 1ms user=u1
(pass) legacy meal MCP tools use the event projection > bulk import covers multi-row control totals and duplicate retry idempotency [94.40ms]
(pass) legacy meal MCP tools use the event projection > pending event-scope nutrition retains nulls end to end and never fabricates zeros [108.25ms]
(pass) legacy meal MCP tools use the event projection > mixed and explicit-zero days keep partial sums and real zeros distinct [105.87ms]
(pass) legacy meal MCP tools use the event projection > distinct per-nutrient presence, unlogged days and empty ranges disclose per-macro coverage [99.83ms]
(pass) legacy meal MCP tools use the event projection > timezone local midnight assigns events to the correct local day on both sides [85.91ms]
(pass) legacy meal MCP tools use the event projection > export carries the active correction before deletion excludes the event [97.04ms]
(pass) legacy meal MCP tools use the event projection > public calculation MCP round-trips strict provenance and authorization [142.75ms]
(pass) legacy meal MCP tools use the event projection > account cleanup removes every event child and preserves unrelated user data [108.27ms]
(pass) legacy meal MCP tools use the event projection > log_meal discloses compatibility provenance, honestly on idempotent retry [87.90ms]
(pass) legacy meal MCP tools use the event projection > update_meal discloses compatibility provenance on the new version [102.09ms]
(pass) legacy meal MCP tools use the event projection > a committed calculation bundle completes a legacy write's disclosed provenance [104.44ms]
(pass) legacy meal MCP tools use the event projection > bulk_import_meals reports per-row provenance and nulls for unwritten rows [100.23ms]
(pass) S6 sweep tools declare and return structured outputs > inventory: every sweep tool advertises a declared outputSchema [209.14ms]
(pass) S6 sweep tools declare and return structured outputs > water tools return parseable structuredContent on every success path [79.70ms]
(pass) S6 sweep tools declare and return structured outputs > weight log and date reads return parseable structuredContent [70.33ms]
(pass) S6 sweep tools declare and return structured outputs > weight today/update/delete return parseable structuredContent [61.79ms]
(pass) S6 sweep tools declare and return structured outputs > get_weight_trends returns parseable structuredContent [78.67ms]
(pass) S6 sweep tools declare and return structured outputs > widget display tools return parseable structuredContent [71.43ms]
(pass) S6 sweep tools declare and return structured outputs > start_meal_import returns parseable structuredContent [80.22ms]

 23 pass
 0 fail
 410 expect() calls
Ran 23 tests across 1 file. [2.47s]
=== src/calculation-acceptance.integration.test.ts ===
bun test v1.3.14 (d1632b29)


src/calculation-acceptance.integration.test.ts:
(pass) calculation concurrency and correction acceptance matrix > concurrent identical calculation bundles converge [14.07ms]
(pass) calculation concurrency and correction acceptance matrix > concurrent identical corrections yield one new version [12.14ms]
(pass) calculation concurrency and correction acceptance matrix > migration 005 reruns safely [11.68ms]
(pass) calculation concurrency and correction acceptance matrix > correction rollback leaves prior state intact [14.49ms]
(pass) calculation concurrency and correction acceptance matrix > stale-version correction with fresh idempotency key is rejected [12.00ms]
(pass) calculation concurrency and correction acceptance matrix > direct cross-user correction is rejected [5.46ms]
(pass) calculation concurrency and correction acceptance matrix > MCP correction round-trip [37.97ms]
(pass) calculation concurrency and correction acceptance matrix > failed provider is readable through public provenance [11.36ms]

 8 pass
 0 fail
 56 expect() calls
Ran 8 tests across 1 file. [327.00ms]
=== DB gate per-suite results ===
src/db.integration.test.ts: 8 pass, 0 fail, 0 skip, 8 ran, exit 0
src/meal-events.test.ts: 41 pass, 0 fail, 0 skip, 41 ran, exit 0
src/calculation-bundles.integration.test.ts: 13 pass, 0 fail, 0 skip, 13 ran, exit 0
src/meal-captures.integration.test.ts: 20 pass, 0 fail, 0 skip, 20 ran, exit 0
src/mcp-food-tracking.test.ts: 20 pass, 0 fail, 0 skip, 20 ran, exit 0
src/backup-policy.test.ts: 7 pass, 0 fail, 0 skip, 7 ran, exit 0
src/legacy-meal-tools.integration.test.ts: 23 pass, 0 fail, 0 skip, 23 ran, exit 0
src/calculation-acceptance.integration.test.ts: 8 pass, 0 fail, 0 skip, 8 ran, exit 0
DB gate totals: 140 pass, 0 fail, 0 skip, 140 tests across 8 DB suites.
```

stderr:

```text
$ bun run scripts/test-db-gate.ts
```

### Command 6 — repository format gate (plan line 709)

Command: `bun run format:check`

Exit status: 0

stdout:

```text
Checking formatting...
All matched files use Prettier code style!
```

stderr:

```text
$ bunx prettier --check .
```

### Command 7 — diff check (plan line 710)

Command: `git diff --check`

Exit status: 0

stdout: (empty — zero bytes)

stderr: (empty — zero bytes)

### Command 8 — MCP smoke, both URLs explicit (plan line 711)

Command:
`DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run scripts/mcp-smoke.ts`

Exit status: 0

stdout:

```text
smoke ok: png fixture decodes as 1x1
[analytics] log_meal success 23ms user=smoke-user-ry7a0mo2g
smoke ok: log_meal
[analytics] bulk_import_meals success 8ms user=smoke-user-ry7a0mo2g
smoke ok: bulk_import_meals
[analytics] update_meal success 7ms user=smoke-user-ry7a0mo2g
smoke ok: update_meal
[analytics] get_meals_today success 2ms user=smoke-user-ry7a0mo2g
smoke ok: get_meals_today
[analytics] get_meals_by_date success 1ms user=smoke-user-ry7a0mo2g
smoke ok: get_meals_by_date
[analytics] get_meals_by_date_range success 2ms user=smoke-user-ry7a0mo2g
smoke ok: get_meals_by_date_range
[analytics] search_meals success 2ms user=smoke-user-ry7a0mo2g
smoke ok: search_meals
[analytics] get_nutrition_summary success 5ms user=smoke-user-ry7a0mo2g
smoke ok: get_nutrition_summary
[analytics] get_goal_progress success 6ms user=smoke-user-ry7a0mo2g
smoke ok: get_goal_progress
[analytics] get_trends success 5ms user=smoke-user-ry7a0mo2g
smoke ok: get_trends
[analytics] get_meal_patterns success 4ms user=smoke-user-ry7a0mo2g
smoke ok: get_meal_patterns
[analytics] export_meals success 3ms user=smoke-user-ry7a0mo2g
smoke ok: export_meals
smoke ok: export csv content
[analytics] delete_meal success 1ms user=smoke-user-ry7a0mo2g
smoke ok: delete_meal
[analytics] get_meals_by_date success 1ms user=smoke-user-ry7a0mo2g
smoke ok: read excludes deleted
smoke ok: start_meal_capture
smoke ok: attach_meal_capture_media
smoke ok: attach staged bytes on disk
smoke ok: save_meal_capture_draft
smoke ok: confirm_meal_capture
smoke ok: get_meal_capture re-read
[analytics] get_meals_by_date success 3ms user=smoke-user-ry7a0mo2g
smoke ok: get_meals_by_date shows confirmed capture
smoke ok: confirmed event media persisted
MCP smoke: all steps passed — log_meal, bulk_import_meals, update_meal, get_meals_today, get_meals_by_date, get_meals_by_date_range, search_meals, get_nutrition_summary, get_goal_progress, get_trends, get_meal_patterns, export_meals, delete_meal, start_meal_capture, attach_meal_capture_media, save_meal_capture_draft, confirm_meal_capture, get_meal_capture.
```

stderr: (empty — zero bytes)

### Command 9 — final tree status (supplementary; see harness note)

Command: `git status --porcelain`

Exit status: 0

stdout:

```text
?? 00-head.code
?? 00-head.err
?? 00-head.out
?? 00-origin-main.code
?? 00-origin-main.err
?? 00-origin-main.out
?? 00-status-pre.code
?? 00-status-pre.err
?? 00-status-pre.out
?? 02-bun-install.code
?? 02-bun-install.err
?? 02-bun-install.out
?? 02b-status-post-install.code
?? 02b-status-post-install.err
?? 02b-status-post-install.out
?? 03-typecheck.code
?? 03-typecheck.err
?? 03-typecheck.out
?? 04-test-unit.code
?? 04-test-unit.err
?? 04-test-unit.out
?? 05-test-db.code
?? 05-test-db.err
?? 05-test-db.out
?? 06-format-check.code
?? 06-format-check.err
?? 06-format-check.out
?? 07-git-diff-check.code
?? 07-git-diff-check.err
?? 07-git-diff-check.out
?? 08-mcp-smoke.code
?? 08-mcp-smoke.err
?? 08-mcp-smoke.out
?? 09-status-final.err
?? 09-status-final.out
```

stderr: (empty — zero bytes)

### Command 10 — out-of-tree clean-tree verification (supplementary)

Command: `git -C <clone> status --porcelain` (captures moved outside the clone)

Exit status: 0

stdout: (empty — zero bytes)

stderr: (empty — zero bytes)

### Command 11 — `bun install` re-run for the out-of-tree cleanliness proof (supplementary)

Command: `bun install`

Exit status: 0

stdout:

```text
bun install v1.3.14 (d1632b29)

Checked 113 installs across 114 packages (no changes) [21.00ms]
```

stderr: (empty — zero bytes)

### Command 12 — post-install out-of-tree clean-tree verification (supplementary)

Command: `git -C <clone> status --porcelain`

Exit status: 0

stdout: (empty — zero bytes)

stderr: (empty — zero bytes)

## 2. Final gate counts vs Appendix A baselines

| Gate                   | S0 baseline (Appendix A)             | S11 clean-clone result                             | Rule check                                                                                                             |
| ---------------------- | ------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`    | clean                                | clean, exit 0                                      | PASS                                                                                                                   |
| `bun run test:unit`    | 445 pass / 84 skip / 0 fail          | 498 pass / 156 skip / 0 fail (654 tests, 35 files) | PASS: fail=0; pass count above baseline; skips are DB-gated (`requires DATABASE_URL_TEST`), DB suites run by `test:db` |
| `bun run test:db`      | 82 pass / 0 skip / 0 fail / 7 suites | 140 pass / 0 skip / 0 fail / **8 suites**          | PASS: fail=0, skip=0; suites=8 since S2; counts above baseline                                                         |
| `bun run format:check` | clean (repo-wide from S10)           | clean, exit 0                                      | PASS                                                                                                                   |
| `git diff --check`     | clean                                | clean, exit 0, zero stdout                         | PASS                                                                                                                   |
| MCP smoke              | exits 0                              | 24 `smoke ok` checks, exit 0                       | PASS                                                                                                                   |

DB gate per-suite results (from the verbatim output above):
`src/db.integration.test.ts` 8/0/0; `src/meal-events.test.ts` 41/0/0;
`src/calculation-bundles.integration.test.ts` 13/0/0;
`src/meal-captures.integration.test.ts` 20/0/0;
`src/mcp-food-tracking.test.ts` 20/0/0; `src/backup-policy.test.ts` 7/0/0;
`src/legacy-meal-tools.integration.test.ts` 23/0/0;
`src/calculation-acceptance.integration.test.ts` 8/0/0 — totals
`140 pass, 0 fail, 0 skip, 140 tests across 8 DB suites`.

## 3. Per-slice record S0-S11 (commits and immutable review chain)

Campaign evidence range: first campaign commit
`36dd86f3b1e6df658876efd6eb94b8ebe20d8264` through the S11 closeout commit
`docs: close out gap-remediation campaign` (the commit that adds this file and
the INDEX update; its SHA is recorded by the pending S11 reviewer-terra
review). Pre-campaign HEAD at audit time was `fdfa2e6`. All review paths are
under `.hermes/plans/` and are immutable: a FAIL document stays FAIL forever
and is superseded only by the explicit later PASS listed beside it.

### S0 — closeout of the dirty provenance working tree

- Implementation commits:
    - `36dd86f3b1e6df658876efd6eb94b8ebe20d8264` style: apply prettier to rate-limit and foods
    - `b102c68228e393955c932bd47432517701a24751` test: reset schema per DB suite and complete migration chains
    - `0d53c2b81332f86fcb9e1cd83854f275a2ad9929` fix: preserve null averages in trends widget
    - `b5e369fafe8c29c011a201ddf32b27b84899a47b` feat: expose calculation provenance readback and public corrections
    - `249698a889a4864ab13451bc1a1cc9413de8e610` docs: archive food-tracking campaign plans and audit
- Acceptance commit: `be94d985ec587f08a69809a2fd2c7dc039da7317` docs: record S0 closeout acceptance
- Terra reviews: `2026-08-05-gap-remediation-s0-terra-review.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s0-terra-review.md`

### S1 — per-scope calculation bundle and correction materialization

- Implementation commits:
    - `afad258052976376fa86877a56a7634f602eddcd` fix: materialize calculation canonicals per scope
    - `dbff058d99e6e17d0d2fd23844f6b645b46d7a34` docs: describe per-scope canonical readback
    - `90088b0ba1e8e277a7750252bcb79ecef1e04a03` test: isolate per-scope MCP acceptance suite
    - `c851e453c376dd7790e77862f1b59af807d31c72` docs: record S1 review and TDD handoff
- Acceptance commit: `9868a96b80c848358557822d43ddee28a57050c4` docs: accept S1 per-scope remediation
- Terra reviews: `2026-08-05-gap-remediation-s1-terra-review.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s1-terra-review-2.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s1-terra-review-2.md`

### S2 — concurrency acceptance + correction/migration acceptance matrix

- Implementation commits:
    - `cdd5bfb2dc6282b7ff2e47fce35920719019c32a` test: add calculation concurrency and correction acceptance matrix
    - `f9d9b7f6adb3fb31127f5896c58e40f799a29c9e` docs: record S2 acceptance evidence
- Remediation commits:
    - `44921c7167c7ccfd89edee4b8b8d185dada50a64` test: extract S2 calculation acceptance fixtures
- Acceptance commit: `bf2ab1a665e08b9ba938f0189839abf7519acc3d` docs: accept S2 acceptance-matrix remediation
- Terra reviews: `2026-08-05-gap-remediation-s2-terra-review.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s2-terra-review-2.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s2-terra-review-2.md`

### S3 — NULL-vs-zero presence contract in public aggregates

- Implementation commits:
    - `aef1947949c8c38c9b51829858b7f089594b0c61` fix: preserve null core macros in public aggregates
    - `89c975894b079ef85ec0193fc421d694c4f64452` docs: document totals presence contract
    - `45be11d9ddd74639c5bf3168396ee3a694618183` docs: record S3 TDD evidence
- Remediation commits:
    - `89c999694e4db68ffcda5eedcfabd26ccd5dc776` fix: expose per-nutrient aggregate coverage
    - `0de5a729c077ca2805ff13ce7c696a91b468bc03` docs: clarify nullable aggregate coverage
    - `eb0ef55b851c054674b2202129f56bda202da8c3` docs: record S3 semantic remediation
- Acceptance commit: `ef97e1ce2e878cce4d07cb8882a2d35f108026d3` docs: accept S3 aggregate-presence remediation
- Terra reviews: `2026-08-05-gap-remediation-s3-terra-review.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s3-terra-review-2.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s3-terra-review-2.md`

### S4 — honest provenance status on legacy writes

- Implementation commits:
    - `e2c33f15392acb8e47ec64e96290941497ddf2a5` feat: disclose provenance status on legacy meal writes
    - `63a0e3ee09aa7eb84bf882922bbbb47ad015963f` docs: record S4 TDD evidence
- Acceptance commit: `65d29c023bb2b3c7349f124c859bec7768226657` docs: record S4 legacy-provenance acceptance
- Terra reviews: `2026-08-05-gap-remediation-s4-terra-review.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s4-terra-review.md`

### S5 — public capture media path with real byte lifecycle

- Implementation commits:
    - `01f8b962403c01c0eb31cd82a75d2e932b1e7bb1` feat: attach meal capture media through MCP with staged byte lifecycle
    - `badb84888bc6e46cf05f8a0ca028a473f87f628e` docs: document capture media byte lifecycle
    - `645f5778d5451462231e8c6ac23cf2645a66a0e6` docs: record S5 TDD evidence
- Remediation commits:
    - `4fd213f9ce675bb5725c02a59260d6e0e125c098` fix: preserve committed capture media during rejected retries
    - `a137af2d20f93c52ac79f24a250ef9aa5b857b7f` docs: record S5 durability remediation
    - `ed9e822d0c20004de3b6cd48a48b4292a0331f82` fix: reconcile capture media after ambiguous commits
    - `0e34bb54a68959b47831f96c7717dc3d5e252b11` docs: record S5 commit-outcome remediation
- Acceptance commit: `98fc0b892c7cdaeab969122b3cb6e77511f9f9da` docs: accept S5 capture-media commit reconciliation
- Terra reviews: `2026-08-05-gap-remediation-s5-terra-review.md` (FAIL, immutable) and `2026-08-05-gap-remediation-s5-terra-review-2.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s5-terra-review-3.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s5-terra-review-3.md`

### S6 — machine-checkable capture outputs + dedicated correction schema + test dedup

- Implementation commits:
    - `a26a058fe7e5e01de62b52f7343a49d88c3b8a40` feat: complete structured outputs for public tools
    - `2d401219e72be9e99bf415f59f1c0ce1906abc1c` docs: record S6 structured-output evidence
- Remediation commits:
    - `ba22210a185e2d8b62620939795b8cd87d9019d9` feat: declare structured outputs for capture lifecycle tools
    - `1f771d66ccbd6feecb7dc288ba2646901a76b0de` fix: give corrections a dedicated output contract and dedupe cross-user test names
    - `54c7cdae924d47c6a27e66be82f8c22ed55d04fd` docs: record S6 governing acceptance remediation
    - `41759f9909de1fe25605bcf5e27b4720166a8fed` fix: export a strict confirm capture output schema
    - `c30b9390539f8712d8454c0f45d78b9b95bf048d` docs: record S6 confirm-schema remediation
- Acceptance commit: `f1aee7de563f3800422787d97f743827349316cb` docs: accept S6 strict structured-output contracts
- Terra reviews: `2026-08-05-gap-remediation-s6-terra-review.md` (FAIL, immutable) and `2026-08-05-gap-remediation-s6-terra-review-2.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s6-terra-review-3.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s6-terra-review-3.md`

### S7 — database readiness distinct from process health

- Implementation commits:
    - `1bea699edda029bf3cce3728cf6887fbf2c39fbd` feat: add database readiness probe with redacted diagnostics
    - `2c837519db41597d26e84e585c8f20b836ee716c` docs: record S7 readiness evidence
- Remediation commits:
    - `c5926b556ff75b30e455df6e8aa02b71fc3a8d6d` docs: correct S7 timeout resource evidence
- Acceptance commit: `3972a5fc9f7a95880e997b89eac174c133ef70f8` docs: accept S7 database readiness probe
- Terra reviews: `2026-08-05-gap-remediation-s7-terra-review.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s7-terra-review-2.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s7-terra-review-2.md`

### S8 — Supabase/OAuth drift removal and repo-truth docs

- Implementation commits:
    - `07ab6b1032fc4cd9a3062576a3526fa486452ac0` chore: remove Supabase/OAuth artifacts and fix repo-truth docs
    - `c3a3e0ec5428714f9cd1a7c933378f1904382627` docs: align public auth copy with no-auth runtime
    - `4f1fc68c9f680ad53f804f3c839a9d7871f5b51a` test: compute legacy read-regression date instead of hardcoding it
    - `a5a439c29ba135adb80ac0fbbc2c0fd9d3a94159` docs: remove unproven client compatibility claims
- Remediation commits:
    - `842392c0f70c0b0c0b363246a1f3e988338e97e3` test: freeze legacy today regression clock
    - `8624cc9940b7ab81999b5e5d067e6cd6458e3e07` docs: record S8 clock-freeze remediation
- Acceptance commit: `c7b82867c71c631bc6ee9905ec9a062ad7cce2fa` docs: accept S8 repository truth cleanup
- Terra reviews: `2026-08-05-gap-remediation-s8-terra-review.md` (FAIL, immutable), `2026-08-05-gap-remediation-s8-terra-review-2.md` (FAIL, immutable), and `2026-08-05-gap-remediation-s8-terra-review-3.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s8-terra-review-4.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s8-terra-review-4.md`

### S9 — operator docs and smoke truth

- Implementation commits:
    - `6f237b6ec87ee16b0469bf814a623254bde00413` docs: document the full 001-005 migration chain
    - `df14db04ff5d6625b807f36967f5a23db08ed6c9` test: extend MCP smoke to all legacy reads and capture media
- Remediation commits:
    - `f5de3d96ed623033481b49a4fdb5b6e874920ef2` test: harden S9 MCP smoke isolation
    - `1dfe169581216873076a46aa0fcfcea7bbc24519` docs: record S9 smoke safety remediation
- Acceptance commit: `86274b93713d7a49978645d7857b77e562ddb10c` docs: accept S9 operator docs and smoke truth
- Terra reviews: `2026-08-05-gap-remediation-s9-terra-review.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s9-terra-review-2.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s9-terra-review-2.md`

### S10 — plan directory becomes a source of truth

- Implementation commits:
    - `3e2a4ee793b57374a040a798cd605a946dd089d6` docs: add plan status index
    - `2e5f63114eada267177e95bac18033ceaac01b58` style: format historical plan documents
- Remediation commits:
    - `0a1a9af3cce10edd7565f0c2d2b620ac9c09e2eb` docs: correct audit family supersession status
    - `20109471b44357442811a0c19e4bff8a32204fda` docs: record S10 index truth remediation
- Acceptance commit: `cb53f0241b4034cf8c8c5b4ae389295af3c81295` docs: accept S10 plan truth index (the S11 base)
- Terra reviews: `2026-08-05-gap-remediation-s10-terra-review.md` (FAIL, immutable) superseded by `2026-08-05-gap-remediation-s10-terra-review-2.md` (PASS)
- Final verdict: PASS at `2026-08-05-gap-remediation-s10-terra-review-2.md`

### S11 — campaign truth-sync and closeout (this slice)

- Implementation commit: `docs: close out gap-remediation campaign` — the
  single commit that adds this closeout and updates `.hermes/plans/INDEX.md`.
  Its SHA cannot be embedded in its own tree and is recorded by the S11
  reviewer-terra review.
- Terra reviews: **PENDING** at the named final review path
  `.hermes/plans/2026-08-05-gap-remediation-s11-terra-review.md`
- Final verdict: PENDING — campaign acceptance is proposed by this closeout
  and becomes final only when the S11 reviewer-terra PASS is committed.

## 4. Deviations from the campaign plan (each with its Terra reference)

1. **S5 process-wide media store location.** The plan's exact-files list named
   `src/index.ts` for "pass a process-wide media store into server
   construction". The implementation placed the process-wide store as the lazy
   singleton `getProcessMediaStore()` in `src/mcp.ts` (reached by
   `buildMcpServer` via the `registerTools` deps default), so `src/index.ts`
   needed no edit. Declared in `2026-08-05-gap-remediation-s5-kimi-handoff.md`
   (deviation note, lines 67-71). Reviewer-terra examined this shape in
   `2026-08-05-gap-remediation-s5-terra-review.md` (FAIL on other grounds; its
   evidence explicitly verified "the injected `mediaStore` dependency seam
   plus lazy process-wide default store are present"), and the slice was
   accepted with this shape in place by the final PASS
   `2026-08-05-gap-remediation-s5-terra-review-3.md`.
2. **S6 dispatch re-scope.** The S6 invocation's dispatch re-scoped the slice
   to the structured-output contract sweep of the 13 remaining named tools
   only; the plan-S6 capture-lifecycle schemas, dedicated correction schema
   (D7), and test-name dedup were not executed in that invocation. Declared in
   `2026-08-05-gap-remediation-s6-kimi-handoff.md` ("Deviations from the
   plan's S6 text", lines 147-155). Reviewer-terra REQUIRED completion of the
   full plan-S6 scope: `2026-08-05-gap-remediation-s6-terra-review.md` (FAIL)
   and `2026-08-05-gap-remediation-s6-terra-review-2.md` (FAIL). The scope was
   completed by remediation commits `ba22210`, `1f771d6`, `41759f9` (evidence
   `54c7cda`, `c30b939`), the re-scope's additive 13-tool sweep was explicitly
   retained ("Retained additive sweep — PASS"), and the slice was accepted by
   `2026-08-05-gap-remediation-s6-terra-review-3.md` (PASS).
3. **S11 reviewer-checklist grep proxy is overbroad (this slice).** Campaign
   plan line 722 checks "no silent scope creep into the domain layer" via
   `git grep -iE 'telegram|node-telegram|grammy' src/` and expects it empty.
   The exact grep is NOT empty (see section 6): its 9 matches are truthful
   negative architecture statements in comments/descriptions/tests plus one
   inert fixture label — not imports. Deleting those truthful negative
   statements would falsify the docs, so the intended Appendix B invariant
   ("Telegram/provider SDK imports in `src/` must never appear") is proven
   independently and strictly: package dependency audit (`package.json` has
   exactly 6 dependencies/devDependencies, none Telegram/provider-related;
   `bun.lock` has zero matches) plus import/require/dynamic-import scans over
   `src/` that are empty. Acceptance reference for this overbroad-proxy
   deviation: **PENDING** at the named final S11 review path
   `.hermes/plans/2026-08-05-gap-remediation-s11-terra-review.md`.

## 5. Remaining known-external items (verbatim from the audit)

The audit's out-of-repo list
(`.hermes/plans/2026-08-05-plan-vs-code-gap-audit.md`, section header at line
267, intro at line 269, items at lines 271-279) is restated verbatim so nobody
mistakes these intentional absences for regressions:

> ## Что осталось только вне этого репозитория

> Эти пункты есть в планах, но их отсутствие в `nutrition-mcp` намеренное:

> 1. Telegram text/photo/voice receipt.
> 2. Text-first parsing и one-question-at-a-time clarification.
> 3. Hermes `own` estimate.
> 4. Вызовы `nutrition-local` и MyFitnessPal MCP.
> 5. Объяснение расхождений пользователю и подтверждение `добавь`.
> 6. Реальный MyFitnessPal writer, который читает pending journal и переводит его в succeeded/failed после внешнего ответа.
> 7. STT/OCR/vision workers.
> 8. Реальный backup scheduler, cloud retention и restore drills.
> 9. Публичная operational-команда permanent delete, которая удаляет реальные backup copies после подтверждения.

The audit's separate-workflow paragraph (line 283), also verbatim:

> Их нельзя "доделать" прямыми imports или Telegram webhook внутри `nutrition-mcp`. Нужен отдельный Hermes workflow/adapter. В `nutrition-mcp` уже есть storage и journal seam, но `nullExternalWriter` намеренно падает, а UI честно пишет, что external sync еще не реализован.

These nine items remain out-of-repo follow-ups requiring a separate Hermes
workflow/adapter. Nothing in the campaign pulled them into `nutrition-mcp`;
the domain layer gained no Telegram webhook, no provider SDK imports, and no
external writer (see section 6).

## 6. Boundary audit (reviewer checklist + Appendix B invariants)

### 6.1 The exact reviewer-checklist grep is NOT empty — recorded truthfully

Command (campaign plan line 722): `git grep -iE 'telegram|node-telegram|grammy' src/`

Real, complete, untruncated output (exit status 0, 9 matches):

```text
src/food-tracking-docs.test.ts:    "no Telegram bot/webhook/polling, STT, OCR, vision",
src/food-tracking-docs.test.ts:        /this server (downloads|runs|calls) (Telegram|STT|OCR|vision|external MCP)/i,
src/food-tracking-docs.test.ts:    expect(docs).not.toContain("Telegram bot is implemented");
src/mcp-food-tracking.test.ts:// text/metadata/provider results; the tool runs NO Telegram/vision pipeline
src/mcp.ts:    // metadata and provider estimates. This tool runs NO Telegram/vision/OCR
src/mcp.ts:                "Start a durable transport-neutral meal capture. Hermes supplies messages and prepared data; this server does not parse Telegram, audio, or images.",
src/meal-captures.test.ts:                source_kind: "telegram_guess",
src/meal-events.test.ts:// no network, no Telegram/vision SDK types.
src/meal-types.ts:// Pure TypeScript: no database, no network, no Telegram/vision SDK types.
```

Every match is a negative architecture statement (a comment, a tool
description, or a test asserting the absence of Telegram/provider machinery)
except `source_kind: "telegram_guess"`, an inert fixture label in a test. None
is an import, a dependency, or Telegram/provider machinery. These truthful
negative statements are deliberately NOT deleted, and this closeout does not
claim the exact grep is empty.

### 6.2 The intended Appendix B invariant is proven independently (strict scans, all empty)

- **Package dependency audit:** `package.json` declares exactly
  `@modelcontextprotocol/sdk`, `@types/bun`, `@types/pg`, `hono`, `pg`,
  `prettier` — zero dependencies or devDependencies matching
  `telegram|grammy|telegraf|myfitnesspal`. `bun.lock` contains zero matches
  for `telegram|grammy|telegraf`.
- **Import scan:** `git grep -nE "(from +['\"]|require\(['\"]|import\(['\"])[^'\"]*(telegram|grammy|telegraf|myfitnesspal)" src/`
  — zero matches (exit status 1): no static import, no `require`, and no
  dynamic `import()` of any Telegram/provider SDK anywhere in `src/`.

This is the overbroad-proxy deviation recorded as deviation 3 in section 4;
its acceptance reference is the pending S11 reviewer-terra review at
`.hermes/plans/2026-08-05-gap-remediation-s11-terra-review.md`.

### 6.3 Appendix B forbidden-diff invariants across the whole campaign

Scans run over the full campaign diff `fdfa2e6..cb53f02` (added lines,
`git log -p`), plus the working tree at the S11 base:

| Appendix B invariant                                   | Scan                                                                                                              | Result                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `CREATE TABLE meals` / `CREATE VIEW meals`          | added-lines grep for `CREATE TABLE ... meals` / `CREATE VIEW ... meals` across `src/` and `db/`                   | NONE — invariant holds                                                                                                                                                                                                                                                             |
| No Telegram/provider SDK imports in `src/`             | added-lines grep for `(import\|require).*telegram\|grammy`; plus the section 6.2 dependency/import audits at HEAD | NONE — invariant holds                                                                                                                                                                                                                                                             |
| No `?? 0` on core-macro presence paths after S3        | added-lines grep for `?? 0` in `src/`                                                                             | One hit only: `sum = (sum ?? 0) + value;` inside `presenceSum` (S3, `aef1947`) — the presence-preserving accumulator itself; null stays null when no meal carries a value and an explicit stored 0 sums as a real zero. NOT a fabricated zero on a presence path — invariant holds |
| No caller-authoritative consensus                      | added-lines grep for `consensus` in `src/`                                                                        | All hits are server-computed `consensus_status` read/written by the repository internals and test fixtures/assertions of those computed values; no MCP/API input accepts caller-supplied consensus — invariant holds                                                               |
| No caller-supplied `storage_key` on the MCP media path | added-lines grep for `storage_key` in `src/`                                                                      | All hits are server-generated `storage_key` values returned/read back and direct SQL in tests; the MCP attach input schema exposes no `storage_key` (S5 handoff: "No `storage_key` input exists") — invariant holds                                                                |
| No `synced` written to a journal row by this repo      | added-lines grep for `'synced'` / `"synced"` in `src/`                                                            | NONE — invariant holds (`nullExternalWriter` still intentionally fails; journal seam unchanged)                                                                                                                                                                                    |
| Zero edits to `db/migrations/001..005` in place        | `git log --oneline fdfa2e6..cb53f02 -- db/migrations/`                                                            | EMPTY — zero commits touched `db/migrations/` at all during the campaign; 001-005 are bit-identical to the accepted S0 base — invariant holds                                                                                                                                      |

## 7. Final state assertions

- Clean-clone battery: all green, exit 0 for every command; verbatim evidence
  in section 1.
- DB gate: exactly 8 suites; counts above S0 baselines (section 2).
- Smoke: all 24 checks (section 1, command 8).
- Source tree at the S11 base: `main` == `origin/main` ==
  `cb53f0241b4034cf8c8c5b4ae389295af3c81295`, working tree clean before this
  commit.
- This commit adds exactly `.hermes/plans/2026-08-05-gap-remediation-closeout.md`
  and modifies exactly `.hermes/plans/INDEX.md`; both are Prettier-formatted;
  `bun run format:check` and `git diff --check` were re-run green in the
  source tree after the edits.
- Campaign acceptance is PROPOSED by this closeout and becomes final only when
  the pending S11 reviewer-terra PASS is committed at
  `.hermes/plans/2026-08-05-gap-remediation-s11-terra-review.md`.
