import type { PoolClient, QueryResultRow } from 'pg';
import { pool, withTransaction } from './pool';
import type { ActDraft, BotUser, CurrentOffer, PaymentRecord, UserSession } from '../types';

type DB = PoolClient | typeof pool;

const toBotUser = (row: QueryResultRow): BotUser => ({
  id: Number(row.id),
  maxUserId: Number(row.max_user_id),
  username: row.username,
  firstName: row.first_name,
  lastName: row.last_name,
  userFullname: row.user_fullname,
  orgName: row.org_name,
  verified: row.verified,
  acceptedOfferVersion: row.accepted_offer_version,
  acceptedOfferAt: row.accepted_offer_at,
  balanceKopecks: Number(row.balance_kopecks),
  actsCount: Number(row.acts_count),
});

const toPaymentRecord = (row: QueryResultRow): PaymentRecord => ({
  id: Number(row.id),
  userId: Number(row.user_id),
  kind: row.kind,
  status: row.status,
  amountKopecks: Number(row.amount_kopecks),
  providerPaymentId: row.provider_payment_id,
  confirmationUrl: row.confirmation_url,
  metadata: row.metadata ?? {},
});

export class Repository {
  async ensureSettings(defaultPrice: number, verifiedPrice: number): Promise<void> {
    await pool.query(
      `
      INSERT INTO settings(key, value)
      VALUES
        ('act_price_default', $1),
        ('act_price_verified', $2)
      ON CONFLICT (key) DO NOTHING
      `,
      [String(defaultPrice), String(verifiedPrice)],
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const { rows } = await pool.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await pool.query(
      `
      INSERT INTO settings(key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [key, value],
    );
  }

  async getPrices(): Promise<{ defaultPrice: number; verifiedPrice: number }> {
    const [defaultRaw, verifiedRaw] = await Promise.all([
      this.getSetting('act_price_default'),
      this.getSetting('act_price_verified'),
    ]);

    return {
      defaultPrice: Number(defaultRaw ?? '0'),
      verifiedPrice: Number(verifiedRaw ?? '0'),
    };
  }

  async upsertUserByMaxId(input: {
    maxUserId: number;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }): Promise<BotUser> {
    const { rows } = await pool.query(
      `
      INSERT INTO users(max_user_id, username, first_name, last_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (max_user_id) DO UPDATE SET
        username = COALESCE(EXCLUDED.username, users.username),
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, users.last_name),
        updated_at = NOW()
      RETURNING *
      `,
      [input.maxUserId, input.username ?? null, input.firstName ?? null, input.lastName ?? null],
    );

    return toBotUser(rows[0]);
  }

  async getUserByMaxId(maxUserId: number): Promise<BotUser | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE max_user_id = $1 LIMIT 1', [maxUserId]);
    return rows[0] ? toBotUser(rows[0]) : null;
  }

  async getUserById(userId: number): Promise<BotUser | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0] ? toBotUser(rows[0]) : null;
  }

  async setUserVerified(userId: number): Promise<void> {
    await pool.query('UPDATE users SET verified = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
  }

  async updateUserProfileFromExternal(userId: number, userFullname: string | null, orgName: string | null): Promise<void> {
    await pool.query(
      `
      UPDATE users
      SET user_fullname = COALESCE($2, user_fullname),
          org_name = COALESCE($3, org_name),
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId, userFullname, orgName],
    );
  }

