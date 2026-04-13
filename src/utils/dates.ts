import { addYears, format, isValid, parse, subDays } from 'date-fns';

export const DATE_VIEW_FORMAT = 'dd.MM.yyyy';
const DATE_DB_FORMAT = 'yyyy-MM-dd';

export const todayDateString = (): string => format(new Date(), DATE_VIEW_FORMAT);

export const parseDateOrNull = (value: string): Date | null => {
  const normalized = value.trim();
  const parsed = parse(normalized, DATE_VIEW_FORMAT, new Date());
  if (!isValid(parsed)) {
    return null;
  }
  return parsed;
};

export const toDateView = (value: Date): string => format(value, DATE_VIEW_FORMAT);

const parseIsoDateOrNull = (value: string): Date | null => {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }

  const parsed = parse(normalized, DATE_DB_FORMAT, new Date());
  if (!isValid(parsed)) {
    return null;
  }

  return parsed;
};

export const toDbDateStringOrNull = (value: string): string | null => {
  const parsed = parseDateOrNull(value) ?? parseIsoDateOrNull(value);
  if (!parsed) {
    return null;
  }
  return format(parsed, DATE_DB_FORMAT);
};

export const computeValidUntil = (checkDate: Date, intervalYears: number): Date => {
  return subDays(addYears(checkDate, intervalYears), 1);
};

export const isFutureDate = (value: Date): boolean => {
  const today = new Date();
  const onlyDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const candidate = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  return candidate > onlyDate;
};

