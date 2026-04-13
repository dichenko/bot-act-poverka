import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import type { ActDraft, BotUser } from '../types';
import { boolResultToText } from '../utils/format';
import { ensureDir, fileExists } from '../utils/fs';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const replacePlaceholders = (template: string, values: Record<string, string>): string => {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, 'g');
    result = result.replace(pattern, value);
  }
  return result;
};

export class ActTemplateService {
  private normalizePrintableText(value: string): string {
    return value.replace(/📞/g, '☎');
  }

  private getContactNumber1(user: BotUser): string {
    return user.contactNumber1.trim();
  }

  private getContactNumber2(user: BotUser): string {
    return user.contactNumber2.trim();
  }

  private formatContactNumber2WithPhoneIcon(user: BotUser): string {
    const second = this.getContactNumber2(user);
    return second ? `☎ ${second}` : '';
  }

  private composeContactNumber(user: BotUser): string {
    const parts = [this.getContactNumber1(user), this.getContactNumber2(user)]
      .filter((value) => value.length > 0);
    return parts.join('  |  ');
  }

  private async resolveTemplatePath(): Promise<string> {
    if (env.ACT_TEMPLATE_FILE && (await fileExists(env.ACT_TEMPLATE_FILE))) {
      return env.ACT_TEMPLATE_FILE;
    }

    const dir = env.ACT_TEMPLATE_DIR;
    const entries = await fs.readdir(dir);
    const xlsxFiles = entries
      .filter((name) => /\.xlsx$/i.test(name))
      .sort((a, b) => a.localeCompare(b));

    if (!xlsxFiles[0]) {
      throw new Error(`No .xlsx template found in ${dir}`);
    }

    return path.join(dir, xlsxFiles[0]);
  }

  private async renderTemplate(options: {
    templatePath: string;
    outputXlsxPath: string;
    values: Record<string, string>;
  }): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(options.templatePath);

    workbook.eachSheet((worksheet) => {
      worksheet.pageSetup = {
        ...worksheet.pageSetup,
        paperSize: 11,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        margins: {
          left: 0.15,
          right: 0.15,
          top: 0.3,
          bottom: 0.3,
          header: 0.15,
          footer: 0.15,
        },
      };

      worksheet.eachRow({ includeEmpty: true }, (row) => {
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (typeof cell.value === 'string') {
            cell.value = this.normalizePrintableText(replacePlaceholders(cell.value, options.values));
            return;
          }

          if (cell.value && typeof cell.value === 'object' && 'richText' in cell.value) {
            const richText = (cell.value as { richText?: Array<{ text?: string }> }).richText;
            if (Array.isArray(richText)) {
              for (const item of richText) {
                if (typeof item.text === 'string') {
                  item.text = this.normalizePrintableText(replacePlaceholders(item.text, options.values));
                }
              }
            }
          }
        });
      });
    });

    await workbook.xlsx.writeFile(options.outputXlsxPath);
  }

  private async convertXlsxToPdf(xlsxPath: string, outputDir: string): Promise<string> {
    await ensureDir(outputDir);

    await new Promise<void>((resolve, reject) => {
      const process = spawn(
        env.LIBREOFFICE_BIN,
        ['--headless', '--convert-to', 'pdf:calc_pdf_Export', '--outdir', outputDir, xlsxPath],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let stderr = '';
      process.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      process.on('error', (error) => {
        reject(new Error(`Failed to start LibreOffice: ${error.message}`));
      });

      process.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`LibreOffice convert failed (code ${code}): ${stderr}`));
      });
    });

    const pdfName = `${path.parse(xlsxPath).name}.pdf`;
    const pdfPath = path.join(outputDir, pdfName);
    if (!(await fileExists(pdfPath))) {
      throw new Error(`Converted PDF not found: ${pdfPath}`);
    }

    return pdfPath;
  }

  async generateActFiles(input: {
    user: BotUser;
    draft: ActDraft;
    actNumber: string;
    validUntil: string;
    priceRub: number;
  }): Promise<{ xlsxPath: string; pdfPath: string }> {
    await ensureDir(env.ACT_XLSX_STORAGE_DIR);
    const pdfDir = path.join(env.ACT_STORAGE_DIR, 'pdf');
    await ensureDir(pdfDir);

    const templatePath = await this.resolveTemplatePath();

    const filename = `act-${Date.now()}-${randomUUID()}`;
    const outputXlsxPath = path.join(env.ACT_XLSX_STORAGE_DIR, `${filename}.xlsx`);

    const placeholders: Record<string, string> = {
      act_number: input.actNumber,
      user_id: String(input.user.maxUserId),
      user_fullname: input.user.userFullname ?? '',
      org_name: input.user.orgName ?? '',
      contact_number: this.composeContactNumber(input.user),
      contact_number_1: this.getContactNumber1(input.user),
      contact_number_2: this.getContactNumber2(input.user),
      '☎ contact_number_2': this.formatContactNumber2WithPhoneIcon(input.user),
      '📞 contact_number_2': this.formatContactNumber2WithPhoneIcon(input.user),
      address: input.draft.address,
      water_type: input.draft.waterType,
      meter_model: input.draft.meterModel,
      serial_number: input.draft.serialNumber,
      current_reading: String(input.draft.currentReading),
      check_date: input.draft.checkDate,
      interval_years: String(input.draft.intervalYears),
      valid_until: input.validUntil,
      result: boolResultToText(input.draft.result),
      price_rub: String(input.priceRub),
      source: input.draft.source,
      submission_id: input.draft.submissionId != null ? String(input.draft.submissionId) : '',
    };

    await this.renderTemplate({
      templatePath,
      outputXlsxPath,
      values: placeholders,
    });

    const pdfPath = await this.convertXlsxToPdf(outputXlsxPath, pdfDir);

    return {
      xlsxPath: outputXlsxPath,
      pdfPath,
    };
  }
}

export const actTemplateService = new ActTemplateService();
