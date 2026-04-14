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

export class ExternalSubmissionService {
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

    let meterModel =
      typeof submission.custom_equipment_type_name === 'string' && submission.custom_equipment_type_name.trim()
        ? submission.custom_equipment_type_name.trim()
        : null;

    if (!meterModel && submission.equipment_type_id != null) {
      const equipment = await externalPool.query<{ name: string }>(
        'SELECT name FROM equipment_types WHERE id = $1 LIMIT 1',
        [submission.equipment_type_id],
      );
      meterModel = equipment.rows[0]?.name?.trim() ?? null;
    }

    const waterType = waterTypeToRu(String(submission.water_type ?? '')) as WaterType | null;
    const address = typeof submission.address === 'string' ? submission.address.trim() : '';
    const serialNumber = typeof submission.meter_number === 'string' ? submission.meter_number.trim() : '';
    const reading = Number(submission.current_value);

    if (!address || !serialNumber || !Number.isFinite(reading) || reading < 0 || !waterType || !meterModel) {
      return { kind: 'incomplete' };
    }

    const userProfile = await externalPool.query<{ data: Record<string, unknown> }>(
      'SELECT to_jsonb(u) AS data FROM users u WHERE id = $1 LIMIT 1',
      [ownerId],
    );

    const data = userProfile.rows[0]?.data ?? {};
    const userFullname = pickFirstString(data, ['full_name', 'fullname', 'user_fullname', 'name']);
    const orgName = pickFirstString(data, ['org_name', 'organization_name', 'company_name']);

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
      },
    };
  }
}

export const externalSubmissionService = new ExternalSubmissionService();

