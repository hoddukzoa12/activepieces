import { OrderlyEnvironment } from './orderly-config';
import { OrderlyHttpClient, buildOrderlyUrl } from './orderly-http';

/**
 * Algo order types supported by Orderly Network
 */
export type AlgoOrderType = 'STOP' | 'TP_SL' | 'POSITIONAL_TP_SL' | 'BRACKET';

/**
 * Trigger price type for conditional orders
 */
export type TriggerPriceType = 'MARK_PRICE' | 'LAST_PRICE' | 'INDEX_PRICE';

/**
 * Side for orders
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Child order for TP/SL
 */
export interface ChildOrder {
  side: OrderSide;
  type: 'TAKE_PROFIT' | 'STOP_LOSS';
  trigger_price: number;
  trigger_price_type?: TriggerPriceType;
  quantity?: number; // Optional for POSITIONAL_TP_SL
  order_type?: 'MARKET' | 'LIMIT';
  price?: number; // For LIMIT orders
}

/**
 * Algo order creation parameters
 */
export interface CreateAlgoOrderParams {
  symbol: string;
  algo_type: AlgoOrderType;
  side: OrderSide;
  trigger_price?: number;
  trigger_price_type?: TriggerPriceType;
  quantity?: number; // Optional for POSITIONAL_TP_SL
  child_orders?: ChildOrder[];
  order_type?: 'MARKET' | 'LIMIT';
  price?: number;
  client_order_id?: string;
}

/**
 * Algo order entity returned by API
 */
export interface AlgoOrder {
  order_id: string;
  client_order_id?: string;
  symbol: string;
  algo_type: AlgoOrderType;
  side: OrderSide;
  status: string;
  trigger_price?: number;
  trigger_price_type?: TriggerPriceType;
  quantity?: number;
  child_orders?: ChildOrder[];
  created_time?: number;
  updated_time?: number;
  [key: string]: unknown;
}

export interface AlgoOrderResponse {
  success: boolean;
  data?: AlgoOrder;
  timestamp?: number;
}

export interface AlgoOrdersResponse {
  success: boolean;
  data?: {
    rows?: AlgoOrder[];
  };
}

/**
 * Create an algorithmic order
 *
 * Supports: STOP, TP_SL, POSITIONAL_TP_SL, BRACKET
 *
 * @param params - Client, environment, and order parameters
 * @returns Created algo order or null on error
 */
