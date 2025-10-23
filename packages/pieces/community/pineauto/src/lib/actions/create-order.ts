import { createAction, Property } from '@activepieces/pieces-framework';
import { PineautoAuthType } from '../common/orderly-auth';
import {
  applyQuantityStep,
  determineFlexibleQuantityStep,
  normalizeNumber,
  parseQuoteAsset,
  resolveOrderSizing,
} from '../common/order-sizing.service';
import {
  consumeQueuedTradingViewEvent,
  ensureTradingViewOrderEvent,
  selectClientOrderId,
} from '../common/tradingview-event.service';
import { OrderlyHttpClient, buildOrderlyUrl, createOrderlyClientFromAuth } from '../common/orderly-http';
import { TradingViewOrderEvent } from '../common/tradingview.types';
import { OrderlyEnvironment } from '../common/orderly-config';

interface OrderResponsePayload {
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CreateOrderProps {
  reduce_only?: boolean;
  client_order_id?: string;
  order_event_override?: unknown;
}

export const createOrder = createAction({
  name: 'create_order',
  displayName: 'Create Order',
  description: 'Create a MARKET order on Orderly Network based on a TradingView webhook event.',
  props: {
    reduce_only: Property.Checkbox({
      displayName: 'Reduce Only',
      description: 'Only reduce existing exposure. Enable when exiting positions.',
      required: false,
      defaultValue: false,
    }),
    client_order_id: Property.ShortText({
      displayName: 'Client Order ID Override',
      description: 'Optional identifier (<= 36 chars). Overrides value from the event.',
      required: false,
      defaultValue: '',
    }),
    order_event_override: Property.Json({
      displayName: 'Order Event Override (optional)',
      description: 'Use only when testing without the TradingView trigger.',
      required: false,
    }),
  },

  async run(context) {
    if (!context.auth) {
      throw new Error('Authentication is required. Please connect your Orderly account.');
    }

    const logger = (context as unknown as { logger?: Console }).logger ?? console;
    const props = context.propsValue as CreateOrderProps;
    const auth = context.auth as PineautoAuthType;
    const environment = auth.environment ?? OrderlyEnvironment.TESTNET;

    const client = await createOrderlyClientFromAuth({
      accountId: auth.account_id,
      environment,
      secretKey: auth.secret_key,
    });

    const overrideEvent =
      props.order_event_override && Object.keys(props.order_event_override as Record<string, unknown>).length > 0
        ? ensureTradingViewOrderEvent(props.order_event_override)
        : null;

    const event = overrideEvent ?? (await consumeQueuedTradingViewEvent(context));

    if (!event) {
      throw new Error(
        'No TradingView event found. Please trigger this action from the TradingView webhook or provide an override payload.',
      );
    }
    const quoteAsset = parseQuoteAsset(event.symbol);

    const sizing = await resolveOrderSizing({
      environment,
      client,
      event,
      quoteAsset,
    });

    if (!Number.isFinite(sizing.quantity) || sizing.quantity <= 0) {
      throw new Error('Calculated order quantity is invalid. Check trigger sizing settings.');
    }

    const side = event.side === 'buy' ? 'BUY' : 'SELL';

    const baseOrderData: Record<string, unknown> = {
      symbol: event.symbol,
      side,
      order_type: 'MARKET',
      type: 'MARKET',
    };

    if (props.reduce_only) {
      baseOrderData['reduce_only'] = true;
    }

    const clientOrderId = selectClientOrderId(event.clientOrderId, props.client_order_id);
    if (clientOrderId) {
      baseOrderData['client_order_id'] = clientOrderId;
    }

    const retryStep = determineFlexibleQuantityStep(undefined) || 0.001;
    let attemptQuantity = sizing.quantity;
    let usedFallbackQuantity = !sizing.fallbackQuantity;

    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const { response, result, normalizedQty } = await sendOrder({
          client,
          environment,
          baseOrderData,
          quantityToUse: attemptQuantity,
          logger,
          auth,
          event,
        });

        if (!response.ok) {
          const handled = handleNonOkResponse({
            response,
            result,
            attemptQuantity,
            retryStep,
            sizing,
            orderQuantity: sizing.quantity,
            usedFallbackQuantity,
          });
          if (handled.type === 'retry') {
            attemptQuantity = handled.nextQuantity;
            usedFallbackQuantity = handled.usedFallbackQuantity;
            continue;
          }
          throw handled.error;
        }

        const orderData = (result['data'] ?? {}) as Record<string, unknown>;
        const orderId = orderData['order_id'] ?? result['order_id'] ?? null;
        const orderStatus = orderData['order_status'] ?? result['order_status'] ?? 'PENDING';
        const resolvedClientId = orderData['client_order_id'] ?? result['client_order_id'] ?? clientOrderId;
        const orderSymbol = (orderData['symbol'] ?? result['symbol'] ?? event.symbol) as string;
        const orderSide = (orderData['side'] ?? result['side'] ?? side) as string;
        const orderType = (orderData['order_type'] ?? result['order_type'] ?? 'MARKET') as string;
        const resolvedQuantity =
          orderData['order_quantity'] ??
          orderData['quantity'] ??
          result['order_quantity'] ??
          result['quantity'] ??
          normalizedQty;
        const avgPrice =
          orderData['avg_executed_price'] ?? result['avg_executed_price'] ?? sizing.referencePrice ?? null;
        const createdTime = (orderData['created_time'] ?? result['created_time']) as string | undefined;

        logger.info?.('[pineauto] Order created successfully.', { orderId, status: orderStatus });

        return {
          success: true,
          message: `✅ ${side === 'BUY' ? '🟢 Buy' : '🔴 Sell'} market order created successfully!`,
          order_id: orderId,
          client_order_id: resolvedClientId,
          status: orderStatus,
          symbol: orderSymbol,
          side: orderSide,
          type: orderType,
          quantity: resolvedQuantity,
          average_price: avgPrice,
          notional: sizing.notional ?? null,
          available_balance: sizing.availableBalance ?? null,
          quote_asset: sizing.quoteAsset ?? parseQuoteAsset(event.symbol) ?? null,
          leverage: sizing.leverageApplied,
          timestamp: createdTime || new Date().toISOString(),
          raw_response: orderData,
          trigger_event: event,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lowerMessage = message.toLowerCase();

        if (lowerMessage.includes('fetch') || lowerMessage.includes('network')) {
          throw new Error('🌐 Network error. Please check your connection and retry.');
        }

        if (message.includes('❌') && !lowerMessage.includes('insufficient balance')) {
          throw error instanceof Error ? error : new Error(message);
        }

        if (!lowerMessage.includes('insufficient')) {
          throw error instanceof Error ? error : new Error(message);
        }

        const reducedQuantity = applyQuantityStep(attemptQuantity * 0.8, retryStep);
        if (reducedQuantity <= 0 || Math.abs(reducedQuantity - attemptQuantity) < 1e-8) {
          throw new Error('❌ Insufficient balance for this order. Please check available collateral.');
        }
        logger.warn?.('[pineauto] Reducing quantity due to insufficient balance (catch block).', {
          previousQuantity: attemptQuantity,
          reducedQuantity,
        });
        attemptQuantity = reducedQuantity;
      }
    }

    throw new Error('❌ Insufficient balance for this order. Please check available collateral.');
  },
});

