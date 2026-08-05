# B2 Terra remediation: correction retry identity

Current commit: a472d0a598d0805fa920fe95c7a2585504bf3f02

Terra B2 blocker:

`commitCalculationCorrection` returns `deduplicated: true` when `correction_idempotency_key` already exists, without comparing the retry against persisted correction identity. A retry with the same key but altered bundle fingerprint/version or correction metadata can be silently accepted.

Required:

1. Add RED PostgreSQL integration tests for same-key retries with altered bundle fingerprint/content, version, correction reason/author/source timestamp, confirmation/authorization, and user scope. They must reject tampering and leave the original correction/rows unchanged.
2. Add GREEN production comparison of persisted correction identity against retry identity. Preserve idempotent success only for an exact same request.
3. Ensure no mutation of original provider/canonical/correction rows and preserve user scoping.
4. Run focused tests, explicit DATABASE_URL_TEST integration, full suite, typecheck, changed-file formatting, diff check.
5. Commit one focused remediation. No C docs/final gate, no external provider callers, no Telegram/STT/OCR/vision.
