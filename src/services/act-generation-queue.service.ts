import type { Api } from '@maxhub/max-bot-api';
import { repository } from '../db/repository';
import { logger } from '../logger';
import { menuKeyboard, sendFileToUser } from '../bot/ui';
import { formatRub } from '../utils/format';
import { actService, validateDraft } from './act.service';

type ProcessOptions = {
  notifyUser?: boolean;
};

export class ActGenerationQueueService {
  constructor(private readonly api?: Api) {}

  private async sendHomeMenu(maxUserId: number): Promise<void> {
    if (!this.api) {
      return;
    }

    const user = await repository.getUserByMaxId(maxUserId);
    if (!user) {
      return;
    }

    const prices = await repository.getPrices();
    const price = user.verified ? prices.verifiedPrice : prices.defaultPrice;
    const text = [
      `Ваш MAX ID: ${user.maxUserId}`,
      `Баланс: ${formatRub(user.balanceRub)}`,
      `Всего создано актов: ${user.actsCount}`,
      `Текущая цена для пользователя: ${formatRub(price)}`,
    ].join('\n');

    await this.api.sendMessageToUser(maxUserId, text, {
      attachments: [menuKeyboard(user.verified)],
    });
  }

  async processNext(options: ProcessOptions = {}): Promise<boolean> {
    const notifyUser = options.notifyUser ?? true;
    const job = await repository.lockNextQueuedActGenerationJob();
    if (!job) {
      return false;
    }

    try {
      const user = await repository.getUserById(job.userId);
      if (!user) {
        throw new Error(`User not found for job ${job.id}`);
      }

      if (!validateDraft(job.draft)) {
        throw new Error(`Invalid draft for job ${job.id}`);
      }

      const act = await actService.createAndStoreAct({
        user,
        draft: job.draft,
        priceRub: job.priceRub,
        paymentId: job.paymentId,
      });

      await repository.markActGenerationJobCompleted({
        jobId: job.id,
        xlsxPath: act.xlsxPath,
        pdfPath: act.pdfPath,
      });

      if (job.pendingActId) {
        await repository.setPendingActStatus(job.pendingActId, 'completed');
      }

      if (notifyUser && this.api) {
        await this.api.sendMessageToUser(user.maxUserId, 'Акт успешно сформирован.');
        await sendFileToUser(this.api, user.maxUserId, act.pdfPath, `Акт №${act.actNumber}`);
        await this.sendHomeMenu(user.maxUserId);
      }

      logger.info({ jobId: job.id, actId: act.actId }, 'Act generation job completed');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.markActGenerationJobFailed(job.id, message);

      if (job.pendingActId) {
        await repository.setPendingActStatus(job.pendingActId, 'paid');
      }

      const user = await repository.getUserById(job.userId);
      if (notifyUser && this.api && user) {
        await this.api.sendMessageToUser(
          user.maxUserId,
          'Не удалось сформировать акт. Администратор уведомлен. Попробуйте позже.',
        );
        await this.sendHomeMenu(user.maxUserId);
      }

      logger.error({ error, jobId: job.id }, 'Act generation job failed');
      return true;
    }
  }
}