async function sendOrder(params: {
  client: OrderlyHttpClient;
  environment: OrderlyEnvironment;
  baseOrderData: Record<string, unknown>;
  quantityToUse: number;
  logger: Console;
  auth: PineautoAuthType;
  event: TradingViewOrderEvent;
}): Promise<{
  response: Response;
  result: OrderResponsePayload;
  normalizedQty: number;
}> {
  const { client, environment, baseOrderData, quantityToUse, logger, auth } = params;
  const normalizedQty = normalizeNumber(quantityToUse, 6);
  const payload: Record<string, unknown> = {
    ...baseOrderData,
    order_quantity: normalizedQty,
    quantity: normalizedQty,
  };

  logger.debug?.('[pineauto] Sending market order.', {
    payloadPreview: { ...payload, account: `${auth.account_id.substring(0, 8)}...` },
  });

  const response = await client.post(buildOrderlyUrl(environment, '/v1/order'), {
    body: JSON.stringify(payload),
  });

  let result: OrderResponsePayload = {};
  try {
    result = (await response.json()) as OrderResponsePayload;
  } catch {
    result = {};
  }

  return { response, result, normalizedQty };
}

function handleNonOkResponse(params: {
  response: Response;
  result: OrderResponsePayload;
  attemptQuantity: number;
  retryStep: number;
  sizing: Awaited<ReturnType<typeof resolveOrderSizing>>;
  orderQuantity: number;
  usedFallbackQuantity: boolean;
}):
  | { type: 'retry'; nextQuantity: number; usedFallbackQuantity: boolean }
  | { type: 'error'; error: Error } {
  const { response, result, attemptQuantity, retryStep, sizing, orderQuantity, usedFallbackQuantity } = params;
  const messageText = typeof result['message'] === 'string' ? (result['message'] as string) : undefined;
  const errorText = typeof result['error'] === 'string' ? (result['error'] as string) : undefined;
  const errorMessage = messageText || errorText || `Order creation failed with status ${response.status}`;
  const lowerError = errorMessage.toLowerCase();

  if (response.status === 400) {
    if (lowerError.includes('insufficient')) {
      const reducedQuantity = applyQuantityStep(attemptQuantity * 0.8, retryStep);
      if (reducedQuantity <= 0 || Math.abs(reducedQuantity - attemptQuantity) < 1e-8) {
        return {
          type: 'error',
          error: new Error('❌ Insufficient balance for this order. Please check available collateral.'),
        };
      }
      console.warn('[pineauto] Reducing quantity due to insufficient balance (HTTP 400).', {
        previousQuantity: attemptQuantity,
        reducedQuantity,
      });
      return { type: 'retry', nextQuantity: reducedQuantity, usedFallbackQuantity };
    }

    if (lowerError.includes('quantity')) {
      return { type: 'error', error: new Error(`❌ Invalid quantity detected. Computed value: ${attemptQuantity}`) };
    }

    if (
      errorMessage.includes('filter requirement') &&
      sizing.fallbackQuantity &&
      !usedFallbackQuantity &&
      Math.abs(sizing.fallbackQuantity - orderQuantity) > 1e-8
    ) {
      console.warn('[pineauto] Retrying order with fallback quantity due to filter requirement.', {
        originalQuantity: orderQuantity,
        fallbackQuantity: sizing.fallbackQuantity,
      });
      return { type: 'retry', nextQuantity: sizing.fallbackQuantity, usedFallbackQuantity: true };
    }

    return { type: 'error', error: new Error(`❌ Invalid order parameters: ${errorMessage}`) };
  }

  if (response.status === 401) {
    return { type: 'error', error: new Error('🔐 Authentication failed. Please verify your Orderly credentials.') };
  }
  if (response.status === 403) {
    return { type: 'error', error: new Error('🚫 Account lacks permission or is not activated. Check Orderly account status.') };
  }
  if (response.status === 429) {
    return { type: 'error', error: new Error('⏱️ Rate limit exceeded. Please wait and try again.') };
  }
  if (response.status === 503) {
    return { type: 'error', error: new Error('🔧 Orderly service unavailable. Retry later.') };
  }

  return { type: 'error', error: new Error(errorMessage) };
}
