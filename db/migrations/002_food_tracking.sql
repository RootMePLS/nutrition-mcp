-- Forward-only migration: append-only food-tracking substrate.
--
-- Replaces the flat legacy `meals` model with meal_events (root aggregate) +
-- ordered items, immutable versions/corrections, raw evidence, media metadata,
-- three-provider nutrition results, canonical consensus results, a durable
-- sync journal, and backup manifests.
--
-- Run after 001: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_food_tracking.sql
-- Safe to rerun: every statement is idempotent.

-- ============================================================================
-- LEGACY NUTRITION DATA RESET (IRREVERSIBLE)
-- ============================================================================
--
-- The legacy `meals` table and all nutrition meal rows in it are intentionally
-- and permanently removed. There is no backward compatibility and no backfill:
-- the user decision for this slice is a clean model. profiles, nutrition_goals,
-- water_log, weight_log, tool_analytics and food_cache are NOT touched.

-- public_landing_stats() from 001 references `meals`; SQL functions record a
-- real pg_depend edge to the tables they reference, so the old function must
-- be dropped before `meals` can be. It is re-created at the end of this
-- migration against the new schema (it cannot be replaced up front because it
-- now references tables that do not exist yet).
DROP FUNCTION IF EXISTS public_landing_stats();

-- Explicit dependency gate: refuse to drop `meals` while anything unexpected
-- (foreign keys, views, other functions) still depends on it. This makes a
-- half-executed or hand-modified schema fail loudly instead of silently
-- half-dropping the legacy model.
DO $$
BEGIN
    IF to_regclass('public.meals') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM pg_constraint
                   WHERE confrelid = 'public.meals'::regclass) THEN
            RAISE EXCEPTION 'refusing to drop legacy meals: foreign keys still reference it';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_views
                   WHERE schemaname = 'public'
                     AND definition ILIKE '%meals%') THEN
            RAISE EXCEPTION 'refusing to drop legacy meals: views still reference it';
        END IF;
        -- IRREVERSIBLE nutrition-data reset: delete legacy rows, then drop the
        -- table. RESTRICT makes any missed dependency an explicit error,
        -- never a cascade.
        DELETE FROM meals;
        DROP TABLE meals RESTRICT;
    END IF;
END $$;

-- ============================================================================
-- MEAL EVENTS (root aggregate: one eating occurrence)
-- ============================================================================

CREATE TABLE IF NOT EXISTS meal_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    reported_at timestamptz NOT NULL,
    consumed_at timestamptz NOT NULL,
    meal_type text CHECK (
        meal_type IS NULL OR meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')
    ),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
    idempotency_key text NOT NULL,
    external_write_authorized boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_meal_events_user_idem
    ON meal_events (user_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_meal_events_user_id ON meal_events (user_id);
CREATE INDEX IF NOT EXISTS idx_meal_events_consumed_at ON meal_events (consumed_at);

-- ============================================================================
-- MEAL EVENT VERSIONS (append-only; corrections insert, never update)
-- ============================================================================

CREATE TABLE IF NOT EXISTS meal_event_versions (
    event_id uuid NOT NULL REFERENCES meal_events (id) ON DELETE RESTRICT,
    version integer NOT NULL CHECK (version >= 1),
    correction_idempotency_key text,
    correction_reason text,
    raw_text_snapshot text,
    parser_policy_version text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_meal_event_versions_correction
    ON meal_event_versions (event_id, correction_idempotency_key)
    WHERE correction_idempotency_key IS NOT NULL;

-- ============================================================================
-- MEAL EVENT ITEMS (ordered positions within a version)
-- ============================================================================

CREATE TABLE IF NOT EXISTS meal_event_items (
    event_id uuid NOT NULL,
    version integer NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    raw_item_text text NOT NULL,
    normalized_name text,
    quantity numeric,
    portion_value numeric,
    portion_unit text,
    notes text,
    PRIMARY KEY (event_id, version, ordinal),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT
);

-- ============================================================================
-- MEAL EVENT INPUTS (immutable evidence/provenance)
-- ============================================================================
-- Precedence contract (lower integer wins): user_text (10) > audio_transcript
-- (20) > photo_ocr (30) / photo_vision (40) > model_assumption (50). Explicit
-- user text always outranks photo/OCR/vision-derived evidence; lower-precedence
-- inputs are retained, never silently discarded.

CREATE TABLE IF NOT EXISTS meal_event_inputs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    version integer NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN (
        'user_text', 'audio_transcript', 'photo_ocr', 'photo_vision', 'model_assumption'
    )),
    content text NOT NULL,
    content_hash text NOT NULL,
    precedence integer NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT,
    UNIQUE (event_id, version, source_kind, content_hash)
);

-- ============================================================================
-- MEAL EVENT MEDIA (metadata only — bytes live on disk under MEDIA_ROOT)
-- ============================================================================

CREATE TABLE IF NOT EXISTS meal_event_media (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    version integer NOT NULL,
    kind text NOT NULL CHECK (kind IN ('photo', 'audio')),
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    sha256 text NOT NULL,
    duration_ms integer,
    width integer,
    height integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT,
    UNIQUE (event_id, version, sha256)
);

-- ============================================================================
-- MEAL EVENT NUTRITION RESULTS (raw + normalized per-provider results)
-- ============================================================================
-- scope_key makes the ordinal-nullable uniqueness NULL-safe: item results are
-- 'item:<ordinal>', the event aggregate is 'event'. Missing nutrient values
-- stay NULL and are never converted to zero for consensus.

