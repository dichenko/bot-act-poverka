import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './pool';
import { logger } from '../logger';

const migrationsDir = path.resolve(process.cwd(), 'migrations');

const ensureMigrationsTable = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const getAppliedVersions = async (): Promise<Set<string>> => {
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => row.version));
};

const run = async (): Promise<void> => {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    logger.info({ file }, 'Applying migration');

    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      logger.info({ file }, 'Migration applied');
    } catch (error) {
      await pool.query('ROLLBACK');
      logger.error({ error, file }, 'Migration failed');
      throw error;
    }
  }

  logger.info('Migrations complete');
};

run()
  .catch((error) => {
    logger.error({ error }, 'Migration run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

