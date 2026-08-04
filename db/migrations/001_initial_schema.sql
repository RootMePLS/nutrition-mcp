-- Consolidated schema for nutrition-mcp (local PostgreSQL, single-user, no auth).
-- Replaces 12 Supabase-specific migrations with RLS, auth FK refs, grants/roles.
-- Run once: psql nutrition_mcp < db/migrations/001_initial_schema.sql

-- ============================================================================
-- TABLES
-- ============================================================================

-- Meals: the core table — one row per logged meal item.
CREATE TABLE IF NOT EXISTS meals (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id text NOT NULL,
    logged_at timestamptz NOT NULL DEFAULT now(),
    meal_type text,
    description text NOT NULL,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    fiber_g numeric CHECK (fiber_g >= 0),
    sugar_g numeric CHECK (sugar_g >= 0),
    alcohol_g numeric CHECK (alcohol_g >= 0),
    notes text,
    idempotency_key text,
    CONSTRAINT meals_meal_type_check CHECK (
        meal_type = ANY (ARRAY['breakfast'::text, 'lunch'::text, 'dinner'::text, 'snack'::text])
    )
);

-- Performance indices for meals.
CREATE INDEX IF NOT EXISTS idx_meals_logged_at ON meals (logged_at);
CREATE INDEX IF NOT EXISTS idx_meals_user_id ON meals (user_id);

-- Partial unique index: same user + idempotency key = deduplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_meals_user_idem
    ON meals (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Profiles: one row per user — timezone, display preferences.
CREATE TABLE IF NOT EXISTS profiles (
    user_id text PRIMARY KEY,
    timezone text NOT NULL DEFAULT 'UTC',
    preferred_weight_unit text
        CHECK (preferred_weight_unit IS NULL OR preferred_weight_unit IN ('kg', 'lb')),
    widgets_enabled boolean NOT NULL DEFAULT true,
    alcohol_tracking_enabled boolean NOT NULL DEFAULT false,
    preferred_drink_unit text
        CHECK (preferred_drink_unit IS NULL OR preferred_drink_unit IN ('us', 'uk')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Nutrition goals: one row per user. All numeric targets are optional.
CREATE TABLE IF NOT EXISTS nutrition_goals (
    user_id text PRIMARY KEY,
    daily_calories integer,
    daily_protein_g numeric(6, 2),
    daily_carbs_g numeric(6, 2),
    daily_fat_g numeric(6, 2),
    daily_fiber_g numeric(6, 2) CHECK (daily_fiber_g >= 0),
    daily_sugar_g numeric(6, 2) CHECK (daily_sugar_g >= 0),
    daily_alcohol_g numeric(6, 2) CHECK (daily_alcohol_g >= 0),
    daily_water_ml integer,
    target_weight_g integer CHECK (target_weight_g > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Water log: one row per hydration entry.
CREATE TABLE IF NOT EXISTS water_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id text NOT NULL,
    amount_ml integer NOT NULL CHECK (amount_ml > 0),
    logged_at timestamptz NOT NULL DEFAULT now(),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text
);

CREATE INDEX IF NOT EXISTS idx_water_log_user_id ON water_log (user_id);
CREATE INDEX IF NOT EXISTS idx_water_log_logged_at ON water_log (logged_at);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_water_log_user_idem
    ON water_log (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Weight log: one row per weigh-in.
CREATE TABLE IF NOT EXISTS weight_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id text NOT NULL,
    weight_g integer NOT NULL CHECK (weight_g > 0),
    logged_at timestamptz NOT NULL DEFAULT now(),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text
);

CREATE INDEX IF NOT EXISTS idx_weight_log_user_id ON weight_log (user_id);
CREATE INDEX IF NOT EXISTS idx_weight_log_logged_at ON weight_log (logged_at);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_weight_log_user_idem
    ON weight_log (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Tool analytics: fire-and-forget per-tool-call metrics.
CREATE TABLE IF NOT EXISTS tool_analytics (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id varchar(255) NOT NULL,
    tool_name varchar(100) NOT NULL,
    success boolean NOT NULL,
    duration_ms integer NOT NULL,
    error_category varchar(50),
    date_range_days integer,
    mcp_session_id varchar(255),
    invoked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_analytics_invoked_at ON tool_analytics (invoked_at);
CREATE INDEX IF NOT EXISTS idx_tool_analytics_tool_name ON tool_analytics (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_analytics_user_id ON tool_analytics (user_id);
CREATE INDEX IF NOT EXISTS idx_tool_analytics_user_tool ON tool_analytics (user_id, tool_name);

-- Food cache: shared barcode/food-id → normalized FoodResult. Global, not per-user.
CREATE TABLE IF NOT EXISTS food_cache (
    source text NOT NULL,
    source_id text NOT NULL,
    payload jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, source_id)
);

-- ============================================================================
-- PUBLIC LANDING STATS FUNCTION
-- ============================================================================

-- Read-only aggregate for the public landing page. Returns global, non-personal
-- totals in a single round trip. No SECURITY DEFINER — single-user local PG
-- has no RLS, so a plain SQL function works.
CREATE OR REPLACE FUNCTION public_landing_stats()
RETURNS json
LANGUAGE sql
STABLE
AS $$
  SELECT json_build_object(
    'food_logs',      (SELECT count(*) FROM meals),
    'total_calories', (SELECT coalesce(sum(calories), 0) FROM meals),
    'total_protein_g',(SELECT coalesce(sum(protein_g), 0) FROM meals),
    'total_carbs_g',  (SELECT coalesce(sum(carbs_g), 0) FROM meals),
    'total_fat_g',    (SELECT coalesce(sum(fat_g), 0) FROM meals),
    'timezones',      (SELECT count(DISTINCT timezone) FROM profiles),
    'timezone_list',  (SELECT coalesce(json_agg(DISTINCT timezone), '[]'::json) FROM profiles)
  );
$$;

COMMENT ON FUNCTION public_landing_stats() IS
  'Aggregate-only stats for the public landing page. Exposes no per-user rows.';

-- ============================================================================
-- BOOTSTRAP DATA
-- ============================================================================

-- Seed the single-user profile so the app works without manual setup.
INSERT INTO profiles (user_id) VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (user_id) DO NOTHING;
