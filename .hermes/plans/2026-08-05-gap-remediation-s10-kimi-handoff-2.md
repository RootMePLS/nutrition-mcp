# S10 remediation handoff 2 — INDEX audit-family truth fix

Remediation of the sole FAIL finding in
`.hermes/plans/2026-08-05-gap-remediation-s10-terra-review.md` (SHA-256
`b3394e1a120560a35b9a28463fbc8347a9c1c9070fa9f2d8de1d8b6fbdebedfa`, verified
byte-identical before work began; the file is preserved unchanged).

Scope: exactly one INDEX row in `.hermes/plans/INDEX.md`. No evidence text,
coverage counts, other statuses, historical documents, or verdicts were
altered. No production, test, migration, README, version, or S11 changes.

## Required fix (from the FAIL review)

`.hermes/plans/INDEX.md` audit-family row: status `accepted` -> `superseded`,
and the generic `Gap-remediation campaign family` superseding value replaced
with the explicit later document `2026-08-05-gap-remediation-campaign-plan.md`.

Reason (per the review): the INDEX status definition permits `accepted` only
with a reviewer-terra PASS artifact; none exists for
`2026-08-05-plan-vs-code-gap-audit.md`. The row itself records that the
campaign replaced the audit (archive commit `249698a`), which is
`superseded`, and S10 requires an explicit document pointer, not a family
label.

## Before / after (the only changed line)

Before:

```
| `2026-08-05-plan-vs-code-gap-audit.md` (audit family) | 1 | accepted | Gap-remediation campaign family | Governing audit for the campaign; ... |
```

After:

```
| `2026-08-05-plan-vs-code-gap-audit.md` (audit family) | 1 | superseded | `2026-08-05-gap-remediation-campaign-plan.md` | Governing audit for the campaign; ... |
```

`git diff` confirms exactly 1 insertion / 1 deletion in
`.hermes/plans/INDEX.md` (table padding re-normalized by Prettier; the
superseded-by column width is still governed by the longer
calculation-provenance review-9 pointer, so no other row changed).

## Pointer proof

`.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` exists (tracked
file, present at S10 base `86274b9` and at HEAD). The generic label
`Gap-remediation campaign family` no longer appears anywhere in INDEX.md.

## Coverage recheck (independent, against the 85-file S10 base)

Re-enumerated `git ls-tree -r 86274b9 --name-only .hermes/plans` (85 tracked
`*.md` files) and classified each into exactly one of the 23 INDEX
families/subfamilies with fresh pattern matching:

- Tracked markdown files at base: 85
- Covered: 85; unmatched: 0; duplicates: 0
- Row counts in INDEX order: `2,4,4,1,6,2,5,1,1,5,11,1,2,1,3,3,4,2,6,6,3,8,4`
  — identical to the INDEX coverage audit.
- Status-token validation: only `superseded`, `implemented`, `accepted`,
  `open` occur in INDEX data rows.
- Exclusions by design unchanged: `INDEX.md`, the S10 handoff, plus this
  remediation's artifacts (FAIL review, handoff-2) are S10-created and not
  among the 85 base files.

## Gates (both URLs `postgres://localhost:5432/nutrition_mcp_test` where DB access was required)

| Gate                        | Command                                   | Result                                                                                                                           |
| --------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Format                      | `bun run format:check`                    | PASS, repo-wide (`All matched files use Prettier code style!`)                                                                   |
| Typecheck                   | `bun run typecheck`                       | PASS: `src/ typechecks clean`                                                                                                    |
| Unit                        | `bun run test:unit`                       | PASS: 498 pass, 0 fail, 156 skip, 654 tests across 35 files                                                                      |
| DB gate (explicit 8 suites) | both URLs, `bun run test:db`              | PASS: 140 pass, 0 fail, 0 skip, 140 tests — 8/41/13/20/20/7/23/8 per suite                                                       |
| MCP smoke                   | both URLs, `bun run scripts/mcp-smoke.ts` | PASS, exit 0, all 24 `smoke ok` checks including capture attach/confirm                                                          |
| Whitespace                  | `git diff --check`                        | clean                                                                                                                            |
| File-type boundary          | `git status --porcelain`                  | only `.hermes/plans/INDEX.md` modified plus the two new S10 remediation artifacts (FAIL review, this handoff); zero non-markdown |

## Commits

1. `docs: correct audit family supersession status` — `.hermes/plans/INDEX.md`
   only.
2. `docs: record S10 index truth remediation` — the immutable FAIL review
   `2026-08-05-gap-remediation-s10-terra-review.md` and this handoff-2.

The FAIL review remains FAIL forever; this remediation fixes the INDEX, not
the review. S10 re-review and campaign closure remain for S11; nothing in S11
was started.