CREATE TABLE IF NOT EXISTS meal_event_nutrition_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    version integer NOT NULL,
    ordinal integer,
    scope_key text GENERATED ALWAYS AS (
        CASE WHEN ordinal IS NULL THEN 'event' ELSE 'item:' || ordinal::text END
    ) STORED,
    provider text NOT NULL CHECK (provider IN ('nutrition-local', 'own', 'myfitnesspal')),
    source_id text,
    status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'unavailable')),
    request_fingerprint text NOT NULL,
    algorithm_version text NOT NULL,
    raw_payload jsonb NOT NULL DEFAULT '{}',
    calories numeric,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    fiber_g numeric,
    sugar_g numeric,
    alcohol_g numeric,
    error_code text,
    error_message text,
    calculated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT,
    UNIQUE (event_id, version, scope_key, provider, request_fingerprint)
);

-- ============================================================================
-- MEAL EVENT CANONICAL RESULTS (one deterministic row per version + scope)
-- ============================================================================

CREATE TABLE IF NOT EXISTS meal_event_canonical_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    version integer NOT NULL,
    ordinal integer,
    scope_key text GENERATED ALWAYS AS (
        CASE WHEN ordinal IS NULL THEN 'event' ELSE 'item:' || ordinal::text END
    ) STORED,
    status text NOT NULL CHECK (status IN ('pending', 'ready', 'low_confidence')),
    consensus_status text NOT NULL CHECK (consensus_status IN (
        'two_agree_one_outlier', 'all_agree', 'no_consensus', 'insufficient_data'
    )),
    calories numeric,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    fiber_g numeric,
    sugar_g numeric,
    alcohol_g numeric,
    eligible_providers text[] NOT NULL DEFAULT '{}',
    outlier_providers text[] NOT NULL DEFAULT '{}',
    threshold_percent numeric NOT NULL DEFAULT 10,
    policy_version text NOT NULL,
    source_result_ids uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT,
    UNIQUE (event_id, version, scope_key)
);

-- ============================================================================
-- MEAL EVENT SYNC JOURNAL (durable outbox; independent of external success)
-- ============================================================================
-- Written BEFORE any external call. A journal row is the only claim of an
-- authorized external write. Failures update state; they never delete or roll
-- back local event data.

CREATE TABLE IF NOT EXISTS meal_event_sync_journal (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    version integer NOT NULL,
    system text NOT NULL,
    operation text NOT NULL,
    request_fingerprint text NOT NULL,
    authorization_source text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'in_flight', 'succeeded', 'failed', 'dead_letter')
    ),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    external_id text,
    last_error text,
    next_attempt_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, version)
        REFERENCES meal_event_versions (event_id, version) ON DELETE RESTRICT,
    UNIQUE (system, operation, request_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_meal_event_sync_journal_retry
    ON meal_event_sync_journal (state, next_attempt_at)
    WHERE state IN ('pending', 'failed');

-- ============================================================================
-- BACKUP MANIFESTS (index/contract for separately-run backups — NOT a job)
-- ============================================================================
-- This table gives permanent-delete code an explicit index to target. It does
-- not schedule backups, does not store snapshots, and must not be read as a
-- claim that backups are operational.

CREATE TABLE IF NOT EXISTS backup_manifests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_kind text NOT NULL CHECK (backup_kind IN ('postgres', 'media')),
    retention_class text NOT NULL CHECK (retention_class IN ('daily', 'monthly')),
    snapshot_key text NOT NULL,
    checksum text NOT NULL,
    covered_through timestamptz,
    deletion_status text NOT NULL DEFAULT 'present' CHECK (
        deletion_status IN ('present', 'deletion_requested', 'deleted')
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (backup_kind, snapshot_key)
);

-- ============================================================================
-- PUBLIC LANDING STATS FUNCTION (re-created against the new schema)
-- ============================================================================
-- Same shape as in 001, but food totals now come from active meal_events at
-- their current version (event-scope canonical results), not the dropped
-- legacy `meals` table.
CREATE OR REPLACE FUNCTION public_landing_stats()
RETURNS json
LANGUAGE sql
STABLE
AS $$
  SELECT json_build_object(
    'food_logs',      (SELECT count(*) FROM meal_events WHERE status = 'active'),
    'total_calories', (SELECT coalesce(sum(c.calories), 0)
                         FROM meal_event_canonical_results c
                         JOIN meal_events e
                           ON e.id = c.event_id AND c.version = e.current_version
                        WHERE c.ordinal IS NULL AND e.status = 'active'),
    'total_protein_g',(SELECT coalesce(sum(c.protein_g), 0)
                         FROM meal_event_canonical_results c
                         JOIN meal_events e
                           ON e.id = c.event_id AND c.version = e.current_version
                        WHERE c.ordinal IS NULL AND e.status = 'active'),
    'total_carbs_g',  (SELECT coalesce(sum(c.carbs_g), 0)
                         FROM meal_event_canonical_results c
                         JOIN meal_events e
                           ON e.id = c.event_id AND c.version = e.current_version
                        WHERE c.ordinal IS NULL AND e.status = 'active'),
    'total_fat_g',    (SELECT coalesce(sum(c.fat_g), 0)
                         FROM meal_event_canonical_results c
                         JOIN meal_events e
                           ON e.id = c.event_id AND c.version = e.current_version
                        WHERE c.ordinal IS NULL AND e.status = 'active'),
    'timezones',      (SELECT count(DISTINCT timezone) FROM profiles),
    'timezone_list',  (SELECT coalesce(json_agg(DISTINCT timezone), '[]'::json) FROM profiles)
  );
$$;

COMMENT ON FUNCTION public_landing_stats() IS
  'Aggregate-only stats for the public landing page. Counts active meal_events at their current version. Exposes no per-user rows.';
