import { Bot } from '@maxhub/max-bot-api';
import { env } from '../config/env';
import { logger } from '../logger';
import { pool, externalPool } from '../db/pool';
import { ActGenerationQueueService } from '../services/act-generation-queue.service';
import { ensureDir } from '../utils/fs';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let stopping = false;

const run = async (): Promise<void> => {
  await ensureDir(env.ACT_STORAGE_DIR);
  await ensureDir(env.ACT_XLSX_STORAGE_DIR);

  const bot = new Bot(env.BOT_TOKEN);
  const queue = new ActGenerationQueueService(bot.api);

  logger.info('Act generation worker started');

  while (!stopping) {
    try {
      const processed = await queue.processNext();
      if (!processed) {
        await delay(env.WORKER_POLL_INTERVAL_MS);
      }
    } catch (error) {
      logger.error({ error }, 'Worker loop iteration failed');
      await delay(env.WORKER_POLL_INTERVAL_MS);
    }
  }
};

const shutdown = async (): Promise<void> => {
  stopping = true;
  await pool.end();
  await externalPool.end();
};

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

run().catch(async (error) => {
  logger.error({ error }, 'Worker startup failed');
  await shutdown();
  process.exit(1);
});
