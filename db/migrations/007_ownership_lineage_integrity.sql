-- Forward-only migration: relational ownership and lineage integrity for the
-- meal-reuse and supplement/sports-nutrition substrate created by 006.
--
-- Why a new migration instead of editing 006: 006 is already pushed and may
-- be applied by existing deployments. Editing it in place would diverge the
-- applied schema from the shipped file (operators who already ran 006 would
-- never receive these constraints). 007 is additive and forward-safe: it adds
-- unique candidate keys, NOT NULL lineage columns, and composite foreign keys
-- without altering or dropping any existing object, and it remains safe when
-- 006 is rerun before it.
--
-- Enforcement (reviewer-terra finding 2):
--   * reuse lineage user_id must own BOTH the target and the source event;
--   * reuse provider-source rows must reference provider results that actually
--     belong to the declared target/source event+version pair, with the source
--     request fingerprint matching the real source result;
--   * every user-stamped product child (aliases), regimen, and intake must
--     reference a same-user product version (and same-user regimen);
--   * intake nutrient snapshots and intake↔meal links must bind their
--     product/version/user to the actual intake row, snapshots must name a
--     nutrient that exists on that exact product-version label, and links
--     must point at a meal event owned by the same user.
--
-- All 006 tables have no shipped writers yet (006 is schema-only), so the new
-- NOT NULL columns and constraints apply cleanly to any deployment that has
-- only run shipped code. Safe to rerun: every statement is idempotent
-- (CREATE UNIQUE INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, and
-- named-constraint guards), matching the 003-006 convention.
--
-- Run after 006: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/007_ownership_lineage_integrity.sql

-- ============================================================================
-- CANDIDATE KEYS REQUIRED BY THE COMPOSITE FOREIGN KEYS
-- ============================================================================
-- PostgreSQL foreign keys must reference a unique row set. These unique
-- indexes expose ownership/correlation tuples that primary keys alone do not
-- cover. None of them changes what existing rows mean; they only add
-- uniqueness that was already implicit (id is already a primary key).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_meal_events_id_user
    ON meal_events (id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_menr_id_event_version
    ON meal_event_nutrition_results (id, event_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_menr_id_request_fingerprint
    ON meal_event_nutrition_results (id, request_fingerprint);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_meal_reuse_sources_pair_source
    ON meal_event_reuse_sources (event_id, version, source_event_id, source_version);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_spv_product_version_user
    ON supplement_product_versions (product_id, version, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_supplement_regimens_id_user
    ON supplement_regimens (id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sie_id_user_product
    ON supplement_intake_events (id, user_id, product_id, product_version);

-- ============================================================================
-- REUSE LINEAGE: user_id must own both target and source events
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'meal_reuse_sources_target_owner_fk'
    ) THEN
        ALTER TABLE meal_event_reuse_sources
            ADD CONSTRAINT meal_reuse_sources_target_owner_fk
            FOREIGN KEY (event_id, user_id)
            REFERENCES meal_events (id, user_id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'meal_reuse_sources_source_owner_fk'
    ) THEN
        ALTER TABLE meal_event_reuse_sources
            ADD CONSTRAINT meal_reuse_sources_source_owner_fk
            FOREIGN KEY (source_event_id, user_id)
            REFERENCES meal_events (id, user_id) ON DELETE RESTRICT;
    END IF;
END $$;

-- ============================================================================
-- REUSE PROVIDER SOURCES: bind result IDs to the declared event/version pairs
-- ============================================================================
-- The declared source pair is carried on the mapping row itself so the
-- database can enforce (a) the declared pair equals the parent lineage row's
-- source pair, and (b) each provider result actually belongs to its declared
-- event/version. The source request fingerprint must be the real fingerprint
-- of the source result row.

ALTER TABLE meal_event_reuse_provider_sources
    ADD COLUMN IF NOT EXISTS source_event_id uuid;
ALTER TABLE meal_event_reuse_provider_sources
    ADD COLUMN IF NOT EXISTS source_version integer;

-- The columns are added nullable above for idempotency, then hardened: 006
-- has no shipped writers, so the table is empty in every deployment that has
-- only run shipped code and SET NOT NULL cannot fail on real data.
ALTER TABLE meal_event_reuse_provider_sources
    ALTER COLUMN source_event_id SET NOT NULL;
ALTER TABLE meal_event_reuse_provider_sources
    ALTER COLUMN source_version SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reuse_provider_sources_source_pair_fk'
    ) THEN
        ALTER TABLE meal_event_reuse_provider_sources
            ADD CONSTRAINT reuse_provider_sources_source_pair_fk
            FOREIGN KEY (event_id, version, source_event_id, source_version)
            REFERENCES meal_event_reuse_sources (event_id, version, source_event_id, source_version)
            ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reuse_provider_sources_target_result_fk'
    ) THEN
        ALTER TABLE meal_event_reuse_provider_sources
            ADD CONSTRAINT reuse_provider_sources_target_result_fk
            FOREIGN KEY (target_provider_result_id, event_id, version)
            REFERENCES meal_event_nutrition_results (id, event_id, version)
            ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reuse_provider_sources_source_result_fk'
    ) THEN
        ALTER TABLE meal_event_reuse_provider_sources
            ADD CONSTRAINT reuse_provider_sources_source_result_fk
            FOREIGN KEY (source_provider_result_id, source_event_id, source_version)
            REFERENCES meal_event_nutrition_results (id, event_id, version)
            ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reuse_provider_sources_source_fp_fk'
    ) THEN
        ALTER TABLE meal_event_reuse_provider_sources
            ADD CONSTRAINT reuse_provider_sources_source_fp_fk
            FOREIGN KEY (source_provider_result_id, source_request_fingerprint)
            REFERENCES meal_event_nutrition_results (id, request_fingerprint)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- ============================================================================
