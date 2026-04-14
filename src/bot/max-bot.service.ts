import fs from 'node:fs/promises';
import path from 'node:path';
import { Bot, Context, Keyboard } from '@maxhub/max-bot-api';
import { env, isAdmin } from '../config/env';
import { repository } from '../db/repository';
import { externalSubmissionService } from '../integrations/external/submission.service';
import { yooKassaClient, YooWebhookEvent } from '../integrations/yookassa/client';
import { logger } from '../logger';
import { validateDraft } from '../services/act.service';
import type { ActDraft, BotUser, UserSession } from '../types';
import { computeValidUntil, isFutureDate, parseDateOrNull, toDateView, todayDateString } from '../utils/dates';
import { formatRub } from '../utils/format';
import { CB, historyPayload } from './callbacks';
import { cancelKeyboard, makeKeyboard, menuKeyboard, sendFileToUser, summarizeHistoryItem } from './ui';
import { fileExists } from '../utils/fs';

const ADMIN_HELP_TEXT = [
  'Вы авторизованы как администратор.',
  '',
  'Доступные команды:',
  '/start - показать эту справку',
  '/stats - статистика (день/месяц/всего)',
  '/setprice {rub} - цена для обычных пользователей',
  '/setprice_verified {rub} - цена для verified-пользователей',
  '/user {max_user_id} - карточка пользователя',
  '/refund {payment_id} - возврат через YooKassa',
  '/addbalance {max_user_id} {amount_rub} - пополнение баланса вручную',
  '/broadcast {text} - рассылка текста всем пользователям',
  '/new_oferta - загрузка новой оферты и запуск переакцепта',
].join('\n');

const HELP_CONTACT_HTML_PLACEHOLDER =
  '<b>HELP_PLACEHOLDER</b>\n<i>Здесь будет HTML-текст с контактами администратора.</i>';

type IncomingIdentity = {
  maxUserId: number;
  name: string | null;
  username: string | null;
};

export class MaxBotService {
  readonly bot: Bot;

  constructor() {
    this.bot = new Bot(env.BOT_TOKEN);

    this.bot.on('bot_started', async (ctx) => {
      await this.wrapHandler(ctx, () => this.onBotStarted(ctx));
    });

    this.bot.on('message_created', async (ctx) => {
      await this.wrapHandler(ctx, () => this.onMessage(ctx));
    });

    this.bot.on('message_callback', async (ctx) => {
      await this.wrapHandler(ctx, () => this.onCallback(ctx));
    });

    this.bot.catch(async (error, ctx) => {
      logger.error({ error, update: ctx.update }, 'Unhandled bot error');
      if (ctx.user?.user_id) {
        await this.bot.api.sendMessageToUser(ctx.user.user_id, 'Внутренняя ошибка. Попробуйте позже.');
      }
    });
  }

  async init(): Promise<void> {
    await repository.ensurePrices();

    await this.bot.api.setMyCommands([
      { name: 'start', description: 'Открыть главное меню' },
      { name: 'help', description: 'Контакты поддержки' },
    ]);
  }

  async handleWebhookUpdate(update: unknown): Promise<void> {
    await (this.bot as unknown as { handleUpdate: (value: unknown) => Promise<void> }).handleUpdate(update);
  }

  async handleYooKassaWebhook(payload: YooWebhookEvent): Promise<void> {
    const providerPaymentId = payload?.object?.id;
    if (!providerPaymentId) {
      return;
    }

    const payment = await repository.getPaymentByProviderId(providerPaymentId);
    if (!payment) {
      logger.warn({ providerPaymentId }, 'Payment not found for webhook');
      return;
    }

    const event = payload.event;
    if (event === 'payment.succeeded') {
      if (payment.status === 'succeeded') {
        return;
      }

      await repository.updatePaymentStatusByProviderId(providerPaymentId, 'succeeded', {
        webhook_event: event,
      });

      if (payment.kind === 'top_up') {
        await repository.changeBalance(payment.userId, payment.amountRub);
        const user = await repository.getUserById(payment.userId);
        if (user) {
          await this.bot.api.sendMessageToUser(
            user.maxUserId,
            `Платеж успешно завершен. Баланс пополнен на ${formatRub(payment.amountRub)}.`,
          );
          await this.sendHomeScreen(user.maxUserId);
        }
      }

      if (payment.kind === 'one_time') {
        const pendingActId = Number(payment.metadata.pending_act_id ?? 0);
        if (!Number.isFinite(pendingActId) || pendingActId <= 0) {
          return;
        }

        const pendingAct = await repository.getPendingAct(pendingActId);
        if (!pendingAct || pendingAct.status === 'completed') {
          return;
        }

        await repository.setPendingActStatus(pendingAct.id, 'paid');
        const user = await repository.getUserById(pendingAct.userId);
        if (!user) {
          return;
        }

        const draft = pendingAct.draft;
        if (!validateDraft(draft)) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Не удалось распознать все обязательные поля. Попробуйте еще раз.');
          await this.sendHomeScreen(user.maxUserId);
          return;
        }

        await repository.enqueueActGenerationJob({
          userId: user.id,
          pendingActId: pendingAct.id,
          draft: pendingAct.draft,
          priceRub: pendingAct.priceRub,
          paymentId: payment.id,
        });

        await this.bot.api.sendMessageToUser(
          user.maxUserId,
          'Платеж успешно завершен. Заявка на акт поставлена в очередь на генерацию.',
        );
        await this.sendHomeScreen(user.maxUserId);
      }
    }

