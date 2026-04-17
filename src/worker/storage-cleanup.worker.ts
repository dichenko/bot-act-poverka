import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../logger';

type CleanupStats = {
  scannedFiles: number;
  deletedFiles: number;
  skippedEntries: number;
  errors: number;
};

let stopping = false;
let sleepTimer: NodeJS.Timeout | null = null;
let sleepResolve: (() => void) | null = null;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      sleepResolve = null;
      resolve();
    }, ms);
  });

const interruptSleep = (): void => {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  if (sleepResolve) {
    sleepResolve();
    sleepResolve = null;
  }
};

const msUntilNextRun = (hour: number): number => {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hour, 0, 0, 0);
  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  return nextRun.getTime() - now.getTime();
};

const collectAndDeleteOldFiles = async (directory: string, cutoffMs: number, stats: CleanupStats): Promise<void> => {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    stats.errors += 1;
    logger.warn({ error, directory }, 'Failed to read directory during cleanup');
    return;
  }

  for (const entry of entries) {
    if (stopping) {
      return;
    }

    const entryPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      stats.skippedEntries += 1;
      continue;
    }

    if (entry.isDirectory()) {
      await collectAndDeleteOldFiles(entryPath, cutoffMs, stats);
      continue;
    }

    if (!entry.isFile()) {
      stats.skippedEntries += 1;
      continue;
    }

    stats.scannedFiles += 1;

    try {
      const fileStat = await fs.stat(entryPath);
      if (fileStat.mtimeMs <= cutoffMs) {
        await fs.unlink(entryPath);
        stats.deletedFiles += 1;
      }
    } catch (error) {
      stats.errors += 1;
      logger.warn({ error, entryPath }, 'Failed to process file during cleanup');
    }
  }
};

const runCleanupOnce = async (): Promise<void> => {
  const retentionMs = env.CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - retentionMs;

  const stats: CleanupStats = {
    scannedFiles: 0,
    deletedFiles: 0,
    skippedEntries: 0,
    errors: 0,
  };

  await fs.mkdir(env.CLEANUP_STORAGE_ROOT, { recursive: true });

  await collectAndDeleteOldFiles(env.CLEANUP_STORAGE_ROOT, cutoffMs, stats);

  logger.info(
    {
      cleanupRoot: env.CLEANUP_STORAGE_ROOT,
      retentionDays: env.CLEANUP_RETENTION_DAYS,
      cutoffIso: new Date(cutoffMs).toISOString(),
      stats,
    },
    'Storage cleanup run finished',
  );
};

const run = async (): Promise<void> => {
  logger.info(
    {
      cleanupRoot: env.CLEANUP_STORAGE_ROOT,
      retentionDays: env.CLEANUP_RETENTION_DAYS,
      runHour: env.CLEANUP_RUN_HOUR,
      timezone: env.APP_TIMEZONE,
    },
    'Storage cleanup worker started',
  );

  while (!stopping) {
    const waitMs = msUntilNextRun(env.CLEANUP_RUN_HOUR);
    const nextRunAt = new Date(Date.now() + waitMs);
    logger.info({ nextRunAt: nextRunAt.toISOString() }, 'Storage cleanup worker sleeping until next run');

    await delay(waitMs);
    if (stopping) {
      break;
    }

    try {
      await runCleanupOnce();
    } catch (error) {
      logger.error({ error }, 'Storage cleanup run failed');
    }
  }
};

const shutdown = (): void => {
  stopping = true;
  interruptSleep();
};

process.on('SIGTERM', () => {
  shutdown();
});

process.on('SIGINT', () => {
  shutdown();
});

run().catch((error) => {
  logger.error({ error }, 'Storage cleanup worker failed');
  process.exit(1);
});
