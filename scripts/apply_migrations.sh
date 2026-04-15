#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIGRATION_NAME="006_users_profile_columns.sql"

echo "[1/5] Build and restart bot + worker..."
docker compose up -d --build bot worker

echo "[2/5] Run migrations using bot environment..."
docker compose run --rm -T --no-deps bot sh -lc 'node dist/db/migrate.js'

echo "[3/5] Check migration record in schema_migrations..."
applied_count="$(
  docker compose run --rm -T --no-deps bot sh -lc "node -e \"const { Client } = require('pg'); const dbUrl = process.env.DATABASE_URL || ('postgres://' + encodeURIComponent(process.env.POSTGRES_USER || '') + ':' + encodeURIComponent(process.env.POSTGRES_PASSWORD || '') + '@' + (process.env.POSTGRES_HOST || 'postgres') + ':' + (process.env.POSTGRES_PORT || '5432') + '/' + (process.env.POSTGRES_DB || 'postgres')); (async () => { const client = new Client({ connectionString: dbUrl }); await client.connect(); const r = await client.query(\\\"SELECT COUNT(*)::int AS c FROM schema_migrations WHERE version = '$MIGRATION_NAME'\\\"); console.log(r.rows[0].c); await client.end(); })().catch((e) => { console.error(e); process.exit(1); });\""
)"
applied_count="$(echo "$applied_count" | tr -d '[:space:]')"
if [[ "$applied_count" != "1" ]]; then
  echo "ERROR: migration $MIGRATION_NAME is not applied."
  exit 1
fi
echo "OK: migration $MIGRATION_NAME is applied."

echo "[4/5] Check required columns in public.users..."
columns_count="$(
  docker compose run --rm -T --no-deps bot sh -lc "node -e \"const { Client } = require('pg'); const dbUrl = process.env.DATABASE_URL || ('postgres://' + encodeURIComponent(process.env.POSTGRES_USER || '') + ':' + encodeURIComponent(process.env.POSTGRES_PASSWORD || '') + '@' + (process.env.POSTGRES_HOST || 'postgres') + ':' + (process.env.POSTGRES_PORT || '5432') + '/' + (process.env.POSTGRES_DB || 'postgres')); (async () => { const client = new Client({ connectionString: dbUrl }); await client.connect(); const r = await client.query(\\\"SELECT COUNT(*)::int AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name IN ('user_fullname','org_name')\\\"); console.log(r.rows[0].c); await client.end(); })().catch((e) => { console.error(e); process.exit(1); });\""
)"
columns_count="$(echo "$columns_count" | tr -d '[:space:]')"
if [[ "$columns_count" != "2" ]]; then
  echo "ERROR: required columns are missing in public.users."
  exit 1
fi
echo "OK: columns user_fullname and org_name exist in public.users."

echo "[5/5] Tail bot logs..."
docker compose logs --tail=120 bot

echo "Done."
