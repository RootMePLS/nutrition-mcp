-- Forward-only migration: meal-reuse lineage and supplement/sports-nutrition
-- catalogue substrate. Additive after 005: no existing meal/capture/profile/
-- alcohol object is altered or dropped. Safe to rerun: every statement is
-- idempotent (CREATE TABLE/INDEX IF NOT EXISTS, named-constraint guards).
--
-- This migration is schema only. It registers no MCP tools and writes no
-- rows; product, regimen, and intake facts are created exclusively by later
-- explicit user-authorized mutations.
--
-- Run after 005: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/006_meal_reuse_and_supplements.sql

-- ============================================================================
-- MEAL REUSE LINEAGE (one row per reused target event version)
-- ============================================================================
-- Reuse creates a NEW meal event that copies persisted source evidence. This
-- table records the immutable source relationship; source rows are never
-- mutated and copied values are never synthesized.

CREATE TABLE IF NOT EXISTS meal_event_reuse_sources (
    event_id uuid NOT NULL,
    version integer NOT NULL,
    user_id text NOT NULL,
    source_event_id uuid NOT NULL,
    source_version integer NOT NULL,
    source_canonical_result_id uuid,
    source_bundle_fingerprint text,
    copied_at timestamptz NOT NULL DEFAULT now(),
    reuse_idempotency_key text NOT NULL,
    confirmation_received boolean NOT NULL,
    created_by text NOT NULL,
    PRIMARY KEY (event_id, version),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT,
    FOREIGN KEY (source_event_id, source_version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_meal_reuse_user_idem
    ON meal_event_reuse_sources (user_id, reuse_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_meal_reuse_source_pair
    ON meal_event_reuse_sources (source_event_id, source_version);

-- Maps each copied provider result row on the target event to its source
-- provider result, keeping copied evidence auditable even when the target
-- request fingerprint is occurrence-specific.
CREATE TABLE IF NOT EXISTS meal_event_reuse_provider_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    version integer NOT NULL,
    target_provider_result_id uuid NOT NULL
        REFERENCES meal_event_nutrition_results (id) ON DELETE RESTRICT,
    source_provider_result_id uuid NOT NULL
        REFERENCES meal_event_nutrition_results (id) ON DELETE RESTRICT,
    source_request_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_reuse_sources (event_id, version) ON DELETE RESTRICT,
    UNIQUE (target_provider_result_id),
    UNIQUE (event_id, version, source_provider_result_id)
);

-- ============================================================================
-- SUPPLEMENT PRODUCTS (user-scoped root aggregate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplement_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    category text NOT NULL CHECK (category IN ('supplement', 'sports_nutrition')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_supplement_products_user_status
    ON supplement_products (user_id, status);

-- ============================================================================
-- SUPPLEMENT PRODUCT VERSIONS (immutable label revisions)
-- ============================================================================
-- A revision inserts version N+1 and moves the root pointer inside one
-- transaction; historical rows are never updated.

CREATE TABLE IF NOT EXISTS supplement_product_versions (
    product_id uuid NOT NULL
        REFERENCES supplement_products (id) ON DELETE RESTRICT,
    version integer NOT NULL CHECK (version >= 1),
    user_id text NOT NULL,
    revision_idempotency_key text,
    display_name text NOT NULL,
    short_name text,
    brand text,
    form text,
    serving_amount numeric CHECK (serving_amount IS NULL OR serving_amount > 0),
    serving_unit text,
    serving_description text,
    label_evidence jsonb NOT NULL,
    label_source_kind text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    prior_version integer,
    PRIMARY KEY (product_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_supplement_product_revision
    ON supplement_product_versions (product_id, revision_idempotency_key)
    WHERE revision_idempotency_key IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'supplement_product_versions_prior_fk'
    ) THEN
        ALTER TABLE supplement_product_versions
            ADD CONSTRAINT supplement_product_versions_prior_fk
            FOREIGN KEY (product_id, prior_version)
            REFERENCES supplement_product_versions (product_id, version)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_supplement_product_versions_user_name
    ON supplement_product_versions (user_id, lower(display_name));

-- ============================================================================
-- SUPPLEMENT PRODUCT ALIASES (per label version; ambiguity representable)
-- ============================================================================
-- The (user_id, normalized_alias) lookup index is deliberately NON-unique:
-- several products may share one normalized alias and resolution must report
-- candidates instead of silently picking one.

CREATE TABLE IF NOT EXISTS supplement_product_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL,
    version integer NOT NULL,
    user_id text NOT NULL,
    alias text NOT NULL CHECK (btrim(alias) <> ''),
    normalized_alias text NOT NULL CHECK (normalized_alias <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (product_id, version)
        REFERENCES supplement_product_versions (product_id, version) ON DELETE RESTRICT,
    UNIQUE (product_id, version, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_supplement_aliases_user_normalized
    ON supplement_product_aliases (user_id, normalized_alias);

-- ============================================================================
-- SUPPLEMENT PRODUCT NUTRIENTS (generic label facts)
-- ============================================================================
-- Every nutrient actually supplied by the label/source is persisted with an
-- explicit unit and evidence. Unknown values are omitted entirely: amount is
-- NOT NULL and no synthetic zero/NULL row is ever stored. An explicitly
-- supplied numeric zero is real data and persists as 0.

CREATE TABLE IF NOT EXISTS supplement_product_nutrients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL,
    version integer NOT NULL,
    nutrient_key text NOT NULL CHECK (btrim(nutrient_key) <> ''),
    display_name text,
    amount numeric NOT NULL,
    unit text NOT NULL CHECK (btrim(unit) <> ''),
    source_evidence jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (product_id, version)
        REFERENCES supplement_product_versions (product_id, version) ON DELETE RESTRICT,
    UNIQUE (product_id, version, nutrient_key, unit)
);

-- Optional immutable label-defined maximum per nutrient, used only for
-- transparent recorded-dose-vs-label-limit data flags. No advice semantics.
CREATE TABLE IF NOT EXISTS supplement_product_label_limits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL,
    version integer NOT NULL,
    nutrient_key text NOT NULL CHECK (btrim(nutrient_key) <> ''),
    unit text NOT NULL CHECK (btrim(unit) <> ''),
    maximum_amount numeric NOT NULL CHECK (maximum_amount > 0),
    source_evidence jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (product_id, version)
        REFERENCES supplement_product_versions (product_id, version) ON DELETE RESTRICT,
    UNIQUE (product_id, version, nutrient_key, unit)
);

-- ============================================================================
-- SUPPLEMENT REGIMENS (declarative intent; no scheduler, no auto-marking)
-- ============================================================================
-- A regimen always binds a historical product version, so later label
-- revisions cannot rewrite intent or facts.

CREATE TABLE IF NOT EXISTS supplement_regimens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    product_id uuid NOT NULL,
    product_version integer NOT NULL,
    dose_servings numeric NOT NULL CHECK (dose_servings > 0),
    schedule jsonb NOT NULL,
    timezone text NOT NULL,
    starts_on date NOT NULL,
    ends_on date CHECK (ends_on IS NULL OR ends_on >= starts_on),
    active boolean NOT NULL DEFAULT true,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deactivated_at timestamptz,
    FOREIGN KEY (product_id, product_version)
        REFERENCES supplement_product_versions (product_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_supplement_regimens_user_active
    ON supplement_regimens (user_id, active);

-- ============================================================================
-- SUPPLEMENT INTAKE EVENTS (append-only state facts)
-- ============================================================================
-- Facts are inserted, never updated or deleted. state_action is
-- done|missed|cleared; the visible projection is exactly undefined|done|missed
-- (absent mark or latest cleared action projects undefined).

CREATE TABLE IF NOT EXISTS supplement_intake_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    product_id uuid NOT NULL,
    product_version integer NOT NULL,
    regimen_id uuid REFERENCES supplement_regimens (id) ON DELETE RESTRICT,
    servings numeric NOT NULL CHECK (servings > 0),
    occurred_at timestamptz NOT NULL,
    state_action text NOT NULL CHECK (state_action IN ('done', 'missed', 'cleared')),
    reason text,
    actor text NOT NULL,
    source_intake_id uuid REFERENCES supplement_intake_events (id) ON DELETE RESTRICT,
    supersedes_intake_id uuid REFERENCES supplement_intake_events (id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (product_id, product_version)
        REFERENCES supplement_product_versions (product_id, version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_supplement_intake_user_idem
    ON supplement_intake_events (user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_supplement_intake_user_product_time
    ON supplement_intake_events (user_id, product_id, occurred_at);

-- ============================================================================
-- SUPPLEMENT INTAKE NUTRIENT SNAPSHOTS (immutable scaled label facts)
-- ============================================================================
-- One row per supplied product-version nutrient scaled by servings. A later
-- label revision can never change what a historical intake recorded.

CREATE TABLE IF NOT EXISTS supplement_intake_nutrient_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intake_id uuid NOT NULL
        REFERENCES supplement_intake_events (id) ON DELETE RESTRICT,
    user_id text NOT NULL,
    product_id uuid NOT NULL,
    product_version integer NOT NULL,
    nutrient_key text NOT NULL,
    unit text NOT NULL,
    original_amount numeric NOT NULL,
    scaled_amount numeric NOT NULL,
    source_evidence jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (intake_id, nutrient_key, unit)
);

-- ============================================================================
-- SUPPLEMENT INTAKE MEAL LINKS (caloric sports nutrition -> snack event)
-- ============================================================================
-- One-to-one bridge between a confirmed done intake and the snack meal event
-- it created. Queryable in both directions; no row exists for non-caloric
-- supplements or non-done actions.

CREATE TABLE IF NOT EXISTS supplement_intake_meal_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    intake_id uuid NOT NULL
        REFERENCES supplement_intake_events (id) ON DELETE RESTRICT,
    event_id uuid NOT NULL,
    version integer NOT NULL,
    product_id uuid NOT NULL,
    product_version integer NOT NULL,
    idempotency_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (intake_id),
    UNIQUE (event_id, version),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT
);
