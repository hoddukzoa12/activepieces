import { OrderlyEnvironment } from './orderly-config';
import { OrderlyHttpClient, buildOrderlyUrl } from './orderly-http';

export interface AccountInfoResponse {
  data?: Record<string, unknown>;
}

export interface AccountBalancesResponse {
  data?: Record<string, unknown>;
}

export async function fetchAccountInfo(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
}): Promise<AccountInfoResponse | null> {
  try {
    const response = await params.client.get(buildOrderlyUrl(params.environment, '/v1/client/info'));
    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] account info request failed', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    return (await response.json()) as AccountInfoResponse;
  } catch (error) {
    console.warn('[pineauto] Failed to fetch account info', { error });
    return null;
  }
}

export async function fetchAccountBalances(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
}): Promise<AccountBalancesResponse | null> {
  try {
    const response = await params.client.get(buildOrderlyUrl(params.environment, '/v1/client/balance'));
    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] account balance request failed', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    return (await response.json()) as AccountBalancesResponse;
  } catch (error) {
    console.warn('[pineauto] Failed to fetch account balances', { error });
    return null;
  }
}

export async function fetchClientHolding(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
}): Promise<AccountBalancesResponse | null> {
  try {
    const response = await params.client.get(buildOrderlyUrl(params.environment, '/v1/client/holding'));
    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] client holding request failed', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    return (await response.json()) as AccountBalancesResponse;
  } catch (error) {
    console.warn('[pineauto] Failed to fetch client holding', { error });
    return null;
  }
}

export function extractAvailableBalance(
  info: AccountInfoResponse | null,
  quoteAsset?: string | null,
): number | null {
  if (!info || !info.data) {
    return null;
  }

  const directKeys = [
    'total_available_balance',
    'available_balance',
    'available',
    'free_collateral',
    'available_withdrawal',
  ];

  for (const key of directKeys) {
    const value = info.data[key];
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  const balances =
    (info.data['balances'] as Record<string, unknown> | undefined) ??
    (info.data['asset_balances'] as Record<string, unknown> | undefined) ??
    (info.data['collaterals'] as Record<string, unknown> | undefined);

  if (balances) {
    const candidate = pickBalanceRecord(balances, quoteAsset);
    if (candidate != null) {
      return candidate;
    }
  }

  return null;
}

export function extractAvailableBalanceFromBalances(
  balancesResponse: AccountBalancesResponse | null,
  quoteAsset?: string | null,
): number | null {
  if (!balancesResponse || !balancesResponse.data) {
    return null;
  }

  return pickBalanceRecord(balancesResponse.data, quoteAsset);
}

export function extractBalanceFromHoldings(
  holdingsResponse: AccountBalancesResponse | null,
  quoteAsset?: string | null,
): number | null {
  if (!holdingsResponse || !holdingsResponse.data) {
    return null;
  }

  const data = holdingsResponse.data;
  const holdingList = Array.isArray(data['holding']) ? (data['holding'] as unknown[]) : [];

  for (const entry of holdingList) {
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const asset = getAssetCode(obj);
      if (!quoteAsset || normalizeAsset(asset) === normalizeAsset(quoteAsset)) {
        const numeric = Number(obj['available'] ?? obj['holding'] ?? obj['balance']);
        if (Number.isFinite(numeric)) {
          return numeric;
        }
      }
    }
  }

  return null;
}

function pickBalanceRecord(balances: Record<string, unknown>, quoteAsset?: string | null): number | null {
  if (!balances) {
    return null;
  }

  if (quoteAsset) {
    const normalizedAsset = normalizeAsset(quoteAsset);
    for (const value of Object.values(balances)) {
      if (value && typeof value === 'object') {
        const entry = value as Record<string, unknown>;
        const asset = getAssetCode(entry);
        if (normalizeAsset(asset) === normalizedAsset) {
          return extractNumericBalance(entry);
        }
      }
    }
  }

  for (const value of Object.values(balances)) {
    if (value && typeof value === 'object') {
      const numeric = extractNumericBalance(value);
      if (numeric != null) {
        return numeric;
      }
    }
  }

  return null;
}

function extractNumericBalance(entry: unknown): number | null {
  if (entry && typeof entry === 'object') {
    const keys = ['available_balance', 'available', 'free_collateral', 'holding', 'balance', 'equity'];

    for (const key of keys) {
      if (key in (entry as Record<string, unknown>)) {
        const value = (entry as Record<string, unknown>)[key];
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          return numeric;
        }
      }
    }
  }

  return null;
}

function getAssetCode(entry: unknown): string | null {
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const fields = ['asset', 'symbol', 'token', 'currency'];
    for (const field of fields) {
      const value = obj[field];
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return null;
}

function normalizeAsset(asset: string | null | undefined): string {
  return asset?.toUpperCase?.() ?? '';
}
