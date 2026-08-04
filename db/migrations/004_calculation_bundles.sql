-- Durable calculation bundle provenance, additive after 003.
ALTER TABLE meal_event_nutrition_results
    ADD COLUMN IF NOT EXISTS source_id text;
UPDATE meal_event_nutrition_results SET source_id = provider || ':' || id::text
    WHERE source_id IS NULL;
ALTER TABLE meal_event_nutrition_results ALTER COLUMN source_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_meal_event_nutrition_source
    ON meal_event_nutrition_results (event_id, version, scope_key, provider, source_id);
