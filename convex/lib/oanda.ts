const DEFAULT_BASE_URL = 'https://api-fxpractice.oanda.com/v3';

function baseUrl() {
  return (process.env.OANDA_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function requireApiKey(): string {
  const key = process.env.OANDA_API_KEY;
  if (!key) {
    throw new Error(
      'Missing OANDA_API_KEY environment variable. Set it to your OANDA REST API token to enable live trading.',
    );
  }
  return key;
}

function requireAccountId(): string {
  const accountId = process.env.OANDA_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      'Missing OANDA_ACCOUNT_ID environment variable. Set it to the practice or live account you wish to trade.',
    );
  }
  return accountId;
}

export function isOandaConfigured() {
  return !!process.env.OANDA_API_KEY && !!process.env.OANDA_ACCOUNT_ID;
}

async function oandaFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = requireApiKey();
  const headers = new Headers(init.headers || undefined);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OANDA request failed (${response.status} ${response.statusText}): ${text}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string;
  mid: {
    o: string;
    h: string;
    l: string;
    c: string;
  };
}

export async function fetchCandles({
  instrument,
  granularity,
  count,
  price = 'M',
}: {
  instrument: string;
  granularity: string;
  count: number;
  price?: 'M' | 'B' | 'A';
}): Promise<OandaCandle[]> {
  const searchParams = new URLSearchParams({
    price,
    granularity,
    count: Math.min(5000, Math.max(1, count)).toString(),
  });
  const result = await oandaFetch<{ candles: OandaCandle[] }>(
    `/instruments/${instrument}/candles?${searchParams.toString()}`,
  );
  return result.candles ?? [];
}

export interface OandaOrderFill {
  price?: string;
  fullPrice?: {
    price: string;
  };
  pl?: string;
  tradeOpened?: { tradeID: string; units: string };
  tradesOpened?: { tradeID: string; units: string }[];
  tradeReduced?: { tradeID: string; units: string };
  tradesClosed?: { tradeID: string; units: string }[];
}

export interface OandaOrderResponse {
  orderCreateTransaction?: Record<string, any>;
  orderFillTransaction?: OandaOrderFill;
  orderFillTransactions?: OandaOrderFill[];
  relatedTransactionIDs?: string[];
  lastTransactionID?: string;
}

export async function placeMarketOrder({
  instrument,
  units,
  takeProfitPrice,
  stopLossPrice,
}: {
  instrument: string;
  units: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}): Promise<OandaOrderResponse> {
  const accountId = requireAccountId();
  const body: Record<string, any> = {
    order: {
      instrument,
      units: units.toString(),
      timeInForce: 'FOK',
      type: 'MARKET',
      positionFill: 'DEFAULT',
    },
  };
  if (takeProfitPrice) {
    body.order.takeProfitOnFill = { price: takeProfitPrice.toFixed(5) };
  }
  if (stopLossPrice) {
    body.order.stopLossOnFill = { price: stopLossPrice.toFixed(5) };
  }
  return await oandaFetch<OandaOrderResponse>(`/accounts/${accountId}/orders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function closeTrade(tradeId: string): Promise<OandaOrderResponse> {
  const accountId = requireAccountId();
  return await oandaFetch<OandaOrderResponse>(`/accounts/${accountId}/trades/${tradeId}/close`, {
    method: 'PUT',
    body: JSON.stringify({ units: 'ALL' }),
  });
}

export interface OandaTrade {
  id?: string;
  tradeID?: string;
  instrument: string;
  price: string;
  currentUnits: string;
  unrealizedPL?: string;
}

export async function getOpenTrades(): Promise<OandaTrade[]> {
  const accountId = requireAccountId();
  const result = await oandaFetch<{ trades: OandaTrade[] }>(`/accounts/${accountId}/openTrades`);
  return result.trades ?? [];
}
