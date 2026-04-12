import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),

  BOT_TOKEN: z.string().min(1),
  WEBHOOK_PATH: z.string().default('/webhooks/max'),
  WEBHOOK_SECRET: z.string().min(8),

  DATABASE_URL: z.string().min(1),
  EXTERNAL_DATABASE_URL: z.string().min(1),

  ADMIN_MAX_IDS: z.string().default(''),
  HELP_CONTACT: z.string().default('Свяжитесь с администратором: @admin'),

  ACT_PRICE_DEFAULT_KOPECKS: z.coerce.number().int().nonnegative().default(10000),
  ACT_PRICE_VERIFIED_KOPECKS: z.coerce.number().int().nonnegative().default(0),

  ACT_STORAGE_DIR: z.string().default(path.resolve(process.cwd(), 'storage/acts')),
  OFFER_STORAGE_DIR: z.string().default(path.resolve(process.cwd(), 'storage/offers')),

  YOOKASSA_SHOP_ID: z.string().min(1),
  YOOKASSA_SECRET_KEY: z.string().min(1),
  YOOKASSA_RETURN_URL: z.string().url(),
  YOOKASSA_WEBHOOK_PATH: z.string().default('/webhooks/yookassa'),

  PGADMIN_DEFAULT_EMAIL: z.string().email().default('admin@example.com'),
  PGADMIN_DEFAULT_PASSWORD: z.string().min(8).default('ChangeMe123!'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Environment validation failed');
  console.error(parsed.error.format());
  process.exit(1);
}

const values = parsed.data;

const adminIds = new Set(
  values.ADMIN_MAX_IDS.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item)),
);

export const env = {
  ...values,
  ADMIN_IDS: adminIds,
};

export const isAdmin = (maxId: number): boolean => env.ADMIN_IDS.has(maxId);

