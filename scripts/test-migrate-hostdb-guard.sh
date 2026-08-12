#!/bin/sh
# Probe test for the hostdb fail-closed guard in scripts/migrate.sh.
#
# Runs ONLY against a disposable probe database (nutrition_mcp_migrate_probe)
# on the local PostgreSQL instance. NEVER point this at the live
# nutrition_mcp database. It proves:
#   1. FAIL-CLOSED: with a legacy `meals` table present, the guarded runner
#      (REFUSE_IF_LEGACY_MEALS=1) exits non-zero and leaves the meals rows
#      fully intact (migration 002's DELETE/DROP is never reached).
#   2. ADDITIVE PATH: with no `meals` table, the guarded runner exits zero
#      and applies migrations 001-011 from scratch (meal_events exists).
#   3. DEFAULT UNCHANGED: without the env switch (the isolated compose `db`
#      path), migrate.sh has no guard and replays everything unconditionally.
set -eu

PROBE_DB=nutrition_mcp_migrate_probe
export PGHOST="${PGHOST:-localhost}"
export PGUSER="${PGUSER:-fishhead}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${PGDATABASE:-}" = "nutrition_mcp" ]; then
    echo "REFUSING: PGDATABASE is the live nutrition_mcp database" >&2
    exit 2
fi

reset_probe() {
    dropdb --if-exists "$PROBE_DB"
    createdb "$PROBE_DB"
}

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

# A faithful stand-in for a host database that predates migration 002:
# migration 001 applied in full (which creates the legacy `meals` table),
# plus one "precious" legacy row the guard must protect.
create_legacy_meals() {
    psql -d "$PROBE_DB" -q -v ON_ERROR_STOP=1 -f "$REPO_ROOT/db/migrations/001_initial_schema.sql"
    psql -d "$PROBE_DB" -q -c \
        "INSERT INTO meals (user_id, meal_type, description, calories) VALUES ('legacy-user', 'lunch', 'precious legacy row', 500);"
}

echo "== case 1: legacy meals table present -> guard must fail closed"
reset_probe
create_legacy_meals
set +e
REFUSE_IF_LEGACY_MEALS=1 PGDATABASE="$PROBE_DB" MIGRATIONS_DIR="$REPO_ROOT/db/migrations" sh "$REPO_ROOT/scripts/migrate.sh" >/tmp/probe_case1.log 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "guarded runner exited 0 with legacy meals present"
rows=$(psql -d "$PROBE_DB" -tAc "SELECT count(*) FROM meals")
[ "$rows" = "1" ] || fail "meals rows destroyed: count=$rows (expected 1)"
grep -q "refusing to run destructive migration 002" /tmp/probe_case1.log \
    || fail "expected refusal message in output"
echo "   ok: exit=$rc, meals rows intact ($rows), refusal message printed"

echo "== case 2: no meals table -> guarded runner applies 001-011"
reset_probe
REFUSE_IF_LEGACY_MEALS=1 PGDATABASE="$PROBE_DB" MIGRATIONS_DIR="$REPO_ROOT/db/migrations" sh "$REPO_ROOT/scripts/migrate.sh" >/tmp/probe_case2.log 2>&1 \
    || fail "guarded runner failed on a database without legacy meals"
psql -d "$PROBE_DB" -tAc "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='meal_events'" | grep -q 1 \
    || fail "meal_events missing after additive run"
echo "   ok: exit=0, migrations applied (meal_events present)"

echo "== case 3: env switch unset -> no guard (isolated compose db path unchanged)"
reset_probe
create_legacy_meals
PGDATABASE="$PROBE_DB" MIGRATIONS_DIR="$REPO_ROOT/db/migrations" sh "$REPO_ROOT/scripts/migrate.sh" >/tmp/probe_case3.log 2>&1 \
    || fail "unguarded runner failed (default path must replay unconditionally)"
psql -d "$PROBE_DB" -tAc "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='meals'" | grep -q 1 \
    && fail "meals table still present on unguarded run (002 should have dropped it)"
echo "   ok: unguarded run replayed 002 unconditionally (meals dropped, as designed for the throwaway volume)"

dropdb --if-exists "$PROBE_DB"
echo "ALL PROBE CASES PASSED"