export async function createAlgoOrder(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  orderParams: CreateAlgoOrderParams;
}): Promise<AlgoOrder | null> {
  const { client, environment, orderParams } = params;

  try {
    const url = buildOrderlyUrl(environment, '/v1/algo/order');
    const body = {
      symbol: orderParams.symbol,
      algo_type: orderParams.algo_type,
      side: orderParams.side,
      ...(orderParams.trigger_price != null && { trigger_price: orderParams.trigger_price }),
      ...(orderParams.trigger_price_type && { trigger_price_type: orderParams.trigger_price_type }),
      ...(orderParams.quantity != null && { quantity: orderParams.quantity }),
      ...(orderParams.child_orders && { child_orders: orderParams.child_orders }),
      ...(orderParams.order_type && { order_type: orderParams.order_type }),
      ...(orderParams.price != null && { price: orderParams.price }),
      ...(orderParams.client_order_id && { client_order_id: orderParams.client_order_id }),
    };

    const response = await client.post(url, {
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();

      let errorMessage = 'Create algo order request failed';
      if (response.status === 400) {
        errorMessage = 'Invalid algo order parameters';
      } else if (response.status === 403) {
        errorMessage = 'Insufficient balance or invalid position for algo order';
      } else if (response.status === 429) {
        errorMessage = 'Rate limit exceeded';
      }

      console.error(`[pineauto] ❌ ${errorMessage}`, {
        orderParams,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as AlgoOrderResponse;

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected create algo order response format', { result });
      return null;
    }

    console.log(`[pineauto] ✅ Algo order created: ${result.data.order_id} (${orderParams.algo_type})`);
    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to create algo order', { orderParams, error });
    return null;
  }
}

/**
 * Create a TP/SL order (helper function)
 *
 * @param params - Client, environment, and TP/SL parameters
 * @returns Created algo order or null on error
 */
export async function createTPSL(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  symbol: string;
  side: OrderSide;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  quantity?: number; // Optional for POSITIONAL_TP_SL
  usePositional?: boolean;
}): Promise<AlgoOrder | null> {
  const { symbol, side, takeProfitPrice, stopLossPrice, quantity, usePositional = false } = params;

  if (!takeProfitPrice && !stopLossPrice) {
    console.error('[pineauto] ❌ At least one of takeProfitPrice or stopLossPrice must be provided');
    return null;
  }

  const childOrders: ChildOrder[] = [];

  if (takeProfitPrice) {
    childOrders.push({
      side,
      type: 'TAKE_PROFIT',
      trigger_price: takeProfitPrice,
      trigger_price_type: 'MARK_PRICE',
      ...(quantity != null && !usePositional && { quantity }),
      order_type: 'MARKET',
    });
  }

  if (stopLossPrice) {
    childOrders.push({
      side,
      type: 'STOP_LOSS',
      trigger_price: stopLossPrice,
      trigger_price_type: 'MARK_PRICE',
      ...(quantity != null && !usePositional && { quantity }),
      order_type: 'MARKET',
    });
  }

  return createAlgoOrder({
    client: params.client,
    environment: params.environment,
    orderParams: {
      symbol,
      algo_type: usePositional ? 'POSITIONAL_TP_SL' : 'TP_SL',
      side,
      child_orders: childOrders,
      trigger_price_type: 'MARK_PRICE',
      ...(quantity != null && !usePositional && { quantity }),
    },
  });
}

/**
 * Create a BRACKET order (entry + TP + SL)
 *
 * @param params - Client, environment, and bracket parameters
 * @returns Created algo order or null on error
 */
export async function createBracketOrder(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  symbol: string;
  side: OrderSide;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
}): Promise<AlgoOrder | null> {
  const { symbol, side, entryPrice, takeProfitPrice, stopLossPrice, quantity } = params;

  const childOrders: ChildOrder[] = [
    {
      side,
      type: 'TAKE_PROFIT',
      trigger_price: takeProfitPrice,
      trigger_price_type: 'MARK_PRICE',
      quantity,
      order_type: 'MARKET',
    },
    {
      side,
      type: 'STOP_LOSS',
      trigger_price: stopLossPrice,
      trigger_price_type: 'MARK_PRICE',
      quantity,
      order_type: 'MARKET',
    },
  ];

  return createAlgoOrder({
    client: params.client,
    environment: params.environment,
    orderParams: {
      symbol,
      algo_type: 'BRACKET',
      side,
      trigger_price: entryPrice,
      trigger_price_type: 'MARK_PRICE',
      quantity,
      child_orders: childOrders,
      order_type: 'LIMIT',
      price: entryPrice,
    },
  });
}

/**
 * Edit an existing algo order
 *
 * Rate limit: 5 requests per 1 second
 * Note: Only price or quantity can be amended
 *
 * @param params - Client, environment, order ID, and edit parameters
 * @returns Updated status or null on error
 */
export async function editAlgoOrder(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  orderId: string;
  price?: number;
  quantity?: number;
  trigger_price?: number;
}): Promise<{ status: string } | null> {
  const { client, environment, orderId, price, quantity, trigger_price } = params;

  if (price == null && quantity == null && trigger_price == null) {
    console.error('[pineauto] ❌ At least one of price, quantity, or trigger_price must be provided');
    return null;
  }

  try {
    const url = buildOrderlyUrl(environment, '/v1/algo/order');
    const body = {
      order_id: orderId,
      ...(price != null && { price }),
      ...(quantity != null && { quantity }),
      ...(trigger_price != null && { trigger_price }),
    };

    const response = await client.request(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[pineauto] ❌ Edit algo order request failed', {
        orderId,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as { success: boolean; data?: { status: string } };

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected edit algo order response format', { result });
      return null;
    }

    console.log(`[pineauto] ✅ Algo order ${orderId} edited: ${result.data.status}`);
    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to edit algo order', { orderId, error });
    return null;
  }
}

/**
 * Cancel an algo order
 *
 * @param params - Client, environment, and order ID
 * @returns Cancellation status or null on error
 */
export async function cancelAlgoOrder(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  orderId: string;
}): Promise<{ status: string } | null> {
  const { client, environment, orderId } = params;

  try {
    const url = buildOrderlyUrl(environment, '/v1/algo/order');
    url.searchParams.set('order_id', orderId);

    const response = await client.request(url, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[pineauto] ❌ Cancel algo order request failed', {
        orderId,
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as { success: boolean; data?: { status: string } };

    if (!result.success || !result.data) {
      console.warn('[pineauto] ⚠️ Unexpected cancel algo order response format', { result });
      return null;
    }

    console.log(`[pineauto] ✅ Algo order ${orderId} cancelled: ${result.data.status}`);
    return result.data;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to cancel algo order', { orderId, error });
    return null;
  }
}

/**
 * Get algo orders by filters
 *
 * @param params - Client, environment, and optional filters
 * @returns Array of algo orders or null on error
 */
export async function getAlgoOrders(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  symbol?: string;
  algoType?: AlgoOrderType;
  status?: string;
}): Promise<AlgoOrder[] | null> {
  const { client, environment, symbol, algoType, status } = params;

  try {
    const url = buildOrderlyUrl(environment, '/v1/algo/orders');

    if (symbol) {
      url.searchParams.set('symbol', symbol);
    }
    if (algoType) {
      url.searchParams.set('algo_type', algoType);
    }
    if (status) {
      url.searchParams.set('status', status);
    }

    const response = await client.get(url);

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn('[pineauto] ⚠️ Get algo orders request failed', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return null;
    }

    const result = (await response.json()) as AlgoOrdersResponse;

    if (!result.success || !result.data?.rows) {
      console.warn('[pineauto] ⚠️ Unexpected algo orders response format', { result });
      return [];
    }

    return result.data.rows;
  } catch (error) {
    console.error('[pineauto] ❌ Failed to get algo orders', { error });
    return null;
  }
}
