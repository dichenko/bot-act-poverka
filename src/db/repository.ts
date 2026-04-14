import type { PoolClient, QueryResultRow } from 'pg';
import { pool, withTransaction } from './pool';
import type { ActDraft, ActGenerationJob, BotUser, CurrentOffer, PaymentRecord, UserSession } from '../types';
import { toDbDateStringOrNull } from '../utils/dates';

type DB = PoolClient | typeof pool;

type PriceUserType = 'ordinary' | 'verified';

const toBotUser = (row: QueryResultRow): BotUser => ({
  id: Number(row.id),
  maxUserId: Number(row.max_user_id),
  username: row.username,
  firstName: row.first_name,
  lastName: row.last_name,
  userFullname: row.user_fullname,
  orgName: row.org_name,
  contactNumber1: row.contact_number_1 ?? '+7 (495) 123-30-70',
  contactNumber2: row.contact_number_2 ?? '',
  verified: row.verified,
  acceptedOfferVersion: row.accepted_offer_version,
  acceptedOfferAt: row.accepted_offer_at,
  balanceRub: Number(row.balance_rub),
  actsCount: Number(row.acts_count),
});

const toPaymentRecord = (row: QueryResultRow): PaymentRecord => ({
  id: Number(row.id),
  userId: Number(row.user_id),
  kind: row.kind,
  status: row.status,
  amountRub: Number(row.amount_rub),
  providerPaymentId: row.provider_payment_id,
  confirmationUrl: row.confirmation_url,
  metadata: row.metadata ?? {},
});

const toActGenerationJob = (row: QueryResultRow): ActGenerationJob => ({
  id: Number(row.id),
  userId: Number(row.user_id),
  pendingActId: row.pending_act_id == null ? null : Number(row.pending_act_id),
  paymentId: row.payment_id == null ? null : Number(row.payment_id),
  status: row.status,
  draft: row.draft,
  priceRub: Number(row.price_rub),
  xlsxPath: row.xlsx_path ?? null,
  pdfPath: row.pdf_path ?? null,
  errorMessage: row.error_message ?? null,
  attempts: Number(row.attempts ?? 0),
});

export class Repository {
  async ensurePrices(): Promise<void> {
    await pool.query(
      `
      INSERT INTO prices(user_type, price_rub)
      VALUES
        ('ordinary', 40),
        ('verified', 0)
      ON CONFLICT (user_type) DO NOTHING
      `,
    );
  }

  async getPrices(): Promise<{ defaultPrice: number; verifiedPrice: number }> {
    const { rows } = await pool.query<{ user_type: PriceUserType; price_rub: number }>(
      'SELECT user_type, price_rub FROM prices WHERE user_type IN ($1, $2)',
      ['ordinary', 'verified'],
    );

    const map = new Map(rows.map((row) => [row.user_type, Number(row.price_rub)]));
    return {
      defaultPrice: map.get('ordinary') ?? 40,
      verifiedPrice: map.get('verified') ?? 0,
    };
  }