  async acceptOffer(userId: number, version: string): Promise<void> {
    await pool.query(
      `
      UPDATE users
      SET accepted_offer_version = $2,
          accepted_offer_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId, version],
    );
  }

  async changeBalance(userId: number, deltaKopecks: number, db: DB = pool): Promise<void> {
    await db.query(
      `
      UPDATE users
      SET balance_kopecks = balance_kopecks + $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId, deltaKopecks],
    );
  }

  async incrementActsCount(userId: number, db: DB = pool): Promise<void> {
    await db.query('UPDATE users SET acts_count = acts_count + 1, updated_at = NOW() WHERE id = $1', [userId]);
  }

  async listAllUsers(): Promise<Array<{ id: number; maxUserId: number }>> {
    const { rows } = await pool.query('SELECT id, max_user_id FROM users ORDER BY id ASC');
    return rows.map((row) => ({ id: Number(row.id), maxUserId: Number(row.max_user_id) }));
  }

  async getCurrentOffer(): Promise<CurrentOffer | null> {
    const { rows } = await pool.query('SELECT * FROM offers WHERE is_current = TRUE ORDER BY id DESC LIMIT 1');
    if (!rows[0]) {
      return null;
    }

    return {
      id: Number(rows[0].id),
      version: rows[0].version,
      filePath: rows[0].file_path,
      createdByMaxId: Number(rows[0].created_by_max_id),
    };
  }

  async getOfferByVersion(version: string): Promise<CurrentOffer | null> {
    const { rows } = await pool.query('SELECT * FROM offers WHERE version = $1 LIMIT 1', [version]);
    if (!rows[0]) {
      return null;
    }

    return {
      id: Number(rows[0].id),
      version: rows[0].version,
      filePath: rows[0].file_path,
      createdByMaxId: Number(rows[0].created_by_max_id),
    };
  }

  async createNewCurrentOffer(version: string, filePath: string, createdByMaxId: number): Promise<CurrentOffer> {
    return withTransaction(async (client) => {
      await client.query('UPDATE offers SET is_current = FALSE WHERE is_current = TRUE');
      const { rows } = await client.query(
        `
        INSERT INTO offers(version, file_path, is_current, created_by_max_id)
        VALUES ($1, $2, TRUE, $3)
        RETURNING *
        `,
        [version, filePath, createdByMaxId],
      );

      return {
        id: Number(rows[0].id),
        version: rows[0].version,
        filePath: rows[0].file_path,
        createdByMaxId: Number(rows[0].created_by_max_id),
      };
    });
  }

  async getSession(userId: number): Promise<UserSession> {
    const { rows } = await pool.query('SELECT state, data FROM user_sessions WHERE user_id = $1 LIMIT 1', [userId]);
    if (!rows[0]) {
      return { state: 'idle', data: {} };
    }

    return {
      state: rows[0].state,
      data: rows[0].data ?? {},
    };
  }

  async setSession(userId: number, state: UserSession['state'], data: Record<string, unknown>): Promise<void> {
    await pool.query(
      `
      INSERT INTO user_sessions(user_id, state, data, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = NOW()
      `,
      [userId, state, JSON.stringify(data)],
    );
  }

  async clearSession(userId: number): Promise<void> {
    await this.setSession(userId, 'idle', {});
  }

  async createPayment(input: {
    userId: number;
    kind: PaymentRecord['kind'];
    status: PaymentRecord['status'];
    amountKopecks: number;
    providerPaymentId?: string | null;
    confirmationUrl?: string | null;
    metadata?: Record<string, unknown>;
    db?: DB;
  }): Promise<PaymentRecord> {
    const db = input.db ?? pool;
    const { rows } = await db.query(
      `
      INSERT INTO payments(user_id, kind, status, amount_kopecks, provider_payment_id, confirmation_url, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
      RETURNING *
      `,
      [
        input.userId,
        input.kind,
        input.status,
        input.amountKopecks,
        input.providerPaymentId ?? null,
        input.confirmationUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return toPaymentRecord(rows[0]);
  }

  async updatePaymentStatusByProviderId(
    providerPaymentId: string,
    status: PaymentRecord['status'],
    metadataPatch?: Record<string, unknown>,
  ): Promise<PaymentRecord | null> {
    const current = await this.getPaymentByProviderId(providerPaymentId);
    if (!current) {
      return null;
    }

    const mergedMetadata = { ...current.metadata, ...(metadataPatch ?? {}) };
    const { rows } = await pool.query(
      `
      UPDATE payments
      SET status = $2,
          metadata = $3::jsonb,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [current.id, status, JSON.stringify(mergedMetadata)],
    );

    return rows[0] ? toPaymentRecord(rows[0]) : null;
  }

  async updatePaymentStatusById(
    paymentId: number,
    status: PaymentRecord['status'],
    metadataPatch?: Record<string, unknown>,
  ): Promise<PaymentRecord | null> {
    const current = await this.getPaymentByInternalId(paymentId);
    if (!current) {
      return null;
    }

    const mergedMetadata = { ...current.metadata, ...(metadataPatch ?? {}) };
    const { rows } = await pool.query(
      `
      UPDATE payments
      SET status = $2,
          metadata = $3::jsonb,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [paymentId, status, JSON.stringify(mergedMetadata)],
    );

    return rows[0] ? toPaymentRecord(rows[0]) : null;
  }

  async getPaymentByProviderId(providerPaymentId: string): Promise<PaymentRecord | null> {
    const { rows } = await pool.query('SELECT * FROM payments WHERE provider_payment_id = $1 LIMIT 1', [providerPaymentId]);
    return rows[0] ? toPaymentRecord(rows[0]) : null;
  }

  async getPaymentByInternalId(paymentId: number): Promise<PaymentRecord | null> {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1 LIMIT 1', [paymentId]);
    return rows[0] ? toPaymentRecord(rows[0]) : null;
  }

  async setPaymentProviderData(id: number, providerPaymentId: string, confirmationUrl: string | null): Promise<void> {
    await pool.query(
      `
      UPDATE payments
      SET provider_payment_id = $2,
          confirmation_url = $3,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, providerPaymentId, confirmationUrl],
    );
  }

  async createPendingAct(input: {
    userId: number;
    source: 'manual' | 'submission';
    draft: ActDraft;
    priceKopecks: number;
    status: 'pending' | 'paid' | 'cancelled' | 'completed';
    paymentId?: number | null;
    db?: DB;
  }): Promise<{ id: number }> {
    const db = input.db ?? pool;
    const { rows } = await db.query(
      `
      INSERT INTO pending_acts(user_id, source, draft, price_kopecks, status, payment_id, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
      RETURNING id
      `,
      [input.userId, input.source, JSON.stringify(input.draft), input.priceKopecks, input.status, input.paymentId ?? null],
    );

    return { id: Number(rows[0].id) };
  }

  async getPendingAct(id: number): Promise<{
    id: number;
    userId: number;
    source: 'manual' | 'submission';
    draft: ActDraft;
    priceKopecks: number;
    status: 'pending' | 'paid' | 'cancelled' | 'completed';
    paymentId: number | null;
  } | null> {
    const { rows } = await pool.query('SELECT * FROM pending_acts WHERE id = $1 LIMIT 1', [id]);
    if (!rows[0]) {
      return null;
    }

    return {
      id: Number(rows[0].id),
      userId: Number(rows[0].user_id),
      source: rows[0].source,
      draft: rows[0].draft,
      priceKopecks: Number(rows[0].price_kopecks),
      status: rows[0].status,
      paymentId: rows[0].payment_id ? Number(rows[0].payment_id) : null,
    };
  }

  async attachPaymentToPendingAct(pendingActId: number, paymentId: number): Promise<void> {
    await pool.query('UPDATE pending_acts SET payment_id = $2, updated_at = NOW() WHERE id = $1', [pendingActId, paymentId]);
  }

  async setPendingActStatus(id: number, status: 'pending' | 'paid' | 'cancelled' | 'completed'): Promise<void> {
    await pool.query('UPDATE pending_acts SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
  }

  async createAct(input: {
    userId: number;
    source: 'manual' | 'submission';
    submissionId?: number;
    draft: ActDraft;
    actNumber: string;
    validUntil: string;
    priceKopecks: number;
    paymentId?: number | null;
    pdfPath: string;
    db?: DB;
  }): Promise<{ id: number }> {
    const db = input.db ?? pool;
    const { draft } = input;
    const { rows } = await db.query(
      `
      INSERT INTO acts(
        user_id,
        source,
        submission_id,
        act_number,
        address,
        water_type,
        meter_model,
        serial_number,
        current_reading,
        check_date,
        interval_years,
        valid_until,
        result,
        price_kopecks,
        payment_id,
        pdf_path
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::date, $13, $14, $15, $16)
      RETURNING id
      `,
      [
        input.userId,
        input.source,
        input.submissionId ?? null,
        input.actNumber,
        draft.address,
        draft.waterType,
        draft.meterModel,
        draft.serialNumber,
        draft.currentReading,
        draft.checkDate,
        draft.intervalYears,
        input.validUntil,
        draft.result,
        input.priceKopecks,
        input.paymentId ?? null,
        input.pdfPath,
      ],
    );

    return { id: Number(rows[0].id) };
  }

  async listActsByUser(userId: number, limit = 15): Promise<Array<{ id: number; actNumber: string; createdAt: Date; pdfPath: string }>> {
    const { rows } = await pool.query(
      `
      SELECT id, act_number, created_at, pdf_path
      FROM acts
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [userId, limit],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      actNumber: row.act_number,
      createdAt: row.created_at,
      pdfPath: row.pdf_path,
    }));
  }

  async getActByIdForUser(actId: number, userId: number): Promise<{ id: number; pdfPath: string; actNumber: string } | null> {
    const { rows } = await pool.query(
      'SELECT id, pdf_path, act_number FROM acts WHERE id = $1 AND user_id = $2 LIMIT 1',
      [actId, userId],
    );
    if (!rows[0]) {
      return null;
    }

    return {
      id: Number(rows[0].id),
      pdfPath: rows[0].pdf_path,
      actNumber: rows[0].act_number,
    };
  }

  async deleteActById(actId: number): Promise<void> {
    await pool.query('DELETE FROM acts WHERE id = $1', [actId]);
  }

  async getStats(): Promise<{
    users: number;
    acts: number;
    revenueDay: number;
    revenueMonth: number;
    revenueTotal: number;
  }> {
    const [usersResult, actsResult, revenueDayResult, revenueMonthResult, revenueTotalResult] = await Promise.all([
      pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM users'),
      pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM acts'),
      pool.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(price_kopecks), 0)::text AS sum
         FROM acts
         WHERE created_at >= date_trunc('day', NOW())`,
      ),
      pool.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(price_kopecks), 0)::text AS sum
         FROM acts
         WHERE created_at >= date_trunc('month', NOW())`,
      ),
      pool.query<{ sum: string | null }>('SELECT COALESCE(SUM(price_kopecks), 0)::text AS sum FROM acts'),
    ]);

    return {
      users: Number(usersResult.rows[0]?.count ?? 0),
      acts: Number(actsResult.rows[0]?.count ?? 0),
      revenueDay: Number(revenueDayResult.rows[0]?.sum ?? 0),
      revenueMonth: Number(revenueMonthResult.rows[0]?.sum ?? 0),
      revenueTotal: Number(revenueTotalResult.rows[0]?.sum ?? 0),
    };
  }

  async getUserCardByMaxId(maxUserId: number): Promise<{
    user: BotUser;
    paymentsCount: number;
  } | null> {
    const user = await this.getUserByMaxId(maxUserId);
    if (!user) {
      return null;
    }

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM payments WHERE user_id = $1', [user.id]);
    return {
      user,
      paymentsCount: Number(rows[0]?.count ?? 0),
    };
  }
}

export const repository = new Repository();

