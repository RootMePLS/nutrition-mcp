-- Forward-only durable agent-facing capture state. Run after 002.
CREATE TABLE IF NOT EXISTS meal_captures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    conversation_key text NOT NULL,
    idempotency_key text NOT NULL,
    state text NOT NULL DEFAULT 'receiving' CHECK (state IN ('receiving','ready_to_confirm','confirmed','cancelled','expired')),
    prepared_draft jsonb,
    confirmed_at timestamptz,
    event_id uuid REFERENCES meal_events(id) ON DELETE RESTRICT,
    event_version integer,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_meal_captures_user_state ON meal_captures(user_id, state);

CREATE TABLE IF NOT EXISTS meal_capture_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id uuid NOT NULL REFERENCES meal_captures(id) ON DELETE CASCADE,
    external_message_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('text','answer','photo','audio','other')),
    text text,
    raw_metadata jsonb NOT NULL DEFAULT '{}',
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (capture_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS meal_capture_answers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id uuid NOT NULL REFERENCES meal_captures(id) ON DELETE CASCADE,
    question text NOT NULL,
    answer text NOT NULL,
    message_id text,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meal_capture_media (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id uuid NOT NULL REFERENCES meal_captures(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('photo','audio')),
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    sha256 text NOT NULL,
    duration_ms integer,
    width integer,
    height integer,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (capture_id, sha256)
);