  async setPrice(userType: PriceUserType, priceRub: number): Promise<void> {
    await pool.query(
      `
      INSERT INTO prices(user_type, price_rub, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_type) DO UPDATE
      SET price_rub = EXCLUDED.price_rub, updated_at = NOW()
      `,
      [userType, priceRub],
    );
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

  async changeBalance(userId: number, deltaRub: number, db: DB = pool): Promise<number> {
    const { rows } = await db.query(
      `
      UPDATE users
      SET balance_rub = balance_rub + $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING balance_rub
      `,
      [userId, deltaRub],
    );

    if (!rows[0]) {
      throw new Error(`User not found for balance change: ${userId}`);
    }

    return Number(rows[0].balance_rub);
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
    amountRub: number;
    providerPaymentId?: string | null;
    confirmationUrl?: string | null;
    metadata?: Record<string, unknown>;
    db?: DB;
  }): Promise<PaymentRecord> {
    const db = input.db ?? pool;
    const { rows } = await db.query(
      `
      INSERT INTO payments(user_id, kind, status, amount_rub, provider_payment_id, confirmation_url, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
      RETURNING *
      `,
      [
        input.userId,
        input.kind,
        input.status,
        input.amountRub,
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
    priceRub: number;
    status: 'pending' | 'paid' | 'cancelled' | 'completed';
    paymentId?: number | null;
    db?: DB;
  }): Promise<{ id: number }> {
    const db = input.db ?? pool;
    const { rows } = await db.query(
      `
      INSERT INTO pending_acts(user_id, source, draft, price_rub, status, payment_id, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
      RETURNING id
      `,
      [input.userId, input.source, JSON.stringify(input.draft), input.priceRub, input.status, input.paymentId ?? null],
    );

    return { id: Number(rows[0].id) };
  }

  async getPendingAct(id: number): Promise<{
    id: number;
    userId: number;
    source: 'manual' | 'submission';
    draft: ActDraft;
    priceRub: number;
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
      priceRub: Number(rows[0].price_rub),
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

  async enqueueActGenerationJob(input: {
    userId: number;
    pendingActId?: number | null;
    paymentId?: number | null;
    draft: ActDraft;
    priceRub: number;
  }): Promise<ActGenerationJob> {
    const { rows } = await pool.query(
      `
      INSERT INTO act_generation_jobs(
        user_id,
        pending_act_id,
        payment_id,
        status,
        draft,
        price_rub,
        updated_at
      )
      VALUES ($1, $2, $3, 'queued', $4::jsonb, $5, NOW())
      ON CONFLICT (pending_act_id) DO NOTHING
      RETURNING *
      `,
      [input.userId, input.pendingActId ?? null, input.paymentId ?? null, JSON.stringify(input.draft), input.priceRub],
    );

    if (rows[0]) {
      return toActGenerationJob(rows[0]);
    }

    if (input.pendingActId != null) {
      const existing = await pool.query('SELECT * FROM act_generation_jobs WHERE pending_act_id = $1 LIMIT 1', [input.pendingActId]);
      if (existing.rows[0]) {
        return toActGenerationJob(existing.rows[0]);
      }
    }

    throw new Error('Unable to enqueue generation job');
  }

  async lockNextQueuedActGenerationJob(): Promise<ActGenerationJob | null> {
    return withTransaction(async (client) => {
      const selected = await client.query(
        `
        SELECT *
        FROM act_generation_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        `,
      );

      if (!selected.rows[0]) {
        return null;
      }

      const id = Number(selected.rows[0].id);
      const updated = await client.query(
        `
        UPDATE act_generation_jobs
        SET status = 'processing',
            attempts = attempts + 1,
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [id],
      );

      return updated.rows[0] ? toActGenerationJob(updated.rows[0]) : null;
    });
  }

  async markActGenerationJobCompleted(input: {
    jobId: number;
    xlsxPath: string;
    pdfPath: string;
  }): Promise<void> {
    await pool.query(
      `
      UPDATE act_generation_jobs
      SET status = 'completed',
          xlsx_path = $2,
          pdf_path = $3,
          error_message = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [input.jobId, input.xlsxPath, input.pdfPath],
    );
  }

  async markActGenerationJobFailed(jobId: number, errorMessage: string): Promise<void> {
    await pool.query(
      `
      UPDATE act_generation_jobs
      SET status = 'failed',
          error_message = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [jobId, errorMessage],
    );
  }

  async getActGenerationJobById(jobId: number): Promise<ActGenerationJob | null> {
    const { rows } = await pool.query('SELECT * FROM act_generation_jobs WHERE id = $1 LIMIT 1', [jobId]);
    return rows[0] ? toActGenerationJob(rows[0]) : null;
  }

  async createAct(input: {
    userId: number;
    source: 'manual' | 'submission';
    submissionId?: number;
    draft: ActDraft;
    actNumber: string;
    validUntil: string;
    priceRub: number;
    paymentId?: number | null;
    xlsxPath?: string | null;
    pdfPath: string;
    db?: DB;
  }): Promise<{ id: number }> {
    const db = input.db ?? pool;
    const { draft } = input;
    const checkDateDb = toDbDateStringOrNull(draft.checkDate);
    if (!checkDateDb) {
      throw new Error(`Invalid checkDate format: "${draft.checkDate}"`);
    }

    const validUntilDb = toDbDateStringOrNull(input.validUntil);
    if (!validUntilDb) {
      throw new Error(`Invalid validUntil format: "${input.validUntil}"`);
    }

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
        price_rub,
        payment_id,
        xlsx_path,
        pdf_path
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::date, $13, $14, $15, $16, $17)
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
        checkDateDb,
        draft.intervalYears,
        validUntilDb,
        draft.result,
        input.priceRub,
        input.paymentId ?? null,
        input.xlsxPath ?? null,
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
        `SELECT COALESCE(SUM(price_rub), 0)::text AS sum
         FROM acts
         WHERE created_at >= date_trunc('day', NOW())`,
      ),
      pool.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(price_rub), 0)::text AS sum
         FROM acts
         WHERE created_at >= date_trunc('month', NOW())`,
      ),
      pool.query<{ sum: string | null }>('SELECT COALESCE(SUM(price_rub), 0)::text AS sum FROM acts'),
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
