import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';

const API_BASE = 'https://api.yookassa.ru/v3';

const authHeader = `Basic ${Buffer.from(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`).toString('base64')}`;

export type YooPayment = {
  id: string;
  status: string;
  confirmationUrl: string | null;
};

export type YooWebhookEvent = {
  event: string;
  object: {
    id: string;
    status: string;
    paid?: boolean;
    amount?: {
      value: string;
      currency: string;
    };
    metadata?: Record<string, unknown>;
  };
};

const request = async <T>(path: string, method: 'POST', body: unknown): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      'Idempotence-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`YooKassa API error (${response.status}): ${errorText}`);
  }

  return (await response.json()) as T;
};

export class YooKassaClient {
  async createPayment(params: {
    amountRub: number;
    description: string;
    metadata: Record<string, string>;
  }): Promise<YooPayment> {
    const value = params.amountRub.toFixed(2);
    const payload = {
      amount: {
        value,
        currency: 'RUB',
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: env.YOOKASSA_RETURN_URL,
      },
      description: params.description,
      metadata: params.metadata,
    };

    const response = await request<{
      id: string;
      status: string;
      confirmation?: { confirmation_url?: string };
    }>('/payments', 'POST', payload);

    return {
      id: response.id,
      status: response.status,
      confirmationUrl: response.confirmation?.confirmation_url ?? null,
    };
  }

  async refundPayment(params: {
    providerPaymentId: string;
    amountRub: number;
    reason: string;
  }): Promise<{ id: string; status: string }> {
    const payload = {
      payment_id: params.providerPaymentId,
      amount: {
        value: params.amountRub.toFixed(2),
        currency: 'RUB',
      },
      description: params.reason,
    };

    const response = await request<{ id: string; status: string }>('/refunds', 'POST', payload);
    return {
      id: response.id,
      status: response.status,
    };
  }
}

export const yooKassaClient = new YooKassaClient();

