# A1 array-proxy remediation

Current commit: fc5596f1022165744d709cbf47d4bec70f20d18b
Terra finding: `isArray()` catches revoked proxies, but `validatePreparedDraft()` still performs `.length`, `.map()`, `.some()` on a non-revoked Proxy wrapping an array; traps can throw.

Fix only A1:

- Add RED regression tests for Proxy-wrapped arrays whose length/map/some/every/get traps throw, in draft items/inputs/media and message/media paths where applicable.
- Ensure every public validator catches operations on array-like Proxy values and returns stable validation errors, never throws.
- Prefer safely snapshotting/iterating only inside try/catch helpers, or wrap the complete validator body at the runtime boundary while preserving useful errors.
- Preserve valid arrays, aliases, cycles, metadata/hash/MIME/ID/evidence behavior.
- Run focused/full tests, typecheck, changed-file Prettier and diff check. Commit one focused fix. Do not touch A2+ or plan artifacts.
