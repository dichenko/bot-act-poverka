export const CB = {
  ACCEPT_OFFER: 'offer_accept',
  DECLINE_OFFER: 'offer_decline',

  MENU_MANUAL: 'menu_manual',
  MENU_TOPUP: 'menu_topup',
  MENU_HISTORY: 'menu_history',
  MENU_HELP: 'menu_help',
  MENU_IMPORT: 'menu_import',

  WATER_HVS: 'manual_water_hvs',
  WATER_GVS: 'manual_water_gvs',

  INTERVAL_4: 'interval_4',
  INTERVAL_5: 'interval_5',
  INTERVAL_6: 'interval_6',

  RESULT_FIT: 'result_fit',
  RESULT_UNFIT: 'result_unfit',

  DRAFT_CONFIRM: 'draft_confirm',
  CONFIRM_DRAFT: 'draft_confirm',
  CANCEL: 'operation_cancel',

  INSUFFICIENT_ONE_TIME: 'insufficient_one_time',
  INSUFFICIENT_TOPUP: 'insufficient_topup',

  TOPUP_10: 'topup_1000',
  TOPUP_50: 'topup_5000',
  TOPUP_100: 'topup_10000',
  TOPUP_OTHER: 'topup_other',

  IMPORT_CONFIRM: 'import_confirm',

  HISTORY_PREFIX: 'history_',
} as const;

export const historyPayload = (actId: number): string => `${CB.HISTORY_PREFIX}${actId}`;

