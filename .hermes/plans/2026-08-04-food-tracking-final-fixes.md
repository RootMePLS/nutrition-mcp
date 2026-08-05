# Final Terra remediation

Repo: /Users/fishhead/.workspace/projects/nutrition-mcp
Current HEAD: 29bb1136d7e6370061c22f378b7a4457165fc721

Fix only these reviewer findings, preserve all existing work:

1. **Idempotent retry may add explicit authorization**
    - Existing event lookup by `(user_id, idempotency_key)` must not silently ignore a later explicit `external_write_authorized=true`.
    - In one transaction, when the existing event is returned and the retry carries explicit add authorization, update the root authorization state if needed and insert exactly one pending MFP journal row for the current event/version if absent.
    - Do not duplicate journal rows; no journal on non-authorized calls.
    - Add RED tests first, then implementation. Test analyze-first then add-retry, duplicate add-retry, and concurrent add retries.

2. **Media storage-key provenance**
    - Do not allow `log_meal_event` to attach an arbitrary safe relative `storage_key` merely because it passes path containment.
    - Enforce that attached media metadata is tied to the event/version and expected content identity. Prefer requiring media metadata produced by the media-store contract, or validate generated key shape plus event/version/hash mapping. Do not accept caller-controlled unrelated keys.
    - Add RED tests for a safe-but-unrelated key and a valid generated key.

3. **Documentation truth pass**
    - Update the smallest appropriate operator-facing docs (README and/or CLAUDE/operator section, plus .env.example if needed) to document:
        - new append-only meal_events model;
        - destructive legacy meal reset semantics for 002;
        - DATABASE_URL_TEST and MEDIA_ROOT test/runtime configuration;
        - media on disk + metadata in Postgres;
        - MFP real sync and automatic backup scheduler/cloud are intentionally not shipped in this slice.
    - Do not reformat unrelated pre-existing files or plan artifacts.

Verification:

- DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun test
- bun run typecheck
- feature-file format check; full format may still report known pre-existing files
- git diff --check
- inspect git diff and commit focused remediation.
  Report commit SHA and exact results. Do not modify plan files. No real external MFP calls.
