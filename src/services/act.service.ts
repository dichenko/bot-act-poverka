import { randomUUID } from 'node:crypto';
import { format } from 'date-fns';
import { withTransaction } from '../db/pool';
import { repository } from '../db/repository';
import type { ActDraft, BotUser } from '../types';
import { computeValidUntil, parseDateOrNull } from '../utils/dates';
import { actTemplateService } from './act-template.service';

export const validateDraft = (draft: Partial<ActDraft>): draft is ActDraft => {
  const checkDate = typeof draft.checkDate === 'string' ? parseDateOrNull(draft.checkDate) : null;

  return Boolean(
    draft.source &&
      draft.address &&
      draft.address.trim() &&
      (draft.waterType === 'ХВС' || draft.waterType === 'ГВС') &&
      draft.meterModel &&
      draft.meterModel.trim() &&
      draft.serialNumber &&
      draft.serialNumber.trim() &&
      typeof draft.currentReading === 'number' &&
      draft.currentReading >= 0 &&
      checkDate &&
      (draft.intervalYears === 4 || draft.intervalYears === 5 || draft.intervalYears === 6) &&
      (draft.result === 'fit' || draft.result === 'unfit'),
  );
};

export class ActService {
  private buildActNumber(): string {
    return `${new Date().getFullYear()}-${Math.floor(Math.random() * 100000)}-${randomUUID().slice(0, 6)}`;
  }

  async createAndStoreAct(input: {
    user: BotUser;
    draft: ActDraft;
    priceRub: number;
    paymentId?: number | null;
  }): Promise<{ actId: number; xlsxPath: string; pdfPath: string; actNumber: string; validUntil: string }> {
    const checkDate = parseDateOrNull(input.draft.checkDate);
    if (!checkDate) {
      throw new Error('Invalid check date in draft');
    }

    const validUntil = computeValidUntil(checkDate, input.draft.intervalYears);
    const validUntilStr = format(validUntil, 'yyyy-MM-dd');
    const actNumber = this.buildActNumber();

    const files = await actTemplateService.generateActFiles({
      user: input.user,
      draft: input.draft,
      validUntil: format(validUntil, 'dd.MM.yyyy'),
      priceRub: input.priceRub,
      actNumber,
    });

    const result = await withTransaction(async (client) => {
      const created = await repository.createAct({
        userId: input.user.id,
        source: input.draft.source,
        submissionId: input.draft.submissionId,
        draft: input.draft,
        actNumber,
        validUntil: validUntilStr,
        priceRub: input.priceRub,
        paymentId: input.paymentId ?? null,
        xlsxPath: files.xlsxPath,
        pdfPath: files.pdfPath,
        db: client,
      });

      await repository.incrementActsCount(input.user.id, client);

      return {
        actId: created.id,
        xlsxPath: files.xlsxPath,
        pdfPath: files.pdfPath,
        actNumber,
        validUntil: format(validUntil, 'dd.MM.yyyy'),
      };
    });

    return result;
  }
}

export const actService = new ActService();

