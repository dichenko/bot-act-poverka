import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from './pool';
import { logger } from '../logger';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const migrationLockKey = 'bot_act_poverka_schema_migrations';

const ensureMigrationsTable = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const getAppliedVersions = async (client: PoolClient): Promise<Set<string>> => {
  const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => row.version));
};

const run = async (): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [migrationLockKey]);

    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const rawSql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      const sql = rawSql.replace(/^\uFEFF/, '');
      logger.info({ file }, 'Applying migration');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ file }, 'Migration applied');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error({ error, file }, 'Migration failed');
        throw error;
      }
    }

    logger.info('Migrations complete');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLockKey]).catch((error) => {
      logger.warn({ error }, 'Failed to release migration advisory lock');
    });
    client.release();
  }
};

run()
  .catch((error) => {
    logger.error({ error }, 'Migration run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
