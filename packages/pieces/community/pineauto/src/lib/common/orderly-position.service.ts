import { OrderlyEnvironment } from './orderly-config';
import { OrderlyHttpClient, buildOrderlyUrl } from './orderly-http';

/**
 * Position data structure returned by Orderly API
 */
export interface Position {
  symbol: string;
  position_qty: number;
  average_open_price: number;
  mark_price: number;
  unrealized_pnl: number;
  realized_pnl?: number;
  liquidation_price?: number;
  notional?: number;
  leverage?: number;
  margin_ratio?: number;
  cost_position?: number;
  [key: string]: unknown;
}

export interface PositionsResponse {
  success: boolean;
  data?: {
    rows?: Position[];
  };
}

export interface SinglePositionResponse {
  success: boolean;
  data?: Position;
}

/**
 * Close mode options for position liquidation
 */
export type CloseMode = 'FULL' | 'PARTIAL' | 'PERCENT';

/**
 * Fetch all open positions for the account
 *
 * @param params - Client and environment
 * @returns Array of positions or null on error
 */
export async function getPositions(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
}): Promise<Position[] | null> {
  try {
    const response = await params.client.get(buildOrderlyUrl(params.environment, '/v1/positions'));

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] ⚠️ Get positions request failed', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as PositionsResponse;

    if (!result.success || !result.data?.rows) {
      console.warn('[pineauto] ⚠️ Unexpected positions response format', { result });
      return [];
    }

    return result.data.rows;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to fetch positions', { error });
    return null;
  }
}

/**
 * Fetch a specific position by symbol
 *
 * @param params - Client, environment, and symbol
 * @returns Position data or null if not found/error
 */
export async function getPosition(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  symbol: string;
}): Promise<Position | null> {
  try {
    const url = buildOrderlyUrl(params.environment, `/v1/position/${params.symbol}`);
    const response = await params.client.get(url);

    if (!response.ok) {
      const errorBody = await response.text();

      // 404 is expected when no position exists
      if (response.status === 404) {
        console.log(`[pineauto] ℹ️ No open position for ${params.symbol}`);
        return null;
      }

      console.warn('[pineauto] ⚠️ Get position request failed', {
        symbol: params.symbol,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as SinglePositionResponse;

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected position response format', { result });
      return null;
    }

    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to fetch position', { symbol: params.symbol, error });
    return null;
  }
}

/**
 * Calculate the quantity to close based on mode and value
 *
 * @param params - Position and close parameters
 * @returns Calculated quantity to close, or null if invalid
 */
export function calculateCloseQuantity(params: {
  position: Position;
  closeMode: CloseMode;
  quantity?: number;
  percentage?: number;
}): number | null {
  const { position, closeMode, quantity, percentage } = params;
  const positionQty = Math.abs(position.position_qty);

  switch (closeMode) {
    case 'FULL':
      return positionQty;

    case 'PARTIAL':
      if (quantity == null || quantity <= 0) {
        console.warn('[pineauto] ⚠️ PARTIAL mode requires positive quantity', { quantity });
        return null;
      }
      if (quantity > positionQty) {
        console.warn('[pineauto] ⚠️ Requested quantity exceeds position size', {
          requested: quantity,
          available: positionQty,
        });
        return positionQty; // Cap at position size
      }
      return quantity;

    case 'PERCENT':
      if (percentage == null || percentage <= 0 || percentage > 100) {
        console.warn('[pineauto] ⚠️ PERCENT mode requires percentage between 0-100', { percentage });
        return null;
      }
      return positionQty * (percentage / 100);

    default:
      console.error('[pineauto] ❌ Invalid close mode', { closeMode });
      return null;
  }
}

/**
 * Calculate position PnL
 *
 * @param position - Position data
 * @returns Object with unrealized and realized PnL
 */
export function getPositionPnL(position: Position): {
  unrealized: number;
  realized: number;
  total: number;
} {
  const unrealized = position.unrealized_pnl ?? 0;
  const realized = position.realized_pnl ?? 0;

  return {
    unrealized,
    realized,
    total: unrealized + realized,
  };
}

/**
 * Check if position is long or short
 *
 * @param position - Position data
 * @returns 'LONG' | 'SHORT' | null
 */
export function getPositionSide(position: Position): 'LONG' | 'SHORT' | null {
  if (position.position_qty > 0) {
    return 'LONG';
  } else if (position.position_qty < 0) {
    return 'SHORT';
  }
  return null;
}

/**
 * Calculate the opposite side for closing a position
 *
 * @param position - Position data
 * @returns 'BUY' | 'SELL' for closing the position
 */
export function getCloseSide(position: Position): 'BUY' | 'SELL' {
  // If position is SHORT (negative qty), we need to BUY to close
  // If position is LONG (positive qty), we need to SELL to close
  return position.position_qty < 0 ? 'BUY' : 'SELL';
}
