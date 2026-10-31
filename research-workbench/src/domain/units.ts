export type UnitKind = 'currency' | 'per_share' | 'percent' | 'multiple' | 'shares' | 'count' | 'number';
export type Scale = 1 | 1e3 | 1e6 | 1e8 | 1e9;

export interface Unit {
  kind: UnitKind;
  /** ISO currency code for `currency` and `per_share`. */
  currency?: string;
  /** Magnitude of stored numbers. 1e8 = 億 (hundred million). Percent/multiple/per_share are always 1. */
  scale: Scale;
  /** Free-text label for count/number units, e.g. "units", "GW". */
  label?: string;
}

export const UNIT_KINDS: { value: UnitKind; label: string }[] = [
  { value: 'currency', label: 'Currency amount' },
  { value: 'per_share', label: 'Per share' },
  { value: 'percent', label: 'Percent' },
  { value: 'multiple', label: 'Multiple (x)' },
  { value: 'shares', label: 'Shares' },
  { value: 'count', label: 'Count / units' },
  { value: 'number', label: 'Plain number' },
];

export const SCALES: { value: Scale; label: string; short: string }[] = [
  { value: 1, label: 'units (1)', short: '' },
  { value: 1e3, label: 'thousand', short: 'k' },
  { value: 1e6, label: 'million', short: 'mn' },
  { value: 1e8, label: '億 (100 million)', short: '億' },
  { value: 1e9, label: 'billion', short: 'bn' },
];

export const CURRENCIES = ['TWD', 'USD', 'CNY', 'JPY', 'KRW', 'EUR', 'HKD'];

/** Kinds whose numbers never carry a magnitude. */
export function isScaleFree(kind: UnitKind): boolean {
  return kind === 'percent' || kind === 'multiple' || kind === 'per_share';
}

export function hasCurrency(kind: UnitKind): boolean {
  return kind === 'currency' || kind === 'per_share';
}

/** Units that behave like pure numbers in multiplication (a growth rate, a multiple, a bare number). */
export function isDimensionless(u: Unit | null | undefined): boolean {
  if (!u) return false;
  return u.kind === 'percent' || u.kind === 'multiple' || (u.kind === 'number' && !u.label);
}

export function normalizeUnit(u: Unit): Unit {
  const out: Unit = { kind: u.kind, scale: isScaleFree(u.kind) ? 1 : u.scale };
  if (hasCurrency(u.kind)) out.currency = u.currency || 'TWD';
  if ((u.kind === 'count' || u.kind === 'number') && u.label) out.label = u.label;
  return out;
}

export function scaleShort(scale: Scale): string {
  return SCALES.find((s) => s.value === scale)?.short ?? String(scale);
}

/** Short human label: "TWD 億", "%", "x", "TWD/sh", "億 sh", "k units". */
export function unitLabel(u: Unit | null | undefined): string {
  if (!u) return '';
  const sc = scaleShort(u.scale);
  switch (u.kind) {
    case 'currency':
      return [u.currency ?? '', sc].filter(Boolean).join(' ');
    case 'per_share':
      return `${u.currency ?? ''}/sh`;
    case 'percent':
      return '%';
    case 'multiple':
      return 'x';
    case 'shares':
      return [sc, 'sh'].filter(Boolean).join(' ');
    case 'count':
    case 'number':
      return [sc, u.label ?? ''].filter(Boolean).join(' ');
  }
}

export function sameUnit(a: Unit | null | undefined, b: Unit | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    (a.currency ?? '') === (b.currency ?? '') &&
    a.scale === b.scale &&
    (a.label ?? '') === (b.label ?? '')
  );
}

/**
 * Whether adding/subtracting two quantities is dimensionally suspicious.
 * Only flags cases where both units are known and clearly differ in currency, scale or kind.
 */
export function additiveMismatch(a: Unit, b: Unit): string | null {
  if (isDimensionless(a) && isDimensionless(b)) return null;
  if (isDimensionless(a) || isDimensionless(b)) return null;
  if (a.kind !== b.kind) return `${unitLabel(a)} combined with ${unitLabel(b)}`;
  if ((a.currency ?? '') !== (b.currency ?? '')) return `${unitLabel(a)} combined with ${unitLabel(b)} (different currencies)`;
  if (a.scale !== b.scale) return `${unitLabel(a)} combined with ${unitLabel(b)} (different scales)`;
  return null;
}
