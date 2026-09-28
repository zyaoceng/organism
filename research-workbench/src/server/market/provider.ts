import type { Bar } from '../../domain/market/indicators';

export type MarketErrorCode = 'NOT_FOUND' | 'RATE_LIMITED' | 'NETWORK' | 'PROVIDER' | 'UNSUPPORTED';

export class MarketDataError extends Error {
  constructor(
    public readonly code: MarketErrorCode,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

export interface ProviderQuote {
  price: number;
  currency: string | null;
  /** Provider's market time (ISO). */
  asOf: string;
}

/**
 * Anything that can supply prices. Providers translate their own formats into internal `Bar`s;
 * nothing outside a provider sees provider-specific shapes.
 */
export interface MarketDataProvider {
  id: string;
  label: string;
  description: string;
  /** True for generated data that must never be mistaken for real prices. */
  synthetic: boolean;
  /** False for providers that only hold imported data (CSV). */
  fetches: boolean;
  getQuote(symbol: string): Promise<ProviderQuote>;
  getHistoricalPrices(symbol: string, startDate: string, endDate: string): Promise<Bar[]>;
}
