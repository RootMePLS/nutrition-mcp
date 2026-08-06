# S10 handoff — Plan directory becomes a source of truth

Slice: S10 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md`
(governing acceptance: lines 639-669).
Base: accepted S9 commit `86274b93713d7a49978645d7857b77e562ddb10c`, clean tree.
Scope: documentation only. No production, test, migration, schema, provider,
version, or S11 files touched.

## RED — `bun run format:check` before the slice (exact fresh inventory, 28 files)

The orchestrator observation of 28 historical markdown failures matched fresh
output exactly. Failing files:

1. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-brief.md`
2. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-plan.md`
3. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review.md`
4. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-2.md`
5. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-5.md`
6. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-6.md`
7. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-7.md`
8. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-8.md`
9. `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-9.md`
10. `.hermes/plans/2026-08-05-gap-remediation-campaign-brief.md`
11. `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md`
12. `.hermes/plans/2026-08-05-gap-remediation-s2-terra-review-2.md`
13. `.hermes/plans/2026-08-05-gap-remediation-s3-terra-review.md`
14. `.hermes/plans/2026-08-05-gap-remediation-s4-terra-review.md`
15. `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review.md`
16. `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review-2.md`
17. `.hermes/plans/2026-08-05-gap-remediation-s7-terra-review.md`
18. `.hermes/plans/2026-08-05-gap-remediation-s7-terra-review-2.md`
19. `.hermes/plans/2026-08-05-gap-remediation-s8-kimi-handoff-3.md`
20. `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review.md`
21. `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review-2.md`
22. `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review-3.md`
23. `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review-4.md`
24. `.hermes/plans/2026-08-05-legacy-meal-tools-event-schema-fix-brief.md`
25. `.hermes/plans/2026-08-05-legacy-meal-tools-event-schema-fix-plan.md`
26. `.hermes/plans/2026-08-05-legacy-meal-tools-event-schema-fix-terra-fixes.md`
27. `.hermes/plans/2026-08-05-legacy-meal-tools-event-schema-fix-terra-fixes-2.md`
28. `.hermes/plans/2026-08-05-legacy-meal-tools-event-schema-fix-terra-fixes-3.md`

Exactly these 28 files were passed to `bunx prettier --write`. No other
historical file was reformatted.

## INDEX coverage mapping

`.hermes/plans/INDEX.md` was created as the durable source of truth. Temporary
coverage audit (method and results recorded in INDEX): every file from
`git ls-files '.hermes/plans/*.md'` at the S10 base was classified into exactly
one documented family or explicitly justified subfamily.

- Tracked markdown files: 85
- Families/subfamilies: 23 (10 audit-table families + 1 justified
  food-tracking auxiliary subfamily + audit family + campaign family + 10
  per-slice campaign subfamilies S0-S9; S10/S11 rows exist with zero tracked
  files)
- Covered: 85; unmatched: 0; duplicates: 0
- Excluded by design: `INDEX.md` and this handoff.

The campaign family is marked `open` through S10 and S11 so S11 can close it.
Statuses used: `superseded`, `implemented`, `accepted`, `open` only. Historical
FAIL reviews are marked superseded only where an explicit later PASS review
exists (per-slice `superseded-by` column).

## Semantic preservation evidence (all 28 formatted files)

Method: SHA-256 of each file with ALL whitespace stripped, before vs after
`bunx prettier --write`, plus a character-multiset diff (`git show HEAD:<file>`
vs worktree) and `git diff --word-diff`.

- 21 of 28 files: whitespace-stripped hash identical before/after. Pure
  whitespace/wrapping changes only.
- 7 files: hash differed; character-multiset audit explains every delta as
  Prettier markdown normalization, zero prose/word changes:
    - 4 files (`s2-terra-review-2`, `s7-terra-review`, `s7-terra-review-2`,
      `legacy-meal-tools-event-schema-fix-plan`): added `-` characters only
      (210/354/678/239) — table separator-row padding. Nested-list
      re-indentation (whitespace) accounts for the rest.
    - 3 files (`calculation-provenance-enforcement-terra-review-8`,
      `gap-remediation-s3-terra-review`, `gap-remediation-campaign-plan`):
      exactly 2 `*` characters became 2 `_` characters each — Prettier emphasis
      marker normalization (rendering-equivalent).
    - `gap-remediation-campaign-plan`: additionally ONE `,` character added —
      a trailing comma inserted by Prettier's embedded TypeScript formatter in
      the fenced `ts` code sample
      (`recomputeCalculationBundle(bundleWith(eventResults, item0Results, item1Results))`
      rewrapped with a trailing comma). This is the only non-whitespace,
      non-presentational character change in the entire slice; it is inside a
      documentation code sample, not prose, verdict, or command text.
- After normalizing table-separator rows and emphasis markers, all 28 files
  are byte-identical under whitespace-stripping except the single trailing
  comma above.

### Spot checks (`git diff --word-diff`, 3 complex files)

| File                                                                            | Non-blank word-level change lines | Content                                                              |
| ------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `2026-08-05-legacy-meal-tools-event-schema-fix-plan.md` (table-heavy plan)      | 2                                 | table separator rows only                                            |
| `2026-08-05-gap-remediation-s5-terra-review.md` (FAIL review)                   | 0                                 | whitespace/wrapping only                                             |
| `2026-08-05-calculation-provenance-enforcement-terra-review-8.md` (FAIL review) | 4                                 | `*empty*`→`_empty_`, `response*,`→`response_,` emphasis markers only |

## FAIL verdict inventory and preservation

Verdict lines were snapshotted before formatting and re-verified after: every
file that contained a FAIL verdict still contains it, unchanged (modulo
rewrapping). No verdict was edited.

FAIL verdicts in the formatted RED set (12 files): calculation-provenance
terra reviews 1, 2, 5, 6, 7, 8; campaign-plan (contains quoted FAIL text);
s2-terra-review-2 (quotes the preserved FAIL review it supersedes);
s7-terra-review; s8-terra-review; s8-terra-review-2; s8-terra-review-3.

Full campaign FAIL inventory (all preserved as FAIL, superseded only by the
listed explicit PASS): calc-prov reviews 1-8 → PASS review 9; s1 FAIL →
s1-review-2 PASS; s2 FAIL → s2-review-2 PASS; s3 FAIL → s3-review-2 PASS;
s5 FAIL + s5-review-2 FAIL → s5-review-3 PASS; s6 FAIL + s6-review-2 FAIL →
s6-review-3 PASS; s7 FAIL → s7-review-2 PASS; s8 FAIL + s8-review-2 FAIL +
s8-review-3 FAIL → s8-review-4 PASS; s9 FAIL → s9-review-2 PASS. First-pass
PASS reviews: s0, s4. This mapping is recorded in INDEX.

## GREEN — `bun run format:check` after the slice

```
$ bunx prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

