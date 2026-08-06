-- Forward-only migration: deterministic, non-destructive reconciliation of
-- pre-008 first-time create race duplicates, with an append-only audit trail.
--
-- Why a new migration instead of editing 008: 008 is committed and pushed to
-- main, and main auto-deploys (DigitalOcean), so 008 must be treated as
-- already applied somewhere. Editing it in place would diverge the applied
-- migration from the shipped file for those deployments. 009 is additive and
-- forward-safe: it drops nothing, deletes no rows, alters no existing
-- constraint, and is fully idempotent.
--
-- The failure this fixes (reviewer-terra slice 2): before 008's partial
-- unique index existed, two concurrent same-user/same-key first-time creates
-- could both commit a root + version-1 row. A database at 001-007 carrying
-- such duplicates CANNOT apply 008: CREATE UNIQUE INDEX fails with 23505 and
-- the upgrade halts. Because 008 is immutable, the reconciliation lives here
-- and 009 creates the index itself (IF NOT EXISTS, definition identical to
-- 008) so the chain converges from every real starting state:
--   * clean deployments (008 already applied): the duplicate scan matches
--     nothing, the audit table is created, and the index creation is a no-op;
--   * duplicate-bearing deployments stuck at 008's failure: apply 009 — it
--     reconciles the duplicates and creates the index — then re-apply 008,
--     which now succeeds as a no-op via IF NOT EXISTS.
--
-- Reconciliation policy (non-destructive, deterministic, historical truth
-- preserved):
--   1. For every duplicate non-null (user_id, version = 1,
--      revision_idempotency_key) group, the winner is the version-1 row with
--      the oldest created_at, ties broken by lowest product_id (stable UUID
--      ordering).
--   2. The winner keeps the key unchanged, so future same-key retries
--      converge on it (the repository's retry lookup finds exactly this row).
--   3. Every losing version-1 row's revision_idempotency_key is set to NULL:
--      it stops claiming the shared retry identity. The losing product root,
--      its version-1 row, and every child label fact (aliases, nutrients,
--      label limits, regimens, intake facts) remain fully readable — nothing
--      is deleted, merged, or soft-deleted.
--   4. Every reconciliation is recorded in an append-only audit table:
--      migration, user, original key, winner product/version, loser
--      product/version, decision, reason, and timestamp.
--   5. The partial unique index is created only after reconciliation.
--
-- Idempotency: reconciled losers no longer have a non-null key, so a rerun's
-- duplicate scan matches nothing and no data is touched again; the audit
-- insert is additionally guarded by a unique constraint plus ON CONFLICT DO
-- NOTHING so a rerun can never log a duplicate entry; all CREATE statements
-- use IF NOT EXISTS.
--
-- Run after 008 (or before re-applying 008 on a database stuck at 008's
-- duplicate failure):
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/009_supplement_create_idem_reconciliation.sql

CREATE TABLE IF NOT EXISTS supplement_create_idem_reconciliation_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    migration text NOT NULL,
    user_id text NOT NULL,
    revision_idempotency_key text NOT NULL,
    winner_product_id uuid NOT NULL,
    winner_version integer NOT NULL,
    loser_product_id uuid NOT NULL,
    loser_version integer NOT NULL,
    decision text NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- One audit row per reconciled loser per key group, ever: a rerun must
    -- never log a duplicate entry for the same decision.
    UNIQUE (user_id, revision_idempotency_key, loser_product_id, loser_version)
);

WITH ranked AS (
    SELECT product_id, version, user_id, revision_idempotency_key,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, revision_idempotency_key
               ORDER BY created_at ASC, product_id ASC
           ) AS rn
    FROM supplement_product_versions
    WHERE version = 1 AND revision_idempotency_key IS NOT NULL
),
losers AS (
    SELECT l.user_id, l.revision_idempotency_key,
           l.product_id, l.version,
           w.product_id AS winner_product_id, w.version AS winner_version
    FROM ranked l
    JOIN ranked w
      ON w.user_id = l.user_id
     AND w.revision_idempotency_key = l.revision_idempotency_key
     AND w.rn = 1
    WHERE l.rn > 1
),
audited AS (
    INSERT INTO supplement_create_idem_reconciliation_audit
        (migration, user_id, revision_idempotency_key,
         winner_product_id, winner_version,
         loser_product_id, loser_version,
         decision, reason)
    SELECT '009_supplement_create_idem_reconciliation',
           user_id, revision_idempotency_key,
           winner_product_id, winner_version,
           product_id, version,
           'null_loser_revision_idempotency_key',
           'pre-008 concurrent-create race duplicate: oldest created_at then lowest product_id keeps the retry key; losing version-1 rows release it (key set to NULL) with all product and label data preserved'
    FROM losers
    ON CONFLICT (user_id, revision_idempotency_key, loser_product_id, loser_version)
    DO NOTHING
    RETURNING id
)
UPDATE supplement_product_versions v
SET revision_idempotency_key = NULL
FROM losers l
WHERE v.product_id = l.product_id AND v.version = l.version;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_spv_user_create_idem
    ON supplement_product_versions (user_id, revision_idempotency_key)
    WHERE version = 1 AND revision_idempotency_key IS NOT NULL;
