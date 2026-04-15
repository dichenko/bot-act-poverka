#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIGRATION_NAME="006_users_profile_columns.sql"

echo "[1/4] Build and restart bot + worker..."
docker compose up -d --build bot worker

echo "[2/4] Check migration record in schema_migrations..."
applied_count="$(
  docker compose exec -T postgres sh -lc "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT COUNT(*) FROM schema_migrations WHERE version = '$MIGRATION_NAME';\""
)"
applied_count="$(echo "$applied_count" | tr -d '[:space:]')"
if [[ "$applied_count" != "1" ]]; then
  echo "ERROR: migration $MIGRATION_NAME is not applied."
  exit 1
fi
echo "OK: migration $MIGRATION_NAME is applied."

echo "[3/4] Check required columns in public.users..."
columns_count="$(
  docker compose exec -T postgres sh -lc "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('user_fullname','org_name');\""
)"
columns_count="$(echo "$columns_count" | tr -d '[:space:]')"
if [[ "$columns_count" != "2" ]]; then
  echo "ERROR: required columns are missing in public.users."
  exit 1
fi
echo "OK: columns user_fullname and org_name exist in public.users."

echo "[4/4] Tail bot logs..."
docker compose logs --tail=120 bot

echo "Done."
