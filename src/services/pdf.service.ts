import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import type { ActDraft, BotUser } from '../types';
import { boolResultToText } from '../utils/format';
import { ensureDir } from '../utils/fs';

export class PdfService {
  async generateAct(input: {
    user: BotUser;
    draft: ActDraft;
    validUntil: string;
    priceRub: number;
    actNumber: string;
  }): Promise<string> {
    await ensureDir(env.ACT_STORAGE_DIR);

    const filename = `act-${Date.now()}-${randomUUID()}.pdf`;
    const outputPath = path.join(env.ACT_STORAGE_DIR, filename);

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const stream = fs.createWriteStream(outputPath);

      doc.pipe(stream);

      if (process.env.PDF_FONT_PATH && fs.existsSync(process.env.PDF_FONT_PATH)) {
        doc.font(process.env.PDF_FONT_PATH);
      }

      doc.fontSize(16).text('Inspection Certificate', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(11).text(`Act number: ${input.actNumber}`);
      doc.text(`Generated at: ${new Date().toISOString()}`);
      doc.moveDown(0.5);

      doc.text(`User ID: ${input.user.maxUserId}`);
      doc.text(`User full name: ${input.user.userFullname ?? '-'}`);
      doc.text(`Organization: ${input.user.orgName ?? '-'}`);
      doc.moveDown(0.6);

      doc.text(`Address: ${input.draft.address}`);
      doc.text(`Water type: ${input.draft.waterType}`);
      doc.text(`Meter model/type: ${input.draft.meterModel}`);
      doc.text(`Serial number: ${input.draft.serialNumber}`);
      doc.text(`Current reading: ${input.draft.currentReading}`);
      doc.text(`Check date: ${input.draft.checkDate}`);
      doc.text(`Inspection interval: ${input.draft.intervalYears} years`);
      doc.text(`Valid until: ${input.validUntil}`);
      doc.text(`Result: ${boolResultToText(input.draft.result)}`);
      doc.text(`Price paid: ${input.priceRub} RUB`);

      doc.moveDown(2);
      doc.text('This document is generated automatically by MAX bot.', { align: 'left' });

      doc.end();

      stream.on('finish', () => resolve());
      stream.on('error', reject);
    });

    return outputPath;
  }

  async removeFile(filePath: string): Promise<void> {
    try {
      await fsp.unlink(filePath);
    } catch {
      // ignored
    }
  }
}

export const pdfService = new PdfService();

