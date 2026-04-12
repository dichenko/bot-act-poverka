export const formatRub = (rub: number): string => {
  return `${rub} ₽`;
};

export const waterTypeToRu = (value: string): 'ХВС' | 'ГВС' | null => {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'ХВС' || normalized === 'HVS') {
    return 'ХВС';
  }
  if (normalized === 'ГВС' || normalized === 'GVS') {
    return 'ГВС';
  }
  return null;
};

export const boolResultToText = (result: 'fit' | 'unfit'): string =>
  result === 'fit' ? '✅ Годен' : '❌ Негоден';
