#!/bin/sh
# Forward-only, idempotent migration runner. Applies db/migrations/*.sql in
# lexical (numbered) order using the standard PG* env vars for the connection.
# Every migration in this repo is additive and rerun-safe (IF NOT EXISTS /
# ADD COLUMN IF NOT EXISTS), so re-running the whole loop against an
# already-migrated database is a no-op. ON_ERROR_STOP makes any real failure
# abort with a non-zero exit so compose reports the migrate service as failed.
set -eu
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
for f in "${MIGRATIONS_DIR}"/*.sql; do
    echo "==> applying ${f}"
    psql -v ON_ERROR_STOP=1 -q -f "${f}"
done
echo "==> migrations complete"
