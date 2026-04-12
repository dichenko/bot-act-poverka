import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { repository } from '../db/repository';
import { pool, externalPool } from '../db/pool';
import { logger } from '../logger';
import { ActGenerationQueueService } from '../services/act-generation-queue.service';
import type { ActDraft } from '../types';
import { todayDateString } from '../utils/dates';
import { ensureDir, fileExists } from '../utils/fs';
import { env } from '../config/env';

const TEST_MAX_USER_ID = Number(process.env.TEST_MAX_USER_ID ?? 990000001);
const TEST_PRICE_RUB = Number(process.env.TEST_PRICE_RUB ?? 0);

const createTemplateIfMissing = async (): Promise<string> => {
  await ensureDir(env.ACT_TEMPLATE_DIR);

  if (env.ACT_TEMPLATE_FILE && (await fileExists(env.ACT_TEMPLATE_FILE))) {
    return env.ACT_TEMPLATE_FILE;
  }

  const files = await fs.readdir(env.ACT_TEMPLATE_DIR);
  const existing = files.find((name) => /\.xlsx$/i.test(name));
  if (existing) {
    return path.join(env.ACT_TEMPLATE_DIR, existing);
  }

  const templatePath = path.join(env.ACT_TEMPLATE_DIR, 'test-act-template.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Act');

  sheet.getCell('A1').value = 'Act #{{act_number}}';
  sheet.getCell('A2').value = 'Address: {{address}}';
  sheet.getCell('A3').value = 'Water type: {{water_type}}';
  sheet.getCell('A4').value = 'Meter model: {{meter_model}}';
  sheet.getCell('A5').value = 'Serial number: {{serial_number}}';
  sheet.getCell('A6').value = 'Current reading: {{current_reading}}';
  sheet.getCell('A7').value = 'Check date: {{check_date}}';
  sheet.getCell('A8').value = 'Valid until: {{valid_until}}';
  sheet.getCell('A9').value = 'Result: {{result}}';
  sheet.getCell('A10').value = 'Price: {{price_rub}} RUB';

  await workbook.xlsx.writeFile(templatePath);
  return templatePath;
};

const run = async (): Promise<void> => {
  if (!Number.isFinite(TEST_MAX_USER_ID)) {
    throw new Error('TEST_MAX_USER_ID must be a valid number');
  }

  await ensureDir(env.ACT_STORAGE_DIR);
  await ensureDir(env.ACT_XLSX_STORAGE_DIR);

  const templatePath = await createTemplateIfMissing();
  logger.info({ templatePath }, 'Template ready');

  await repository.ensurePrices();

  const user = await repository.upsertUserByMaxId({
    maxUserId: TEST_MAX_USER_ID,
    username: 'test_user',
    firstName: 'Test User',
    lastName: null,
  });

  const draft: ActDraft = {
    source: 'manual',
    address: 'Test address, 1',
    waterType: 'ХВС',
    meterModel: 'Test Meter Model',
    serialNumber: `TEST-${Date.now()}`,
    currentReading: 123.45,
    checkDate: todayDateString(),
    intervalYears: 4,
    result: 'fit',
  };

  const pending = await repository.createPendingAct({
    userId: user.id,
    source: 'manual',
    draft,
    priceRub: TEST_PRICE_RUB,
    status: 'paid',
  });

  const job = await repository.enqueueActGenerationJob({
    userId: user.id,
    pendingActId: pending.id,
    draft,
    priceRub: TEST_PRICE_RUB,
  });

  logger.info({ pendingActId: pending.id, jobId: job.id }, 'Test generation request created');

  const queue = new ActGenerationQueueService();
  const processed = await queue.processNext({ notifyUser: false });

  if (!processed) {
    throw new Error('Queue did not process any job');
  }

  const finalJob = await repository.getActGenerationJobById(job.id);
  if (!finalJob) {
    throw new Error('Final job record not found');
  }

  if (finalJob.status !== 'completed') {
    throw new Error(`Job status is ${finalJob.status}. Error: ${finalJob.errorMessage ?? 'unknown'}`);
  }

  const xlsxExists = finalJob.xlsxPath ? await fileExists(finalJob.xlsxPath) : false;
  const pdfExists = finalJob.pdfPath ? await fileExists(finalJob.pdfPath) : false;

  console.log('TEST_ACT_RESULT');
  console.log(`job_id=${finalJob.id}`);
  console.log(`status=${finalJob.status}`);
  console.log(`xlsx_path=${finalJob.xlsxPath ?? ''}`);
  console.log(`xlsx_exists=${xlsxExists}`);
  console.log(`pdf_path=${finalJob.pdfPath ?? ''}`);
  console.log(`pdf_exists=${pdfExists}`);

  if (!xlsxExists || !pdfExists) {
    throw new Error('One or both output files are missing');
  }
};

run()
  .catch((error) => {
    logger.error({ error }, 'test-act-generation failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await externalPool.end();
  });
