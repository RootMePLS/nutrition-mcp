# A1 Terra remediation

Repo: /Users/fishhead/.workspace/projects/nutrition-mcp
Rejected commit: 8cbc6cc673b88e7edeea87b99541ddca9ad5e903

Fix only A1 validator findings:

1. Make all runtime validators fail closed with stable validation errors, never TypeError:
    - `{}`;
    - `items: null` / non-array;
    - item fields missing/non-string;
    - inputs/media null/non-array;
    - malformed nested values.
2. JSON metadata validator must reject functions, symbols, bigint, undefined and non-JSON nested values; accept only JSON-compatible values.
3. Validate every supplied identity field, including capture/draft/evidence/media IDs and provenance binding fields where the contract exposes them. Keep validation transport-neutral.
4. Tighten MIME validation to well-formed `type/subtype`, and enforce media-kind compatibility.
5. Add RED regression tests for every finding, then minimal GREEN implementation.
6. Run focused/full tests, typecheck, changed-file Prettier, diff check. Commit one focused remediation. Do not modify plan artifacts or touch A2+.
