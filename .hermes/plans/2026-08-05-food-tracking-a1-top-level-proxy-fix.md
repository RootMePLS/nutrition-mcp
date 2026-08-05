# A1 top-level proxy remediation

Current commit: 4221b5b28c9e2462db662465b358f1c0a3fed342
Terra finding: public validators still directly read fields from top-level object-like Proxies outside catch. Throwing/revoked Proxy causes:

- validateCaptureMessage
- validateCaptureMedia
- validatePreparedDraft
- validateCreateMealEventCommand

to throw. A1 requires fail-closed validators.

Fix only A1:

1. Add RED tests for each public validator with a top-level Proxy whose get/has/ownKeys/getPrototypeOf trap throws, plus revoked Proxy. Assert no throw and stable non-empty errors.
2. Add a safe record/property-access boundary. Either wrap complete validator bodies in try/catch returning a stable validation error, or snapshot fields through safe helpers before use. Do not weaken valid input behavior.
3. Ensure nested array snapshots and metadata safety remain intact.
4. Keep event/capture validation error semantics useful and deterministic.
5. Run focused/full tests, typecheck, changed-file Prettier and diff check. Commit one focused fix. Do not touch A2+ or plan artifacts.
