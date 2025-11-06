import { OrderlyEnvironment } from './orderly-config';
import { OrderlyHttpClient, buildOrderlyUrl } from './orderly-http';

/**
 * Leverage setting response from Orderly API
 */
export interface LeverageSetting {
  symbol: string;
  leverage: number;
  max_leverage?: number;
  current_leverage?: number;
  [key: string]: unknown;
}

export interface LeverageResponse {
  success: boolean;
  data?: LeverageSetting;
}

export interface MaxLeverageResponse {
  success: boolean;
  data?: {
    [symbol: string]: {
      max_leverage: number;
      base_imr?: number;
      [key: string]: unknown;
    };
  };
}

/**
 * Leverage validation constraints
 */
export const LEVERAGE_CONSTRAINTS = {
  MIN: 1,
  MAX: 50,
  DEFAULT: 10,
} as const;

/**
 * Get current leverage setting for a symbol
 *
 * @param params - Client, environment, and symbol
 * @returns Current leverage setting or null on error
 */
export async function getLeverage(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  symbol: string;
}): Promise<LeverageSetting | null> {
  try {
    const url = buildOrderlyUrl(params.environment, '/v1/client/leverage');
    url.searchParams.set('symbol', params.symbol);

    const response = await params.client.get(url);

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] ⚠️ Get leverage request failed', {
        symbol: params.symbol,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as LeverageResponse;

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected leverage response format', { result });
      return null;
    }

    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to get leverage', { symbol: params.symbol, error });
    return null;
  }
}

/**
 * Update leverage setting for a symbol
 *
 * Rate limit: 5 requests per 60 seconds per user
 * Validates: leverage range, position notional, margin sufficiency
 *
 * @param params - Client, environment, symbol, and leverage value
 * @returns Updated leverage setting or null on error
 */
export async function setLeverage(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  symbol: string;
  leverage: number;
}): Promise<LeverageSetting | null> {
  const { client, environment, symbol, leverage } = params;

  // Pre-validate leverage range
  const validation = validateLeverage(leverage);
  if (!validation.valid) {
    console.error('[pineauto] ❌ Invalid leverage value', {
      leverage,
      error: validation.error,
    });
    return null;
  }

  try {
    const url = buildOrderlyUrl(environment, '/v1/client/leverage');
    const body = {
      symbol,
      leverage,
    };

    const response = await client.post(url, {
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();

      // Provide specific error messages for common failures
      let errorMessage = 'Set leverage request failed';
      if (response.status === 400) {
        errorMessage = 'Invalid leverage parameters or position constraints violated';
      } else if (response.status === 403) {
        errorMessage = 'Insufficient margin for requested leverage';
      } else if (response.status === 429) {
        errorMessage = 'Rate limit exceeded (max 5 requests per 60 seconds)';
      }

      console.error(`[pineauto] ❌ ${errorMessage}`, {
        symbol,
        leverage,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as LeverageResponse;

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected set leverage response format', { result });
      return null;
    }

    console.log(`[pineauto] ✅ Leverage set to ${leverage}x for ${symbol}`);
    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to set leverage', {
      symbol,
      leverage,
      error,
    });
    return null;
  }
}

/**
 * Get system-wide maximum leverage parameters (public endpoint)
 *
 * @param params - Client and environment
 * @returns Maximum leverage configuration for all symbols
 */
export async function getMaxLeverage(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
}): Promise<MaxLeverageResponse['data'] | null> {
  try {
    const url = buildOrderlyUrl(params.environment, '/v1/public/leverage');
    const response = await params.client.get(url);

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] ⚠️ Get max leverage request failed', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as MaxLeverageResponse;

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected max leverage response format', { result });
      return null;
    }

    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to get max leverage', { error });
    return null;
  }
}

/**
 * Validate leverage value against constraints
 *
 * @param leverage - Leverage value to validate
 * @returns Validation result with error message if invalid
 */
export function validateLeverage(leverage: number): {
  valid: boolean;
  error?: string;
} {
  if (!Number.isFinite(leverage)) {
    return {
      valid: false,
      error: 'Leverage must be a valid number',
    };
  }

  if (leverage < LEVERAGE_CONSTRAINTS.MIN) {
    return {
      valid: false,
      error: `Leverage must be at least ${LEVERAGE_CONSTRAINTS.MIN}x`,
    };
  }

  if (leverage > LEVERAGE_CONSTRAINTS.MAX) {
    return {
      valid: false,
      error: `Leverage cannot exceed ${LEVERAGE_CONSTRAINTS.MAX}x`,
    };
  }

  if (!Number.isInteger(leverage)) {
    return {
      valid: false,
      error: 'Leverage must be an integer value',
    };
  }

  return { valid: true };
}

/**
 * Get symbol-specific max leverage from public data
 *
 * @param maxLeverageData - Data from getMaxLeverage()
 * @param symbol - Symbol to query
 * @returns Max leverage for symbol or null if not found
 */
export function getSymbolMaxLeverage(
  maxLeverageData: MaxLeverageResponse['data'] | null,
  symbol: string,
): number | null {
  if (!maxLeverageData) {
    return null;
  }

  const symbolData = maxLeverageData[symbol];
  if (!symbolData) {
    return null;
  }

  return symbolData.max_leverage ?? null;
}

/**
 * Validate leverage against symbol-specific constraints
 *
 * @param params - Leverage value, symbol, and max leverage data
 * @returns Validation result with specific error if invalid
 */
export function validateLeverageForSymbol(params: {
  leverage: number;
  symbol: string;
  maxLeverageData: MaxLeverageResponse['data'] | null;
}): {
  valid: boolean;
  error?: string;
  maxAllowed?: number;
} {
  // First validate against global constraints
  const basicValidation = validateLeverage(params.leverage);
  if (!basicValidation.valid) {
    return basicValidation;
  }

  // Then check symbol-specific max
  const symbolMax = getSymbolMaxLeverage(params.maxLeverageData, params.symbol);
  if (symbolMax != null && params.leverage > symbolMax) {
    return {
      valid: false,
      error: `Leverage for ${params.symbol} cannot exceed ${symbolMax}x`,
      maxAllowed: symbolMax,
    };
  }

  return { valid: true, maxAllowed: symbolMax ?? LEVERAGE_CONSTRAINTS.MAX };
}
