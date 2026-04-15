import { FileAttachment, Keyboard } from '@maxhub/max-bot-api';
import type { Api } from '@maxhub/max-bot-api';
import { format } from 'date-fns';
import { CB, historyPayload } from './callbacks';

export const makeKeyboard = (rows: Array<Array<{ text: string; payload: string; intent?: 'default' | 'positive' | 'negative' }>>) => {
  return Keyboard.inlineKeyboard(
    rows.map((row) =>
      row.map((button) =>
        Keyboard.button.callback(button.text, button.payload, button.intent ? { intent: button.intent } : undefined),
      ),
    ),
  );
};

export const menuKeyboard = (verified: boolean) => {
  const rows: Array<Array<{ text: string; payload: string }>> = [];
  if (verified) {
    rows.push([{ text: '📋 Вставить данные', payload: CB.MENU_IMPORT }]);
  }
  rows.push([{ text: '📝 Ввести вручную', payload: CB.MENU_MANUAL }]);
  rows.push([{ text: '💳 Пополнить баланс', payload: CB.MENU_TOPUP }]);
  rows.push([{ text: verified ? '📁 История актов' : '📁 История', payload: CB.MENU_HISTORY }]);
  rows.push([{ text: 'ℹ️ Помощь', payload: CB.MENU_HELP }]);

  return makeKeyboard(rows);
};

export const cancelKeyboard = () => makeKeyboard([[{ text: '❌ Отменить', payload: CB.CANCEL, intent: 'negative' }]]);

export const sendFileToUser = async (api: Api, userId: number, filePath: string, caption?: string): Promise<void> => {
  const uploaded = await api.uploadFile({ source: filePath });
  const fileAttachment = new FileAttachment({ token: uploaded.token }).toJson();

  await api.sendMessageToUser(userId, caption ?? 'Document', {
    attachments: [fileAttachment],
  });
};

const HISTORY_BUTTON_MAX_LENGTH = 64;

const truncateAddress = (address: string, maxLength: number): string => {
  const cleaned = address.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  if (maxLength <= 1) {
    return '…';
  }
  return `${cleaned.slice(0, maxLength - 1)}…`;
};

export const summarizeHistoryItem = (item: { createdAt: Date; address: string }): string => {
  const dateTime = format(item.createdAt, 'dd.MM.yyyy HH:mm');
  const prefix = `${dateTime} • `;
  const addressMaxLength = Math.max(0, HISTORY_BUTTON_MAX_LENGTH - prefix.length);
  const address = truncateAddress(item.address, addressMaxLength);
  return address ? `${prefix}${address}` : dateTime;
};

export const historyDownloadPayload = historyPayload;

