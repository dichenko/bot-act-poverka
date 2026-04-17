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

  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().default('postgres'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  EXTERNAL_DATABASE_URL: z.string().min(1),

  ADMIN_MAX_IDS: z.string().default(''),

  ACT_STORAGE_DIR: z.string().default(path.resolve(process.cwd(), 'storage/acts')),
  OFFER_STORAGE_DIR: z.string().default(path.resolve(process.cwd(), 'storage/offers')),
  ACT_TEMPLATE_DIR: z.string().default(path.resolve(process.cwd(), 'template')),
  ACT_TEMPLATE_FILE: z.string().optional(),
  ACT_XLSX_STORAGE_DIR: z.string().default(path.resolve(process.cwd(), 'storage/acts/xlsx')),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  LIBREOFFICE_BIN: z.string().default('soffice'),
  APP_TIMEZONE: z.string().default('Europe/Moscow'),
  CLEANUP_STORAGE_ROOT: z.string().default(path.resolve(process.cwd(), 'storage')),
  CLEANUP_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  CLEANUP_RUN_HOUR: z.coerce.number().int().min(0).max(23).default(3),

  YOOKASSA_SHOP_ID: z.string().min(1),
  YOOKASSA_SECRET_KEY: z.string().min(1),
  YOOKASSA_RETURN_URL: z.string().url(),
  YOOKASSA_WEBHOOK_PATH: z.string().default('/webhooks/yookassa'),
  YOOKASSA_RECEIPT_EMAIL: z.string().email().default('noreply@example.com'),
  YOOKASSA_RECEIPT_VAT_CODE: z.coerce.number().int().min(1).max(6).default(1),

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

const databaseUrl =
  values.DATABASE_URL ??
  `postgres://${encodeURIComponent(values.POSTGRES_USER)}:${encodeURIComponent(values.POSTGRES_PASSWORD)}@${values.POSTGRES_HOST}:${values.POSTGRES_PORT}/${values.POSTGRES_DB}`;

const adminIds = new Set(
  values.ADMIN_MAX_IDS.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item)),
);

export const env = {
  ...values,
  DATABASE_URL: databaseUrl,
  ADMIN_IDS: adminIds,
};

export const isAdmin = (maxId: number): boolean => env.ADMIN_IDS.has(maxId);

