import express from 'express';
import { env } from './config/env';
import { logger } from './logger';
import { maxBotService } from './bot/max-bot.service';
import { ensureDir } from './utils/fs';
import { pool, externalPool } from './db/pool';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bot' });
});

app.get('/db-health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'internal' });
  } catch (error) {
    logger.error({ error }, 'DB health failed');
    res.status(500).json({ ok: false });
  }
});

app.post(env.WEBHOOK_PATH, async (req, res) => {
  const secret = req.header('x-webhook-secret');
  if (secret !== env.WEBHOOK_SECRET) {
    res.status(401).json({ ok: false });
    return;
  }

  try {
    await maxBotService.handleWebhookUpdate(req.body);
    res.json({ ok: true });
  } catch (error) {
    logger.error({ error }, 'MAX webhook failed');
    res.status(500).json({ ok: false });
  }
});

app.post(env.YOOKASSA_WEBHOOK_PATH, async (req, res) => {
  try {
    await maxBotService.handleYooKassaWebhook(req.body);
    res.json({ ok: true });
  } catch (error) {
    logger.error({ error }, 'YooKassa webhook failed');
    res.status(500).json({ ok: false });
  }
});

const start = async (): Promise<void> => {
  await ensureDir(env.ACT_STORAGE_DIR);
  await ensureDir(env.OFFER_STORAGE_DIR);

  await maxBotService.init();

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Bot webhook server started');
  });
};

start().catch((error) => {
  logger.error({ error }, 'Startup failed');
  process.exit(1);
});

const shutdown = async (): Promise<void> => {
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

