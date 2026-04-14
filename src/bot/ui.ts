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
    rows.push([{ text: '📥 Создать акт по заявке', payload: CB.MENU_IMPORT }]);
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

export const summarizeHistoryItem = (item: { id: number; actNumber: string; createdAt: Date }): string => {
  return `#${item.actNumber} (${format(item.createdAt, 'dd.MM.yyyy HH:mm')})`;
};

export const historyDownloadPayload = historyPayload;

