# A1 aliasing remediation

Current commit: 0b2a1b8f3651cd5b245bb388f98b555c3272fa4e
Terra final A1 finding: `isJsonMetadata` uses one global seen set and rejects valid JSON-compatible aliasing such as `{a: shared, b: shared}`. It must reject cycles but accept repeated references in separate branches.

Implement only this A1 fix:

- Use recursion-path tracking: add object before descending, remove it in `finally` after descending; a repeated object in a completed sibling branch is valid, an object encountered while already on the current path is a cycle.
- Preserve rejection of undefined/functions/symbols/bigint/non-finite numbers/cycles.
- Add RED regression tests for valid shared aliasing and retain cycle rejection.
- Run focused tests, full suite, typecheck, changed-file Prettier, diff check.
- Commit one focused fix. Do not modify plan artifacts or touch A2+.
