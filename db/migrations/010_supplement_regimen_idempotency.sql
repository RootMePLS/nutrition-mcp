-- Forward-only migration: PostgreSQL-enforced create idempotency for
-- supplement regimens (Slice 5).
--
-- Why a new migration instead of editing 006: 006-009 are shipped and may be
-- applied by existing deployments (main auto-deploys). 010 is additive and
-- forward-safe: one nullable column plus one partial unique index; nothing is
-- altered or dropped, and it is safe to rerun.
--
-- supplement_regimens has no shipped writer before Slice 5, so the column
-- addition applies cleanly to every deployment that has only run shipped code.
--
-- Run after 009: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/010_supplement_regimen_idempotency.sql

ALTER TABLE supplement_regimens
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_supplement_regimens_user_idem
    ON supplement_regimens (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
