import { addYears, format, isValid, parse, subDays } from 'date-fns';

export const DATE_VIEW_FORMAT = 'dd.MM.yyyy';

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

export const computeValidUntil = (checkDate: Date, intervalYears: number): Date => {
  return subDays(addYears(checkDate, intervalYears), 1);
};

export const isFutureDate = (value: Date): boolean => {
  const today = new Date();
  const onlyDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const candidate = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  return candidate > onlyDate;
};