    if (event !== 'payment.succeeded') {
      await repository.updatePaymentStatusByProviderId(providerPaymentId, 'failed', {
        webhook_event: event,
      });

      const user = await repository.getUserById(payment.userId);
      if (user) {
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Платеж не прошел.');
        await this.sendHomeScreen(user.maxUserId);
      }
    }
  }

  private async wrapHandler(ctx: Context, handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch (error) {
      logger.error({ error, update: ctx.update }, 'Handler failed');
      const userId = ctx.user?.user_id ?? ctx.callback?.user?.user_id;
      if (userId) {
        await this.bot.api.sendMessageToUser(userId, 'Внутренняя ошибка. Попробуйте позже.');
      }
    }
  }

  private parseIdentity(ctx: Context): IncomingIdentity | null {
    const user = ctx.user ?? ctx.callback?.user;
    if (!user) {
      return null;
    }

    return {
      maxUserId: user.user_id,
      name: user.name ?? null,
      username: user.username ?? null,
    };
  }

  private async syncUser(ctx: Context): Promise<BotUser | null> {
    const identity = this.parseIdentity(ctx);
    if (!identity) {
      return null;
    }

    return repository.upsertUserByMaxId({
      maxUserId: identity.maxUserId,
      firstName: identity.name,
      username: identity.username,
      lastName: null,
    });
  }

  private parseText(ctx: Context): string {
    return ctx.message?.body?.text?.trim() ?? '';
  }

  private parseCommand(text: string): { command: string; args: string[] } | null {
    if (!text.startsWith('/')) {
      return null;
    }

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();
    return { command, args };
  }

  private extractSubmissionId(payload: string | null | undefined): number | null {
    if (!payload) {
      return null;
    }

    const match = payload.match(/\d+/);
    if (!match) {
      return null;
    }

    const value = Number(match[0]);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    return value;
  }

  private async sendAdminHelp(maxUserId: number): Promise<void> {
    const current = await repository.getCurrentOffer();
    const versionText = current?.version ?? 'не опубликована';
    const text = `${ADMIN_HELP_TEXT}\n\nТекущая версия оферты: ${versionText}`;
    await this.bot.api.sendMessageToUser(maxUserId, text);
  }

  private async sendHomeScreen(maxUserId: number): Promise<void> {
    const user = await repository.getUserByMaxId(maxUserId);
    if (!user) {
      return;
    }

    if (isAdmin(user.maxUserId)) {
      await this.sendAdminHelp(user.maxUserId);
      return;
    }

    const offerAllowed = await this.enforceOffer(user);
    if (!offerAllowed) {
      return;
    }

    await this.showMainMenu(user.maxUserId);
  }

  private async onBotStarted(ctx: Context): Promise<void> {
    const user = await this.syncUser(ctx);
    if (!user) {
      return;
    }

    if (isAdmin(user.maxUserId)) {
      await this.sendAdminHelp(user.maxUserId);
      return;
    }

    await this.handleStart(user, ctx.startPayload ?? undefined);
  }

  private async onMessage(ctx: Context): Promise<void> {
    const user = await this.syncUser(ctx);
    if (!user) {
      return;
    }

    const text = this.parseText(ctx);
    const command = this.parseCommand(text);

    if (isAdmin(user.maxUserId)) {
      await this.handleAdminMessage(user, text, command, ctx);
      return;
    }

    if (command?.command === '/start') {
      const payload = command.args[0];
      await this.handleStart(user, payload);
      return;
    }

    const offerAllowed = await this.enforceOffer(user);
    if (!offerAllowed) {
      return;
    }

    if (command?.command === '/help') {
      await this.sendHelpContact(user.maxUserId);
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    const session = await repository.getSession(user.id);
    if (session.state !== 'idle') {
      await this.handleSessionText(user, text, session);
      return;
    }

    await this.sendHomeScreen(user.maxUserId);
  }

  private async onCallback(ctx: Context): Promise<void> {
    const user = await this.syncUser(ctx);
    if (!user) {
      return;
    }

    const payload = ctx.callback?.payload ?? '';
    if (!payload) {
      return;
    }

    await this.answerCallbackSafe(ctx);

    if (payload === CB.ACCEPT_OFFER) {
      await this.acceptOffer(user);
      return;
    }

    if (payload === CB.DECLINE_OFFER) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Вы отказались от оферты. Основные функции заблокированы.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    if (isAdmin(user.maxUserId) && payload === CB.CANCEL) {
      await repository.clearSession(user.id);
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Операция отменена пользователем.');
      await this.sendAdminHelp(user.maxUserId);
      return;
    }

    if (isAdmin(user.maxUserId)) {
      return;
    }

    const offerAllowed = await this.enforceOffer(user);
    if (!offerAllowed) {
      return;
    }

    if (payload === CB.CANCEL) {
      await repository.clearSession(user.id);
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Операция отменена пользователем.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    const session = await repository.getSession(user.id);

    if (payload.startsWith(CB.HISTORY_PREFIX)) {
      const actId = Number(payload.replace(CB.HISTORY_PREFIX, ''));
      await this.sendHistoryFile(user, actId);
      return;
    }

    await this.handleCallbackByPayload(user, payload, session);
  }
  private async answerCallbackSafe(ctx: Context): Promise<void> {
    try {
      await ctx.answerOnCallback({ notification: 'OK' });
    } catch {
      // ignored
    }
  }

  private async handleStart(user: BotUser, payload?: string): Promise<void> {
    const submissionId = this.extractSubmissionId(payload);

    const offer = await repository.getCurrentOffer();
    if (offer && user.acceptedOfferVersion !== offer.version) {
      await repository.setSession(user.id, 'idle', submissionId ? { pendingSubmissionId: submissionId } : {});
      await this.sendOfferForAcceptance(user.maxUserId, offer.version, offer.filePath);
      return;
    }

    if (submissionId) {
      await this.runSubmissionImport(user, submissionId);
      return;
    }

    await this.sendHomeScreen(user.maxUserId);
  }

  private async enforceOffer(user: BotUser): Promise<boolean> {
    const current = await repository.getCurrentOffer();
    if (!current) {
      return true;
    }

    if (user.acceptedOfferVersion === current.version) {
      return true;
    }

    await this.sendOfferForAcceptance(user.maxUserId, current.version, current.filePath);
    return false;
  }

  private async sendOfferForAcceptance(maxUserId: number, version: string, filePath: string): Promise<void> {
    if (await fileExists(filePath)) {
      await sendFileToUser(this.bot.api, maxUserId, filePath, `Текущая версия оферты: ${version}`);
    }

    await this.bot.api.sendMessageToUser(maxUserId, `Для продолжения необходимо принять оферту версии ${version}.`, {
      attachments: [
        makeKeyboard([
          [{ text: '✅ Принять оферту', payload: CB.ACCEPT_OFFER, intent: 'positive' }],
          [{ text: '❌ Отказаться', payload: CB.DECLINE_OFFER, intent: 'negative' }],
        ]),
      ],
    });
  }

  private async acceptOffer(user: BotUser): Promise<void> {
    const current = await repository.getCurrentOffer();
    if (!current) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Текущая оферта не опубликована.');
      return;
    }

    await repository.acceptOffer(user.id, current.version);
    await this.bot.api.sendMessageToUser(user.maxUserId, 'Оферта успешно принята.');

    const session = await repository.getSession(user.id);
    const pendingSubmissionId = Number(session.data.pendingSubmissionId ?? 0);
    if (Number.isFinite(pendingSubmissionId) && pendingSubmissionId > 0) {
      await repository.clearSession(user.id);
      const refreshed = await repository.getUserById(user.id);
      if (refreshed) {
        await this.runSubmissionImport(refreshed, pendingSubmissionId);
        return;
      }
    }

    await this.sendHomeScreen(user.maxUserId);
  }

  private async showMainMenu(maxUserId: number): Promise<void> {
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
      `Цена акта: ${formatRub(price)}`,
    ].join('\n');

    await this.bot.api.sendMessageToUser(maxUserId, text, {
      attachments: [menuKeyboard(user.verified)],
    });
  }

  private async sendHelpContact(maxUserId: number): Promise<void> {
    await this.bot.api.sendMessageToUser(maxUserId, HELP_CONTACT_HTML_PLACEHOLDER, {
      format: 'html',
    });
  }

  private async handleSessionText(user: BotUser, text: string, session: UserSession): Promise<void> {
    switch (session.state) {
      case 'manual_address': {
        if (!text) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Адрес не может быть пустым.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const draft: Partial<ActDraft> = {
          ...(session.data.draft as Partial<ActDraft>),
          source: 'manual',
          address: text,
        };

        await repository.setSession(user.id, 'manual_water_type', { draft });
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Выберите тип воды:', {
          attachments: [
            makeKeyboard([
              [
                { text: '🚰 ХВС', payload: CB.WATER_HVS },
                { text: '♨️ ГВС', payload: CB.WATER_GVS },
              ],
              [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
            ]),
          ],
        });
        return;
      }

      case 'manual_meter_model': {
        if (!text) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Модель/тип счетчика не может быть пустой.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const draft = {
          ...(session.data.draft as Partial<ActDraft>),
          meterModel: text,
        };
        await repository.setSession(user.id, 'manual_serial', { draft });
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Введите серийный номер:', {
          attachments: [cancelKeyboard()],
        });
        return;
      }

      case 'manual_serial': {
        if (!text) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Серийный номер не может быть пустым.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const draft = {
          ...(session.data.draft as Partial<ActDraft>),
          serialNumber: text,
        };
        await repository.setSession(user.id, 'manual_reading', { draft });
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Введите текущее показание (число, >= 0):', {
          attachments: [cancelKeyboard()],
        });
        return;
      }

      case 'manual_reading': {
        const value = Number(text.replace(',', '.'));
        if (!Number.isFinite(value) || value < 0) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Текущее показание должно быть числом и >= 0.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const draft = {
          ...(session.data.draft as Partial<ActDraft>),
          currentReading: value,
        };

        await repository.setSession(user.id, 'manual_check_date', { draft });
        await this.bot.api.sendMessageToUser(
          user.maxUserId,
          `Введите дату поверки в формате ДД.ММ.ГГГГ (сегодня: ${todayDateString()}).`,
          {
            attachments: [cancelKeyboard()],
          },
        );
        return;
      }

      case 'manual_check_date': {
        const parsed = parseDateOrNull(text);
        if (!parsed || isFutureDate(parsed)) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Дата поверки должна быть корректной и не в будущем.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const draft = {
          ...(session.data.draft as Partial<ActDraft>),
          checkDate: toDateView(parsed),
        };

        await repository.setSession(user.id, 'manual_interval', { draft });
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Выберите межповерочный интервал:', {
          attachments: [
            makeKeyboard([
              [
                { text: '📅 4 года', payload: CB.INTERVAL_4 },
                { text: '📅 5 лет', payload: CB.INTERVAL_5 },
                { text: '📅 6 лет', payload: CB.INTERVAL_6 },
              ],
              [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
            ]),
          ],
        });
        return;
      }

      case 'import_wait_submission_id': {
        const submissionId = Number(text);
        if (!Number.isFinite(submissionId) || submissionId <= 0) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Отправьте корректный ID заявки.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        await this.runSubmissionImport(user, submissionId);
        return;
      }

      case 'import_check_date': {
        const parsed = parseDateOrNull(text);
        if (!parsed || isFutureDate(parsed)) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Дата поверки должна быть корректной и не в будущем.', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const draft = {
          ...(session.data.draft as Partial<ActDraft>),
          checkDate: toDateView(parsed),
        };

        await repository.setSession(user.id, 'import_interval', { draft });
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Выберите межповерочный интервал:', {
          attachments: [
            makeKeyboard([
              [
                { text: '📅 4 года', payload: CB.INTERVAL_4 },
                { text: '📅 5 лет', payload: CB.INTERVAL_5 },
                { text: '📅 6 лет', payload: CB.INTERVAL_6 },
              ],
              [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
            ]),
          ],
        });
        return;
      }

      case 'topup_custom_amount': {
        const normalized = text.trim();
        const valueRub = Number(normalized);
        if (!/^\d+$/.test(normalized) || !Number.isInteger(valueRub) || valueRub < 10) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Минимальная сумма пополнения — 10 ₽ (только целые рубли).', {
            attachments: [cancelKeyboard()],
          });
          return;
        }

        const amountRub = valueRub;
        await this.createTopUpPayment(user, amountRub);

        const resumeState = String(session.data.resumeState ?? 'idle') as UserSession['state'];
        const resumeData = (session.data.resumeData as Record<string, unknown>) ?? {};
        await repository.setSession(user.id, resumeState, resumeData);
        return;
      }

      default:
        return;
    }
  }
  private async handleCallbackByPayload(user: BotUser, payload: string, session: UserSession): Promise<void> {
    if (payload === CB.MENU_HELP) {
      await this.sendHelpContact(user.maxUserId);
      return;
    }

    if (payload === CB.MENU_MANUAL) {
      await repository.setSession(user.id, 'manual_address', {
        draft: {
          source: 'manual',
        },
      });
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Введите адрес:', {
        attachments: [cancelKeyboard()],
      });
      return;
    }

    if (payload === CB.MENU_IMPORT) {
      await repository.setSession(user.id, 'import_wait_submission_id', {});
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Отправьте ID заявки из внешнего бота отчетов:', {
        attachments: [cancelKeyboard()],
      });
      return;
    }

    if (payload === CB.MENU_HISTORY) {
      await this.showHistory(user);
      return;
    }

    if (payload === CB.MENU_TOPUP || payload === CB.INSUFFICIENT_TOPUP) {
      await this.showTopUpOptions(user.maxUserId);
      return;
    }

    if (payload === CB.TOPUP_10 || payload === CB.TOPUP_50 || payload === CB.TOPUP_100) {
      const amount = Number(payload.replace('topup_', ''));
      await this.createTopUpPayment(user, amount);
      return;
    }

    if (payload === CB.TOPUP_OTHER) {
      await repository.setSession(user.id, 'topup_custom_amount', {
        resumeState: session.state,
        resumeData: session.data,
      });
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Введите произвольную сумму в рублях (минимум 10):', {
        attachments: [cancelKeyboard()],
      });
      return;
    }

    if (payload === CB.WATER_HVS || payload === CB.WATER_GVS) {
      if (session.state !== 'manual_water_type') {
        return;
      }

      const draft = {
        ...(session.data.draft as Partial<ActDraft>),
        waterType: payload === CB.WATER_HVS ? 'ХВС' : 'ГВС',
      };

      await repository.setSession(user.id, 'manual_meter_model', { draft });
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Введите модель/тип счетчика:', {
        attachments: [cancelKeyboard()],
      });
      return;
    }

    if (payload === CB.INTERVAL_4 || payload === CB.INTERVAL_5 || payload === CB.INTERVAL_6) {
      const interval = Number(payload.replace('interval_', '')) as 4 | 5 | 6;
      if (session.state !== 'manual_interval' && session.state !== 'import_interval') {
        return;
      }

      const draft = {
        ...(session.data.draft as Partial<ActDraft>),
        intervalYears: interval,
      };

      if (session.state === 'manual_interval') {
        await repository.setSession(user.id, 'manual_result', { draft });
      } else {
        await repository.setSession(user.id, 'import_result', { draft });
      }

      await this.bot.api.sendMessageToUser(user.maxUserId, 'Выберите результат:', {
        attachments: [
          makeKeyboard([
            [
              { text: '✅ Годен', payload: CB.RESULT_FIT, intent: 'positive' },
              { text: '❌ Негоден', payload: CB.RESULT_UNFIT, intent: 'negative' },
            ],
            [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
          ]),
        ],
      });
      return;
    }

    if (payload === CB.RESULT_FIT || payload === CB.RESULT_UNFIT) {
      if (session.state !== 'manual_result' && session.state !== 'import_result') {
        return;
      }

      const draft = {
        ...(session.data.draft as Partial<ActDraft>),
        result: payload === CB.RESULT_FIT ? 'fit' : 'unfit',
      };

      const nextState = session.state === 'manual_result' ? 'manual_confirm' : 'import_confirm';
      await repository.setSession(user.id, nextState, { draft });
      await this.showDraftSummary(user, draft as ActDraft);
      return;
    }

    if (payload === CB.IMPORT_CONFIRM) {
      if (session.state !== 'import_confirmation') {
        return;
      }

      await repository.setSession(user.id, 'import_check_date', {
        draft: session.data.draft,
      });

      await this.bot.api.sendMessageToUser(
        user.maxUserId,
        `Введите дату поверки в формате ДД.ММ.ГГГГ (сегодня: ${todayDateString()}).`,
        {
          attachments: [cancelKeyboard()],
        },
      );
      return;
    }

    if (payload === CB.DRAFT_CONFIRM) {
      await this.confirmDraft(user, session);
      return;
    }

    if (payload === CB.INSUFFICIENT_ONE_TIME) {
      await this.createOneTimePaymentForDraft(user, session);
      return;
    }
  }

  private async showDraftSummary(user: BotUser, draft: ActDraft): Promise<void> {
    const prices = await repository.getPrices();
    const price = user.verified ? prices.verifiedPrice : prices.defaultPrice;

    const checkDate = parseDateOrNull(draft.checkDate);
    if (!checkDate) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Не удалось распознать все обязательные поля. Попробуйте еще раз.');
      return;
    }

    const validUntil = computeValidUntil(checkDate, draft.intervalYears);

    const lines = [
      'Сводка:',
      `Адрес: ${draft.address}`,
      `Тип воды: ${draft.waterType}`,
      `Модель счетчика: ${draft.meterModel}`,
      `Серийный номер: ${draft.serialNumber}`,
      `Текущее показание: ${draft.currentReading}`,
      `Дата поверки: ${draft.checkDate}`,
      `Интервал: ${draft.intervalYears} лет`,
      `Действителен до: ${toDateView(validUntil)}`,
      `Результат: ${draft.result === 'fit' ? '✅ Годен' : '❌ Негоден'}`,
      `Стоимость: ${formatRub(price)}`,
    ];

    await this.bot.api.sendMessageToUser(user.maxUserId, lines.join('\n'), {
      attachments: [
        makeKeyboard([
          [{ text: price > 0 ? '💳 Подтвердить и оплатить' : '📄 Получить акт', payload: CB.DRAFT_CONFIRM, intent: 'positive' }],
          [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
        ]),
      ],
    });
  }

  private async confirmDraft(user: BotUser, session: UserSession): Promise<void> {
    if (session.state !== 'manual_confirm' && session.state !== 'import_confirm') {
      return;
    }

    const draftRaw = session.data.draft as Partial<ActDraft>;
    if (!validateDraft(draftRaw)) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Не удалось распознать все обязательные поля. Попробуйте еще раз.');
      return;
    }

    const draft = draftRaw;
    const prices = await repository.getPrices();
    const price = user.verified ? prices.verifiedPrice : prices.defaultPrice;

    if (price === 0) {
      const pending = await repository.createPendingAct({
        userId: user.id,
        source: draft.source,
        draft,
        priceRub: 0,
        status: 'paid',
      });

      await repository.enqueueActGenerationJob({
        userId: user.id,
        pendingActId: pending.id,
        draft,
        priceRub: 0,
      });

      await repository.clearSession(user.id);
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Заявка на акт принята. Документ поставлен в очередь на генерацию.');
      return;
    }

    const freshUser = await repository.getUserById(user.id);
    if (!freshUser) {
      return;
    }

    if (freshUser.balanceRub >= price) {
      await repository.changeBalance(user.id, -price);
      const payment = await repository.createPayment({
        userId: user.id,
        kind: 'balance_charge',
        status: 'succeeded',
        amountRub: price,
        metadata: {
          reason: 'act_generation',
        },
      });

      let pendingId: number | null = null;
      try {
        const pending = await repository.createPendingAct({
          userId: user.id,
          source: draft.source,
          draft,
          priceRub: price,
          status: 'paid',
          paymentId: payment.id,
        });

        pendingId = pending.id;

        await repository.enqueueActGenerationJob({
          userId: user.id,
          pendingActId: pending.id,
          paymentId: payment.id,
          draft,
          priceRub: price,
        });

        await repository.clearSession(user.id);
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Заявка на акт принята. Документ поставлен в очередь на генерацию.');
      } catch (error) {
        await repository.changeBalance(user.id, price);
        await repository.updatePaymentStatusById(payment.id, 'failed');
        if (pendingId) {
          await repository.setPendingActStatus(pendingId, 'cancelled');
        }
        throw error;
      }

      return;
    }

    await this.bot.api.sendMessageToUser(user.maxUserId, 'Недостаточно средств на балансе.', {
      attachments: [
        makeKeyboard([
          [{ text: '💳 Разовый платеж', payload: CB.INSUFFICIENT_ONE_TIME, intent: 'positive' }],
          [{ text: '💰 Пополнить баланс', payload: CB.INSUFFICIENT_TOPUP }],
          [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
        ]),
      ],
    });
  }

  private async createOneTimePaymentForDraft(user: BotUser, session: UserSession): Promise<void> {
    if (session.state !== 'manual_confirm' && session.state !== 'import_confirm') {
      return;
    }

    const draftRaw = session.data.draft as Partial<ActDraft>;
    if (!validateDraft(draftRaw)) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Не удалось распознать все обязательные поля. Попробуйте еще раз.');
      return;
    }

    const prices = await repository.getPrices();
    const price = user.verified ? prices.verifiedPrice : prices.defaultPrice;

    const pending = await repository.createPendingAct({
      userId: user.id,
      source: draftRaw.source,
      draft: draftRaw,
      priceRub: price,
      status: 'pending',
    });

    const payment = await repository.createPayment({
      userId: user.id,
      kind: 'one_time',
      status: 'pending',
      amountRub: price,
      metadata: {
        pending_act_id: pending.id,
      },
    });

    const yooPayment = await yooKassaClient.createPayment({
      amountRub: price,
      description: `One-time act payment for user ${user.maxUserId}`,
      metadata: {
        payment_kind: 'one_time',
        internal_payment_id: String(payment.id),
        pending_act_id: String(pending.id),
        user_id: String(user.id),
      },
    });

    await repository.setPaymentProviderData(payment.id, yooPayment.id, yooPayment.confirmationUrl);
    await repository.attachPaymentToPendingAct(pending.id, payment.id);
    await repository.clearSession(user.id);

    const keyboard = yooPayment.confirmationUrl
      ? Keyboard.inlineKeyboard([[Keyboard.button.link('💳 Оплатить', yooPayment.confirmationUrl)]])
      : undefined;

    await this.bot.api.sendMessageToUser(
      user.maxUserId,
      yooPayment.confirmationUrl
        ? `Разовый платеж создан. Перейдите по ссылке: ${yooPayment.confirmationUrl}`
        : 'Разовый платеж создан.',
      keyboard ? { attachments: [keyboard] } : undefined,
    );
    await this.sendHomeScreen(user.maxUserId);
  }

  private async showTopUpOptions(maxUserId: number): Promise<void> {
    await this.bot.api.sendMessageToUser(maxUserId, 'Выберите сумму пополнения:', {
      attachments: [
        makeKeyboard([
          [
            { text: '💳 10 ₽', payload: CB.TOPUP_10 },
            { text: '💳 50 ₽', payload: CB.TOPUP_50 },
            { text: '💳 100 ₽', payload: CB.TOPUP_100 },
          ],
          [{ text: '✏️ Другая сумма', payload: CB.TOPUP_OTHER }],
          [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
        ]),
      ],
    });
  }

  private async createTopUpPayment(user: BotUser, amountRub: number): Promise<void> {
    if (!Number.isInteger(amountRub) || amountRub < 10) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Минимальная сумма пополнения — 10 ₽ (только целые рубли).');
      return;
    }

    const payment = await repository.createPayment({
      userId: user.id,
      kind: 'top_up',
      status: 'pending',
      amountRub,
    });

    const yooPayment = await yooKassaClient.createPayment({
      amountRub,
      description: `Balance top-up for user ${user.maxUserId}`,
      metadata: {
        payment_kind: 'top_up',
        internal_payment_id: String(payment.id),
        user_id: String(user.id),
      },
    });

    await repository.setPaymentProviderData(payment.id, yooPayment.id, yooPayment.confirmationUrl);

    const keyboard = yooPayment.confirmationUrl
      ? Keyboard.inlineKeyboard([[Keyboard.button.link('💳 Оплатить', yooPayment.confirmationUrl)]])
      : undefined;

    await this.bot.api.sendMessageToUser(
      user.maxUserId,
      yooPayment.confirmationUrl
        ? `Платеж на пополнение создан. Перейдите по ссылке: ${yooPayment.confirmationUrl}`
        : 'Платеж на пополнение создан.',
      keyboard ? { attachments: [keyboard] } : undefined,
    );
    await this.sendHomeScreen(user.maxUserId);
  }
  private async runSubmissionImport(user: BotUser, submissionId: number): Promise<void> {
    const result = await externalSubmissionService.loadSubmission(submissionId, user.maxUserId);

    if (result.kind === 'not_found') {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Заявка не найдена или больше недоступна.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    if (result.kind === 'access_denied') {
      await this.bot.api.sendMessageToUser(
        user.maxUserId,
        'Эта заявка принадлежит другому пользователю и недоступна.',
      );
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    if (result.kind === 'incomplete') {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Не удалось распознать все обязательные поля. Попробуйте еще раз.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    if (!user.verified) {
      await repository.setUserVerified(user.id);
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Пользователь успешно верифицирован по deep-link.');
    }

    await repository.updateUserProfileFromExternal(user.id, result.data.userFullname, result.data.orgName);

    const draft: Partial<ActDraft> = {
      source: 'submission',
      submissionId: result.data.submissionId,
      address: result.data.address,
      waterType: result.data.waterType,
      meterModel: result.data.meterModel,
      serialNumber: result.data.serialNumber,
      currentReading: result.data.currentReading,
    };

    await repository.setSession(user.id, 'import_confirmation', { draft });

    const lines = [
      'Импортированные данные:',
      `Адрес: ${result.data.address}`,
      `Тип воды: ${result.data.waterType}`,
      `Модель/тип счетчика: ${result.data.meterModel}`,
      `Серийный номер: ${result.data.serialNumber}`,
      `Текущее показание: ${result.data.currentReading}`,
    ];

    await this.bot.api.sendMessageToUser(user.maxUserId, lines.join('\n'), {
      attachments: [
        makeKeyboard([
          [{ text: '✅ Подтвердить', payload: CB.IMPORT_CONFIRM, intent: 'positive' }],
          [{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }],
        ]),
      ],
    });
  }

  private async showHistory(user: BotUser): Promise<void> {
    const acts = await repository.listActsByUser(user.id);
    const existing: Array<{ id: number; actNumber: string; createdAt: Date; pdfPath: string; address: string }> = [];

    for (const act of acts) {
      if (await fileExists(act.pdfPath)) {
        existing.push(act);
      } else {
        await repository.deleteActById(act.id);
      }
    }

    if (!existing.length) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'История пуста.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    await this.bot.api.sendMessageToUser(user.maxUserId, 'Последние акты:', {
      attachments: [
        makeKeyboard(
          existing.map((item) => [{ text: summarizeHistoryItem(item), payload: historyPayload(item.id) }]),
        ),
      ],
    });
    await this.sendHomeScreen(user.maxUserId);
  }

  private async sendHistoryFile(user: BotUser, actId: number): Promise<void> {
    const act = await repository.getActByIdForUser(actId, user.id);
    if (!act) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Акт не найден.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    if (!(await fileExists(act.pdfPath))) {
      await repository.deleteActById(act.id);
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Запись истории удалена, потому что файл отсутствует.');
      await this.sendHomeScreen(user.maxUserId);
      return;
    }

    await sendFileToUser(this.bot.api, user.maxUserId, act.pdfPath, `Акт №${act.actNumber}`);
    await this.sendHomeScreen(user.maxUserId);
  }

  private async handleAdminMessage(
    user: BotUser,
    text: string,
    command: { command: string; args: string[] } | null,
    ctx: Context,
  ): Promise<void> {
    const session = await repository.getSession(user.id);

    if (session.state === 'admin_new_offer_wait_file') {
      await this.handleAdminOfferFileUpload(user, ctx);
      return;
    }

    if (session.state === 'admin_new_offer_wait_version') {
      await this.finishNewOfferFlow(user, text, session);
      return;
    }

    if (session.state === 'admin_broadcast_wait_text') {
      if (!text) {
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Текст рассылки не может быть пустым.');
        return;
      }

      await repository.clearSession(user.id);
      await this.broadcastText(text);
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Рассылка отправлена.');
      return;
    }

    if (!command) {
      await this.sendAdminHelp(user.maxUserId);
      return;
    }

    switch (command.command) {
      case '/start': {
        await this.sendAdminHelp(user.maxUserId);
        return;
      }

      case '/stats': {
        const stats = await repository.getStats();
        await this.bot.api.sendMessageToUser(
          user.maxUserId,
          [
            `Пользователи: ${stats.users}`,
            `Акты: ${stats.acts}`,
            `Выручка за день: ${formatRub(stats.revenueDay)}`,
            `Выручка за месяц: ${formatRub(stats.revenueMonth)}`,
            `Выручка всего: ${formatRub(stats.revenueTotal)}`,
          ].join('\n'),
        );
        return;
      }

      case '/setprice': {
        const value = Number(command.args[0]);
        if (!Number.isInteger(value) || value < 0) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Использование: /setprice {rub}');
          return;
        }

        await repository.setPrice('ordinary', value);
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Цена для обычных пользователей успешно обновлена.');
        return;
      }

      case '/setprice_verified': {
        const value = Number(command.args[0]);
        if (!Number.isInteger(value) || value < 0) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Использование: /setprice_verified {rub}');
          return;
        }

        await repository.setPrice('verified', value);
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Цена для verified-пользователей успешно обновлена.');
        return;
      }

      case '/user': {
        const targetMaxId = Number(command.args[0]);
        if (!Number.isFinite(targetMaxId)) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Использование: /user {id}');
          return;
        }

        const card = await repository.getUserCardByMaxId(targetMaxId);
        if (!card) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Пользователь не найден.');
          return;
        }

        await this.bot.api.sendMessageToUser(
          user.maxUserId,
          [
            `MAX ID пользователя: ${card.user.maxUserId}`,
            `Баланс: ${formatRub(card.user.balanceRub)}`,
            `Акты: ${card.user.actsCount}`,
            `Платежи: ${card.paymentsCount}`,
            `Тип пользователя: ${card.user.verified ? 'верифицированный' : 'обычный'}`,
          ].join('\n'),
        );
        return;
      }

      case '/addbalance': {
        const targetMaxId = Number(command.args[0]);
        const amount = Number(command.args[1]);
        if (!Number.isFinite(targetMaxId) || !Number.isInteger(amount) || amount <= 0) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Использование: /addbalance {user_id} {amount}');
          return;
        }

        const target = await repository.getUserByMaxId(targetMaxId);
        if (!target) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Пользователь не найден.');
          return;
        }

        const balanceBefore = target.balanceRub;
        const balanceAfter = await repository.changeBalance(target.id, amount);

        await this.bot.api.sendMessageToUser(
          user.maxUserId,
          [
            'Баланс успешно пополнен.',
            `Было: ${formatRub(balanceBefore)}`,
            `Добавлено: ${formatRub(amount)}`,
            `Стало: ${formatRub(balanceAfter)}`,
          ].join('\n'),
        );
        await this.bot.api.sendMessageToUser(
          target.maxUserId,
          [
            `Администратор добавил на ваш баланс ${amount} ₽`,
            `Было: ${formatRub(balanceBefore)}`,
            `Добавлено: ${formatRub(amount)}`,
            `Стало: ${formatRub(balanceAfter)}`,
          ].join('\n'),
        );
        await this.sendHomeScreen(target.maxUserId);
        return;
      }

      case '/broadcast': {
        const textValue = command.args.join(' ').trim();
        if (textValue) {
          await this.broadcastText(textValue);
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Рассылка отправлена.');
          return;
        }

        await repository.setSession(user.id, 'admin_broadcast_wait_text', {});
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Отправьте текст рассылки:', {
          attachments: [cancelKeyboard()],
        });
        return;
      }

      case '/new_oferta': {
        await repository.setSession(user.id, 'admin_new_offer_wait_file', {});
        await this.bot.api.sendMessageToUser(user.maxUserId, 'Загрузите PDF-файл новой оферты:', {
          attachments: [cancelKeyboard()],
        });
        return;
      }

      case '/refund': {
        const paymentArg = command.args[0];
        if (!paymentArg) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Использование: /refund {payment_id}');
          return;
        }

        const byInternal = Number(paymentArg);
        const payment = Number.isFinite(byInternal)
          ? await repository.getPaymentByInternalId(byInternal)
          : await repository.getPaymentByProviderId(paymentArg);

        if (!payment) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'Платеж не найден.');
          return;
        }

        if (!payment.providerPaymentId) {
          await this.bot.api.sendMessageToUser(user.maxUserId, 'У платежа нет идентификатора YooKassa.');
          return;
        }

        const refund = await yooKassaClient.refundPayment({
          providerPaymentId: payment.providerPaymentId,
          amountRub: payment.amountRub,
          reason: `Admin refund for payment ${payment.id}`,
        });

        await repository.updatePaymentStatusById(payment.id, 'refunded', {
          refund_id: refund.id,
          refund_status: refund.status,
        });

        await this.bot.api.sendMessageToUser(user.maxUserId, `Результат возврата: ${refund.status} (id: ${refund.id})`);
        return;
      }

      default:
        await this.sendAdminHelp(user.maxUserId);
    }
  }

  private async handleAdminOfferFileUpload(user: BotUser, ctx: Context): Promise<void> {
    const attachments = ctx.message?.body?.attachments ?? [];
    const file = attachments.find((item) => item.type === 'file');
    if (!file || file.type !== 'file') {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Загружен неверный файл оферты. Загрузите PDF.');
      return;
    }

    const filename = (file as { filename?: string }).filename ?? '';
    if (!filename.toLowerCase().endsWith('.pdf')) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Загружен неверный файл оферты. Загрузите PDF.');
      return;
    }

    const sourceUrl = file.payload.url;
    if (!sourceUrl) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Загружен неверный файл оферты. Загрузите PDF.');
      return;
    }

    const tempFileName = `offer-upload-${Date.now()}.pdf`;
    const tempPath = path.join(env.OFFER_STORAGE_DIR, tempFileName);

    await fs.mkdir(env.OFFER_STORAGE_DIR, { recursive: true });

    const fileBuffer = await this.downloadBotFile(sourceUrl);
    await fs.writeFile(tempPath, fileBuffer);

    await repository.setSession(user.id, 'admin_new_offer_wait_version', {
      offerTempPath: tempPath,
    });

    await this.bot.api.sendMessageToUser(user.maxUserId, 'Теперь отправьте строку версии оферты, например: 4.1');
  }

  private async finishNewOfferFlow(user: BotUser, text: string, session: UserSession): Promise<void> {
    const version = text.trim();
    if (!version) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Версия оферты не может быть пустой.');
      return;
    }

    const existing = await repository.getOfferByVersion(version);
    if (existing) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Такая версия оферты уже существует.');
      return;
    }

    const tempPath = String(session.data.offerTempPath ?? '');
    if (!tempPath || !(await fileExists(tempPath))) {
      await this.bot.api.sendMessageToUser(user.maxUserId, 'Загружен неверный файл оферты. Перезапустите /new_oferta.');
      await repository.clearSession(user.id);
      return;
    }

    const finalFileName = `offer-v${version.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${Date.now()}.pdf`;
    const finalPath = path.join(env.OFFER_STORAGE_DIR, finalFileName);
    await fs.rename(tempPath, finalPath);

    await repository.createNewCurrentOffer(version, finalPath, user.maxUserId);
    await repository.clearSession(user.id);

    await this.bot.api.sendMessageToUser(user.maxUserId, 'Оферта успешно обновлена.');
    await this.sendAdminHelp(user.maxUserId);

    const users = await repository.listAllUsers();
    for (const target of users) {
      try {
        if (target.maxUserId === user.maxUserId) {
          continue;
        }
        await this.sendOfferForAcceptance(target.maxUserId, version, finalPath);
      } catch (error) {
        logger.warn({ error, targetMaxUserId: target.maxUserId }, 'Failed to broadcast new offer');
      }
    }
  }

  private async broadcastText(text: string): Promise<void> {
    const users = await repository.listAllUsers();
    for (const user of users) {
      try {
        await this.bot.api.sendMessageToUser(user.maxUserId, text);
        await this.sendHomeScreen(user.maxUserId);
      } catch (error) {
        logger.warn({ error, targetMaxUserId: user.maxUserId }, 'Broadcast send failed');
      }
    }
  }

  private async downloadBotFile(url: string): Promise<Buffer> {
    const primary = await fetch(url);
    if (primary.ok) {
      return Buffer.from(await primary.arrayBuffer());
    }

    const withToken = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.BOT_TOKEN}`,
      },
    });

    if (!withToken.ok) {
      throw new Error(`Cannot download bot file: ${withToken.status}`);
    }

    return Buffer.from(await withToken.arrayBuffer());
  }
}

export const maxBotService = new MaxBotService();



