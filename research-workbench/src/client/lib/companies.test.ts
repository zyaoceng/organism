import { describe, expect, it } from 'vitest';
import { matchCompanies, norm, type CompanyEntry } from './companies';

const c = (id: string, name: string, ticker: string, o: Partial<CompanyEntry> = {}): CompanyEntry => ({
  id,
  name,
  ticker,
  apiSymbol: `${ticker}.TW`,
  exchange: 'TWSE',
  archived: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...o,
});

const LIST = [
  c('liteon', '光寶科 Lite-On Technology', '2301', { updatedAt: '2026-10-03T00:00:00.000Z' }),
  c('delta', '台達電 Delta Electronics', '2308', { updatedAt: '2026-10-05T00:00:00.000Z' }),
  c('credo', 'Credo Technology', 'CRDO', { apiSymbol: 'CRDO', exchange: 'NASDAQ', updatedAt: '2026-10-04T00:00:00.000Z' }),
  c('old', '舊公司 Old 2301 Holdings', '9999', { archived: true, updatedAt: '2026-10-09T00:00:00.000Z' }),
];
const ids = (xs: CompanyEntry[]) => xs.map((x) => x.id);

describe('company matching', () => {
  it('normalises full-width characters and case', () => {
    expect(norm(' ２３０１ ')).toBe('2301');
    expect(norm('ＣＲＤＯ')).toBe('crdo');
    expect(ids(matchCompanies(LIST, '２３０１'))).toEqual(['liteon', 'old']);
  });

  it('ranks an exact code before a code prefix, a name prefix, a name substring and a code substring', () => {
    const list = [
      c('sub', 'Zeta', '12301'), // code contains
      c('name-in', 'Big 230 Corp', '1111'), // name contains
      c('name-pre', '230 Group', '2222'), // name prefix
      c('pre', 'Alpha', '2301X'), // code prefix
      c('exact', 'Beta', '230'), // exact code
    ];
    expect(ids(matchCompanies(list, '230'))).toEqual(['exact', 'pre', 'name-pre', 'name-in', 'sub']);
    expect(ids(matchCompanies(LIST, 'crdo'))[0]).toBe('credo');
    expect(ids(matchCompanies(LIST, '2301.tw'))).toEqual(['liteon']);
  });

  it('matches a Chinese substring of the name', () => {
    expect(ids(matchCompanies(LIST, '達電'))).toEqual(['delta']);
    expect(ids(matchCompanies(LIST, 'technology'))).toEqual(['credo', 'liteon']);
  });

  it('leaves out the excluded company and puts archived ones last', () => {
    expect(ids(matchCompanies(LIST, '2301', { excludeId: 'liteon' }))).toEqual(['old']);
    // the archived company was edited most recently and matches by name, still after the active one
    expect(ids(matchCompanies(LIST, '2301'))).toEqual(['liteon', 'old']);
  });

  it('lists recent active companies for an empty query, up to the limit', () => {
    expect(ids(matchCompanies(LIST, ''))).toEqual(['delta', 'credo', 'liteon']);
    expect(ids(matchCompanies(LIST, '  ', { limit: 2 }))).toEqual(['delta', 'credo']);
    expect(ids(matchCompanies(LIST, '', { excludeId: 'delta' }))).toEqual(['credo', 'liteon']);
    expect(matchCompanies(LIST, 'zzz')).toEqual([]);
  });

  it('returns every match with an unlimited limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`c${i}`, `Co ${i}`, String(1000 + i)));
    expect(matchCompanies(many, 'co')).toHaveLength(8);
    expect(matchCompanies(many, 'co', { limit: Infinity })).toHaveLength(12);
  });
});
