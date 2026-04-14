import { Pool, PoolClient } from 'pg';
import { env } from '../config/env';

const withTimezoneOption = (connectionString: string): string => {
  try {
    const parsed = new URL(connectionString);
    const timezoneOption = `-c TimeZone=${env.APP_TIMEZONE}`;
    const existingOptions = parsed.searchParams.get('options');
    if (!existingOptions) {
      parsed.searchParams.set('options', timezoneOption);
      return parsed.toString();
    }

    if (!existingOptions.includes('TimeZone=')) {
      parsed.searchParams.set('options', `${existingOptions} ${timezoneOption}`);
    }

    return parsed.toString();
  } catch {
    return connectionString;
  }
};

export const pool = new Pool({
  connectionString: withTimezoneOption(env.DATABASE_URL),
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
