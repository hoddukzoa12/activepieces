import { OrderlyEnvironment, resolveOrderlyBaseUrl } from './orderly-config';

export async function fetchReferencePrice(params: {
  environment: OrderlyEnvironment;
  symbol: string;
  fallbackPrice?: number;
}): Promise<number> {
  const { environment, symbol, fallbackPrice } = params;

  if (Number.isFinite(fallbackPrice) && fallbackPrice && fallbackPrice > 0) {
    return Number(fallbackPrice);
  }

  const baseUrl = resolveOrderlyBaseUrl(environment);

  const numericFromFutures = await tryFetchFuturesPrice(baseUrl, symbol);
  if (numericFromFutures != null) {
    return numericFromFutures;
  }

  const numericFromMarketInfo = await tryFetchMarketInfoPrice(baseUrl, symbol);
  if (numericFromMarketInfo != null) {
    return numericFromMarketInfo;
  }

  const numericFromTrades = await tryFetchRecentTradePrice(baseUrl, symbol);
  if (numericFromTrades != null) {
    return numericFromTrades;
  }

  throw new Error(
    'Market price could not be determined automatically. Provide a price in the trigger payload or ensure recent trades exist.',
  );
}

async function tryFetchFuturesPrice(baseUrl: string, symbol: string): Promise<number | null> {
  try {
    const futuresUrl = `${baseUrl}/v1/public/futures/${encodeURIComponent(symbol)}`;
    const response = await fetch(futuresUrl);
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as Record<string, unknown>;
    return extractPriceFromData(body['data']);
  } catch (error) {
    console.warn('[pineauto] Failed to fetch futures ticker price', { symbol, error });
    return null;
  }
}

async function tryFetchMarketInfoPrice(baseUrl: string, symbol: string): Promise<number | null> {
  try {
    const tickerUrl = new URL(`${baseUrl}/v1/public/market_info`);
    tickerUrl.searchParams.set('symbol', symbol);
    const response = await fetch(tickerUrl);
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as Record<string, unknown>;
    return extractPriceFromData(body['data']) ?? firstPositiveNumber(body['mark_price'], body['last_price']);
  } catch (error) {
    console.warn('[pineauto] Failed to fetch market ticker price', { symbol, error });
    return null;
  }
}

async function tryFetchRecentTradePrice(baseUrl: string, symbol: string): Promise<number | null> {
  try {
    const tradesUrl = new URL(`${baseUrl}/v1/public/market_trades`);
    tradesUrl.searchParams.set('symbol', symbol);
    tradesUrl.searchParams.set('limit', '1');
    const response = await fetch(tradesUrl);
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as Record<string, unknown>;
    const data = body['data'];
    const trades: Array<Record<string, unknown>> = [];

    if (Array.isArray(data)) {
      trades.push(...(data as Array<Record<string, unknown>>));
    } else if (data && typeof data === 'object') {
      const rows = (data as Record<string, unknown>)['rows'];
      if (Array.isArray(rows)) {
        trades.push(...(rows as Array<Record<string, unknown>>));
      }
    } else if (Array.isArray(body)) {
      trades.push(...(body as Array<Record<string, unknown>>));
    }

    const firstTrade = trades[0];
    if (!firstTrade) {
      return null;
    }

    return firstPositiveNumber(firstTrade['price'], firstTrade['trade_price'], firstTrade['executed_price']);
  } catch (error) {
    console.warn('[pineauto] Failed to fetch recent trade price', { symbol, error });
    return null;
  }
}

function extractPriceFromData(data: unknown): number | null {
  if (Array.isArray(data)) {
    for (const entry of data as Array<Record<string, unknown>>) {
      const numeric = firstPositiveNumber(
        entry?.['mark_price'],
        entry?.['last_price'],
        entry?.['index_price'],
        entry?.['24h_close'],
      );
      if (numeric != null) {
        return numeric;
      }
    }
  }

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const numeric = firstPositiveNumber(record['mark_price'], record['last_price'], record['index_price'], record['24h_close']);
    if (numeric != null) {
      return numeric;
    }
  }

  return null;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}
