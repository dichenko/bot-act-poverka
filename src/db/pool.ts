import { Pool, PoolClient } from 'pg';
import { env } from '../config/env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on('connect', (client) => {
  void client.query(`SELECT set_config('TimeZone', $1, false)`, [env.APP_TIMEZONE]);
});

export const externalPool = new Pool({
  connectionString: env.EXTERNAL_DATABASE_URL,
});

export const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

