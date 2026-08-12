#!/bin/sh
# Forward-only, idempotent migration runner. Applies db/migrations/*.sql in
# lexical (numbered) order using the standard PG* env vars for the connection.
#
# HONEST SAFETY NOTE: migrations 001 and 003-011 are additive and rerun-safe
# (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), but 002_food_tracking.sql is
# DESTRUCTIVE: it runs `DELETE FROM meals` and `DROP TABLE meals RESTRICT` to
# retire the legacy meals -> meal_events migration. 002 is only safe on a
# database that has NO legacy `meals` table (it is then a no-op), e.g. the
# isolated compose `db` service replaying from scratch on its throwaway
# volume, or an already-migrated database.
#
# Host-DB guard (REFUSE_IF_LEGACY_MEALS=1, set ONLY by the hostdb compose
# profile's migrate-hostdb service): before running ANY migration, refuse
# (fail closed, non-zero exit) when a legacy `public.meals` table exists in
# the target database, so the opt-in host-DB path can never reach 002's
# DELETE/DROP against a live database that still has legacy meal data.
# Migrate `meals` -> `meal_events` safely outside the opt-in profile first.
# The isolated `db`/`migrate` services leave the switch unset and replay
# 001-011 unconditionally, exactly as before.
#
# ON_ERROR_STOP makes any real failure abort with a non-zero exit so compose
# reports the migrate service as failed.
set -eu
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

if [ "${REFUSE_IF_LEGACY_MEALS:-0}" = "1" ]; then
    legacy_meals=$(psql -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'meals'")
    if [ "$legacy_meals" != "0" ]; then
        echo "ERROR: host database has a legacy 'meals' table; refusing to run destructive migration 002." >&2
        echo "       Migrate 'meals' -> 'meal_events' safely outside the opt-in hostdb profile first," >&2
        echo "       or point app-hostdb at a database that is already at or past migration 002." >&2
        exit 1
    fi
    echo "==> hostdb guard: no legacy 'meals' table; proceeding with additive migrations"
fi

for f in "${MIGRATIONS_DIR}"/*.sql; do
    echo "==> applying ${f}"
    psql -v ON_ERROR_STOP=1 -q -f "${f}"
done
echo "==> migrations complete"
