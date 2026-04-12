import type { Api } from '@maxhub/max-bot-api';
import { repository } from '../db/repository';
import { logger } from '../logger';
import { actService, validateDraft } from './act.service';
import { sendFileToUser } from '../bot/ui';

type ProcessOptions = {
  notifyUser?: boolean;
};

export class ActGenerationQueueService {
  constructor(private readonly api?: Api) {}

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
        await this.api.sendMessageToUser(user.maxUserId, 'Act created successfully.');
        await sendFileToUser(this.api, user.maxUserId, act.pdfPath, `Act #${act.actNumber}`);
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
          'Act generation failed. Administrator has been notified. Please try again later.',
        );
      }

      logger.error({ error, jobId: job.id }, 'Act generation job failed');
      return true;
    }
  }
}
