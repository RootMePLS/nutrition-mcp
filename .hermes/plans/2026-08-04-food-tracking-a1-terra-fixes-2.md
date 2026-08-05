# A1 second Terra remediation

Current commit: b1e874bd62b113b66e725f7c334a307c1211ba7f
Terra found remaining fail-closed violations. Fix only A1.

## Required regression matrix

Every public validator must return stable validation errors and never throw for these values:

- `validateCaptureMedia(null)`;
- `validateCaptureMedia({})`, `content_hash: null`, `metadata: null`;
- `validatePreparedDraft(null)`;
- draft with `items: null`, `inputs: null`, `media: null`;
- draft with `items: [null]`, `inputs: [null]`, `media: [null]`;
- message null and nested null metadata;
- malformed arrays/objects and invalid primitive fields.

Add tests first that assert `doesNotThrow` and non-empty validation errors for every probe. Keep valid inputs green.

## Implementation

- Add object/null guards before every property access.
- Validators accept `unknown` at the runtime boundary, or safely narrow unknown before accessing fields.
- Ensure nested validators are called only after object guards.
- Keep JSON metadata/function/symbol/bigint/cycle rejection, strict MIME/media compatibility, ID/hash/date checks, and evidence precedence behavior.
- No A2+ changes, no migration, no lifecycle, no MCP expansion.

Run focused A1 tests, full suite, typecheck, changed-file Prettier, diff check. Commit one focused fix and report exact SHA/results. Do not modify plan artifacts.
