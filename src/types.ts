export type WaterType = 'ХВС' | 'ГВС';
export type ActResult = 'fit' | 'unfit';
export type ActSource = 'manual' | 'submission';

export type ActDraft = {
  source: ActSource;
  submissionId?: number;
  address: string;
  waterType: WaterType;
  meterModel: string;
  serialNumber: string;
  currentReading: number;
  checkDate: string;
  intervalYears: 4 | 5 | 6;
  result: ActResult;
};

export type BotUser = {
  id: number;
  maxUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  userFullname: string | null;
  orgName: string | null;
  verified: boolean;
  acceptedOfferVersion: string | null;
  acceptedOfferAt: Date | null;
  balanceKopecks: number;
  actsCount: number;
};

export type CurrentOffer = {
  id: number;
  version: string;
  filePath: string;
  createdByMaxId: number;
};

export type PaymentRecord = {
  id: number;
  userId: number;
  kind: 'top_up' | 'one_time' | 'refund' | 'balance_charge';
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amountKopecks: number;
  providerPaymentId: string | null;
  confirmationUrl: string | null;
  metadata: Record<string, unknown>;
};

export type SessionState =
  | 'idle'
  | 'manual_address'
  | 'manual_water_type'
  | 'manual_meter_model'
  | 'manual_serial'
  | 'manual_reading'
  | 'manual_check_date'
  | 'manual_interval'
  | 'manual_result'
  | 'manual_confirm'
  | 'import_wait_submission_id'
  | 'import_confirmation'
  | 'import_check_date'
  | 'import_interval'
  | 'import_result'
  | 'import_confirm'
  | 'topup_custom_amount'
  | 'admin_new_offer_wait_file'
  | 'admin_new_offer_wait_version'
  | 'admin_broadcast_wait_text';

export type UserSession = {
  state: SessionState;
  data: Record<string, unknown>;
};

export type SubmissionImport = {
  submissionId: number;
  externalUserId: number;
  address: string;
  serialNumber: string;
  currentReading: number;
  waterType: WaterType;
  meterModel: string;
  userFullname: string | null;
  orgName: string | null;
};