Exit 0, repo-wide — first time in the repo's recent history.

## Gates (all run against the exact committed tree, both URLs

`postgres://localhost:5432/nutrition_mcp_test`)

| Gate                        | Command                                                                                       | Result                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                      | `bun run format:check`                                                                        | PASS, repo-wide                                                                                                                                                                                                                                                                  |
| Typecheck                   | `bun run typecheck`                                                                           | PASS (`src/ typechecks clean`)                                                                                                                                                                                                                                                   |
| Unit                        | `bun run test:unit`                                                                           | PASS: 498 pass, 0 fail, 156 skip, 654 tests across 35 files                                                                                                                                                                                                                      |
| DB gate (explicit 8 suites) | `DATABASE_URL=DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` | PASS: 140 pass, 0 fail, 0 skip, 140 tests across 8 DB suites (db.integration 8, meal-events 41, calculation-bundles.integration 13, meal-captures.integration 20, mcp-food-tracking 20, backup-policy 7, legacy-meal-tools.integration 23, calculation-acceptance.integration 8) |
| MCP smoke                   | same two URLs, `bun run scripts/mcp-smoke.ts`                                                 | PASS, exit 0, all 24 `smoke ok` checks including capture attach/confirm                                                                                                                                                                                                          |
| Whitespace                  | `git diff --check`                                                                            | clean                                                                                                                                                                                                                                                                            |
| File-type boundary          | `git status --porcelain` + commit `--stat`                                                    | zero non-markdown files changed                                                                                                                                                                                                                                                  |

## Commits (exact two-commit boundary)

1. `docs: add plan status index` — `.hermes/plans/INDEX.md` only
   (`3e2a4ee793b57374a040a798cd605a946dd089d6`).
2. `style: format historical plan documents` — exactly the 28 RED-listed
   historical markdown files plus this handoff. No other paths.

No README, production, test, migration, schema, provider, version, or S11
files in either commit.
