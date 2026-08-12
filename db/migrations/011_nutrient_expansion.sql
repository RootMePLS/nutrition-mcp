-- Forward-only migration: canonical nutrient expansion (slice 1 of the
-- MFP-like nutrient dashboard). Adds first-class micronutrient / fat-subtype
-- columns to the per-provider and canonical result tables.
--
-- Additive and idempotent: every statement is ADD COLUMN IF NOT EXISTS, no
-- defaults, no backfill. Old rows read as NULL, which is the honest value for
-- "never computed" — NULL is never coerced to zero anywhere in the model.
--
-- Run after 010:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/011_nutrient_expansion.sql
-- MUST be applied to production BEFORE code referencing these columns deploys.

ALTER TABLE meal_event_nutrition_results
    ADD COLUMN IF NOT EXISTS saturated_fat_g numeric,
    ADD COLUMN IF NOT EXISTS polyunsaturated_fat_g numeric,
    ADD COLUMN IF NOT EXISTS monounsaturated_fat_g numeric,
    ADD COLUMN IF NOT EXISTS trans_fat_g numeric,
    ADD COLUMN IF NOT EXISTS cholesterol_mg numeric,
    ADD COLUMN IF NOT EXISTS sodium_mg numeric,
    ADD COLUMN IF NOT EXISTS potassium_mg numeric,
    ADD COLUMN IF NOT EXISTS calcium_mg numeric,
    ADD COLUMN IF NOT EXISTS iron_mg numeric,
    ADD COLUMN IF NOT EXISTS vitamin_c_mg numeric,
    ADD COLUMN IF NOT EXISTS vitamin_a_mcg_rae numeric;

ALTER TABLE meal_event_canonical_results
    ADD COLUMN IF NOT EXISTS saturated_fat_g numeric,
    ADD COLUMN IF NOT EXISTS polyunsaturated_fat_g numeric,
    ADD COLUMN IF NOT EXISTS monounsaturated_fat_g numeric,
    ADD COLUMN IF NOT EXISTS trans_fat_g numeric,
    ADD COLUMN IF NOT EXISTS cholesterol_mg numeric,
    ADD COLUMN IF NOT EXISTS sodium_mg numeric,
    ADD COLUMN IF NOT EXISTS potassium_mg numeric,
    ADD COLUMN IF NOT EXISTS calcium_mg numeric,
    ADD COLUMN IF NOT EXISTS iron_mg numeric,
    ADD COLUMN IF NOT EXISTS vitamin_c_mg numeric,
    ADD COLUMN IF NOT EXISTS vitamin_a_mcg_rae numeric;
