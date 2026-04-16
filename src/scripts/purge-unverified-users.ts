import { pool } from '../db/pool';
import { logger } from '../logger';

type PurgeStats = {
  users: number;
  sessions: number;
  payments: number;
  pendingActs: number;
  acts: number;
  generationJobs: number;
};

const parseCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const loadPurgeStats = async (): Promise<PurgeStats> => {
  const { rows } = await pool.query<{
    users: string;
    sessions: string;
    payments: string;
    pending_acts: string;
    acts: string;
    generation_jobs: string;
  }>(
    `
    WITH target_users AS (
      SELECT id
      FROM users
      WHERE verified = FALSE
    )
    SELECT
      (SELECT COUNT(*)::text FROM target_users) AS users,
      (SELECT COUNT(*)::text FROM user_sessions WHERE user_id IN (SELECT id FROM target_users)) AS sessions,
      (SELECT COUNT(*)::text FROM payments WHERE user_id IN (SELECT id FROM target_users)) AS payments,
      (SELECT COUNT(*)::text FROM pending_acts WHERE user_id IN (SELECT id FROM target_users)) AS pending_acts,
      (SELECT COUNT(*)::text FROM acts WHERE user_id IN (SELECT id FROM target_users)) AS acts,
      (SELECT COUNT(*)::text FROM act_generation_jobs WHERE user_id IN (SELECT id FROM target_users)) AS generation_jobs
    `,
  );

  const row = rows[0];
  return {
    users: parseCount(row?.users),
    sessions: parseCount(row?.sessions),
    payments: parseCount(row?.payments),
    pendingActs: parseCount(row?.pending_acts),
    acts: parseCount(row?.acts),
    generationJobs: parseCount(row?.generation_jobs),
  };
};

const purgeUnverifiedUsers = async (): Promise<number> => {
  const { rows } = await pool.query<{ users_deleted: string }>(
    `
    WITH target_users AS (
      SELECT id
      FROM users
      WHERE verified = FALSE
    ),
    deleted_users AS (
      DELETE FROM users
      WHERE id IN (SELECT id FROM target_users)
      RETURNING id
    )
    SELECT COUNT(*)::text AS users_deleted FROM deleted_users
    `,
  );

  return parseCount(rows[0]?.users_deleted);
};

const run = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'apply' : 'dry-run';

  const before = await loadPurgeStats();
  logger.info({ mode, before }, 'Unverified users cleanup summary');

  if (!apply) {
    logger.info('Dry-run mode. No changes applied. Re-run with --apply to delete non-verified users.');
    return;
  }

  if (before.users === 0) {
    logger.info('No non-verified users found. Nothing to delete.');
    return;
  }

  const deletedUsers = await purgeUnverifiedUsers();
  const after = await loadPurgeStats();

  logger.info({ deletedUsers, after }, 'Unverified users purge completed');

  if (after.users > 0) {
    throw new Error('Purge completed with residual non-verified users in DB.');
  }
};

run()
  .catch((error) => {
    logger.error({ error }, 'purge-unverified-users failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
