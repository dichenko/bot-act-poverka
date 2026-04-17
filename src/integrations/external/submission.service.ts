import { externalPool } from '../../db/pool';
import type { SubmissionImport, WaterType } from '../../types';
import { waterTypeToRu } from '../../utils/format';

type ImportResult =
  | { kind: 'ok'; data: SubmissionImport }
  | { kind: 'not_found' }
  | { kind: 'access_denied' }
  | { kind: 'incomplete' };

const pickFirstString = (source: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const pickFirstNullableInt = (source: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }
  }
  return null;
};

export class ExternalSubmissionService {
  private usersLookupColumnCache: 'user_id' | 'id' | null | undefined;

  private async resolveUsersLookupColumn(): Promise<'user_id' | 'id' | null> {
    if (this.usersLookupColumnCache !== undefined) {
      return this.usersLookupColumnCache;
    }

    const { rows } = await externalPool.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN ('user_id', 'id')
      `,
    );

    const names = new Set(rows.map((row) => row.column_name));
    if (names.has('user_id')) {
      this.usersLookupColumnCache = 'user_id';
      return this.usersLookupColumnCache;
    }

    if (names.has('id')) {
      this.usersLookupColumnCache = 'id';
      return this.usersLookupColumnCache;
    }

    this.usersLookupColumnCache = null;
    return this.usersLookupColumnCache;
  }

  async loadSubmission(submissionId: string, currentMaxUserId: number): Promise<ImportResult> {
    const { rows } = await externalPool.query(
      `
      SELECT
        id,
        user_id,
        meter_number,
        current_value,
        address,
        phone,
        water_type,
        equipment_type_id,
        production_year,
        custom_equipment_type_name
      FROM meter_submissions
      WHERE id::text = $1
      LIMIT 1
      `,
      [submissionId],
    );

    if (!rows[0]) {
      return { kind: 'not_found' };
    }

    const submission = rows[0];
    const resolvedSubmissionId =
      submission.id == null
        ? submissionId
        : typeof submission.id === 'string'
          ? submission.id
          : String(submission.id);
    const ownerId = Number(submission.user_id);
    if (ownerId !== currentMaxUserId) {
      return { kind: 'access_denied' };
    }

    const customMeterModel =
      typeof submission.custom_equipment_type_name === 'string' && submission.custom_equipment_type_name.trim()
        ? submission.custom_equipment_type_name.trim()
        : null;

    const equipmentTypeIdRaw = submission.equipment_type_id;
    const equipmentTypeId =
      equipmentTypeIdRaw == null
        ? null
        : typeof equipmentTypeIdRaw === 'string'
          ? equipmentTypeIdRaw.trim() || null
          : String(equipmentTypeIdRaw).trim() || null;

    let meterModel: string | null = null;
    if (equipmentTypeId) {
      const equipment = await externalPool.query<{ name: string }>(
        'SELECT name FROM equipment_types WHERE id::text = $1 LIMIT 1',
        [equipmentTypeId],
      );
      meterModel = equipment.rows[0]?.name?.trim() ?? null;
    } else {
      meterModel = customMeterModel;
    }

    const waterType = waterTypeToRu(String(submission.water_type ?? '')) as WaterType | null;
    const address = typeof submission.address === 'string' ? submission.address.trim() : '';
    const serialNumber = typeof submission.meter_number === 'string' ? submission.meter_number.trim() : '';
    const reading = Number(submission.current_value);

    if (!address || !serialNumber || !Number.isFinite(reading) || reading < 0 || !waterType || !meterModel) {
      return { kind: 'incomplete' };
    }

    const usersLookupColumn = await this.resolveUsersLookupColumn();
    let data: Record<string, unknown> = {};
    if (usersLookupColumn) {
      const userProfile = await externalPool.query<{ data: Record<string, unknown> }>(
        `SELECT to_jsonb(u) AS data FROM users u WHERE ${usersLookupColumn}::text = $1 LIMIT 1`,
        [String(ownerId)],
      );
      data = userProfile.rows[0]?.data ?? {};
    }

    const userFullname = pickFirstString(data, ['full_name', 'fullname', 'user_fullname', 'name']);
    const orgName = pickFirstString(data, ['org_name', 'organization_name', 'company_name']);
    const orgId = pickFirstNullableInt(data, ['org_id']);

    return {
      kind: 'ok',
      data: {
        submissionId: resolvedSubmissionId,
        externalUserId: ownerId,
        address,
        serialNumber,
        currentReading: reading,
        waterType,
        meterModel,
        userFullname,
        orgName,
        orgId,
      },
    };
  }
}

export const externalSubmissionService = new ExternalSubmissionService();

