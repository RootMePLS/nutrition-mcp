-- Durable correction provenance and consensus audit evidence.
ALTER TABLE meal_event_versions ADD COLUMN IF NOT EXISTS prior_version integer;
ALTER TABLE meal_event_versions ADD COLUMN IF NOT EXISTS correction_author text;
ALTER TABLE meal_event_versions ADD COLUMN IF NOT EXISTS source_timestamp timestamptz;
ALTER TABLE meal_event_versions ADD COLUMN IF NOT EXISTS confirmation_received boolean NOT NULL DEFAULT false;
ALTER TABLE meal_event_versions ADD COLUMN IF NOT EXISTS external_write_authorized boolean NOT NULL DEFAULT false;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'meal_event_versions_prior_fk'
    ) THEN
        ALTER TABLE meal_event_versions ADD CONSTRAINT meal_event_versions_prior_fk
            FOREIGN KEY (event_id, prior_version) REFERENCES meal_event_versions(event_id, version)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;
ALTER TABLE meal_event_canonical_results ADD COLUMN IF NOT EXISTS audit_evidence jsonb NOT NULL DEFAULT '{}';
ALTER TABLE meal_event_canonical_results ADD COLUMN IF NOT EXISTS algorithm_version text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_correction_bundle_fingerprint
    ON meal_event_versions (event_id, calculation_bundle_fingerprint)
    WHERE calculation_bundle_fingerprint IS NOT NULL;