-- SUPPLEMENT CHILDREN: duplicated user_id must match the product owner
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'supplement_aliases_same_user_fk'
    ) THEN
        ALTER TABLE supplement_product_aliases
            ADD CONSTRAINT supplement_aliases_same_user_fk
            FOREIGN KEY (product_id, version, user_id)
            REFERENCES supplement_product_versions (product_id, version, user_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'supplement_regimens_same_user_product_fk'
    ) THEN
        ALTER TABLE supplement_regimens
            ADD CONSTRAINT supplement_regimens_same_user_product_fk
            FOREIGN KEY (product_id, product_version, user_id)
            REFERENCES supplement_product_versions (product_id, version, user_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'supplement_intake_same_user_product_fk'
    ) THEN
        ALTER TABLE supplement_intake_events
            ADD CONSTRAINT supplement_intake_same_user_product_fk
            FOREIGN KEY (product_id, product_version, user_id)
            REFERENCES supplement_product_versions (product_id, version, user_id)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- An intake bound to a regimen must belong to the regimen's owner. A NULL
-- regimen_id stays allowed (ad-hoc intake without a regimen).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'supplement_intake_same_user_regimen_fk'
    ) THEN
        ALTER TABLE supplement_intake_events
            ADD CONSTRAINT supplement_intake_same_user_regimen_fk
            FOREIGN KEY (regimen_id, user_id)
            REFERENCES supplement_regimens (id, user_id) ON DELETE RESTRICT;
    END IF;
END $$;

-- ============================================================================
-- INTAKE SNAPSHOTS: bind to the actual intake and its real label nutrients
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'intake_snapshots_intake_fk'
    ) THEN
        ALTER TABLE supplement_intake_nutrient_snapshots
            ADD CONSTRAINT intake_snapshots_intake_fk
            FOREIGN KEY (intake_id, user_id, product_id, product_version)
            REFERENCES supplement_intake_events (id, user_id, product_id, product_version)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- A snapshot can only record a nutrient that exists on that exact
-- product-version label, in the same unit.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'intake_snapshots_product_nutrient_fk'
    ) THEN
        ALTER TABLE supplement_intake_nutrient_snapshots
            ADD CONSTRAINT intake_snapshots_product_nutrient_fk
            FOREIGN KEY (product_id, product_version, nutrient_key, unit)
            REFERENCES supplement_product_nutrients (product_id, version, nutrient_key, unit)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- ============================================================================
-- INTAKE ↔ MEAL LINKS: bind to the actual intake and a same-user snack event
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'intake_meal_links_intake_fk'
    ) THEN
        ALTER TABLE supplement_intake_meal_links
            ADD CONSTRAINT intake_meal_links_intake_fk
            FOREIGN KEY (intake_id, user_id, product_id, product_version)
            REFERENCES supplement_intake_events (id, user_id, product_id, product_version)
            ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'intake_meal_links_event_owner_fk'
    ) THEN
        ALTER TABLE supplement_intake_meal_links
            ADD CONSTRAINT intake_meal_links_event_owner_fk
            FOREIGN KEY (event_id, user_id)
            REFERENCES meal_events (id, user_id) ON DELETE RESTRICT;
    END IF;
END $$;
