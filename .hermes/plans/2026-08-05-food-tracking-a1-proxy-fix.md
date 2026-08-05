# A1 proxy-safety remediation

Current HEAD: b583c0691eac994e727b202f42fd90c21bb6bd07
Terra found A1 fail-closed gap: `isJsonMetadata` can throw on adversarial object-like values, including Proxy ownKeys/getter traps and revoked Proxy passed to Array.isArray. A1 requires validators never throw on malformed runtime inputs.

Fix only A1:

- Add regression tests using throwing Proxy traps and revoked Proxy for message metadata and any public validator path.
- Ensure metadata validation catches reflective-operation exceptions and returns false, never throws. Keep recursion-path cleanup in finally.
- Preserve valid shared aliasing acceptance and true cycle rejection.
- If Array.isArray itself can throw, guard it within the safe validator boundary.
- Do not broaden types or change A2+ behavior.
- Run focused/full tests, typecheck, changed-file Prettier, diff check. Commit one focused fix and report SHA/results. Do not modify plan artifacts.
