import { StoreScope } from '@activepieces/pieces-framework';
import { TradingViewOrderEvent } from './tradingview.types';

export function ensureTradingViewOrderEvent(value: unknown): TradingViewOrderEvent {
  if (!value || typeof value !== 'object') {
    throw new Error('Order event must be a JSON object.');
  }

  const event = value as Record<string, unknown>;

  const symbolValue = event['symbol'];
  const symbol = typeof symbolValue === 'string' && symbolValue.trim().length > 0 ? symbolValue.trim() : null;
  if (!symbol) {
    throw new Error('Order event must include a symbol.');
  }

  const rawSideValue = event['side'];
  const rawSide = typeof rawSideValue === 'string' ? rawSideValue.toLowerCase() : '';
  if (rawSide !== 'buy' && rawSide !== 'sell') {
    throw new Error('Order event side must be "buy" or "sell".');
  }

  const rawQtyModeValue = event['qtyMode'] ?? event['qty_mode'];
  const rawQtyMode = typeof rawQtyModeValue === 'string' ? rawQtyModeValue.toLowerCase() : '';
  if (rawQtyMode !== 'percent' && rawQtyMode !== 'fixed') {
    throw new Error('Order event qtyMode must be "percent" or "fixed".');
  }

  const qty = Number(event['qty']);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Order event qty must be a positive number.');
  }

  const leverage = Number(event['leverage']);

  return {
    symbol,
    side: rawSide as 'buy' | 'sell',
    qtyMode: rawQtyMode as 'percent' | 'fixed',
    qty,
    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : 1,
    clientOrderId: typeof event['clientOrderId'] === 'string' ? (event['clientOrderId'] as string) : undefined,
    rawPayload: event['rawPayload'],
    emittedAt: typeof event['emittedAt'] === 'number' ? Number(event['emittedAt']) : undefined,
  };
}

export function selectClientOrderId(eventId: string | undefined, overrideId?: string): string | undefined {
  const cleanedOverride = overrideId?.trim();
  if (cleanedOverride) {
    if (cleanedOverride.length > 36) {
      throw new Error('Client order ID must be 36 characters or fewer.');
    }
    return cleanedOverride;
  }

  if (eventId && eventId.trim().length > 0) {
    const trimmed = eventId.trim();
    if (trimmed.length > 36) {
      throw new Error('Client order ID from event exceeds 36 characters.');
    }
    return trimmed;
  }

  return undefined;
}

type StoreLike = {
  get<T>(key: string, scope?: StoreScope): Promise<T | null>;
  put<T>(key: string, value: T, scope?: StoreScope): Promise<T>;
  delete(key: string, scope?: StoreScope): Promise<void>;
};

type StoreContext = {
  store: StoreLike;
};

const LEGACY_EVENT_QUEUE_KEY = 'pineauto:tradingview:event_queue';

/**
 * Generate queue key based on action type for action-based routing
 * @param action - Action type (order, close_position, set_leverage, create_algo)
 * @returns Queue key string
 */
function getQueueKey(action: string): string {
  return `pineauto:tradingview:${action}_queue`;
}

/**
 * Enqueue TradingView event to action-specific queue
 * Events are routed to different queues based on the action field
 *
 * @param context - Store context
 * @param event - TradingView order event
 */
export async function enqueueTradingViewEvent(
  context: StoreContext,
  event: TradingViewOrderEvent,
): Promise<void> {
  // Default to 'order' for backward compatibility
  const action = event.action ?? 'order';
  const queueKey = getQueueKey(action);

  // Get existing queue with immutable slice
  const queue =
    (await context.store.get<TradingViewOrderEvent[]>(queueKey, StoreScope.FLOW))?.slice() ?? [];

  // FIFO: push to end
  queue.push(event);

  // Store updated queue
  await context.store.put(queueKey, queue, StoreScope.FLOW);

  // Optional logging (can be enabled for debugging)
  // console.info(`[pineauto] Event queued to ${queueKey}`, { action, symbol: event.symbol });
}

/**
 * Consume TradingView event from action-specific queue
 * Supports fallback to legacy queue for backward compatibility
 *
 * @param context - Store context
 * @param action - Action type to consume from (default: 'order')
 * @returns TradingView event or null if queue is empty
 */
export async function consumeQueuedTradingViewEvent(
  context: StoreContext,
  action: string = 'order',
): Promise<TradingViewOrderEvent | null> {
  const queueKey = getQueueKey(action);

  // Try action-specific queue first
  let queue =
    (await context.store.get<TradingViewOrderEvent[]>(queueKey, StoreScope.FLOW))?.slice() ?? [];

  // Fallback to legacy queue for backward compatibility
  // Only for 'order' action to maintain compatibility with existing flows
  if (queue.length === 0 && action === 'order') {
    queue =
      (await context.store.get<TradingViewOrderEvent[]>(LEGACY_EVENT_QUEUE_KEY, StoreScope.FLOW))?.slice() ?? [];

    if (queue.length > 0) {
      // Consuming from legacy queue - migrate to new structure
      const event = queue.shift() ?? null;

      if (queue.length === 0) {
        await context.store.delete(LEGACY_EVENT_QUEUE_KEY, StoreScope.FLOW);
      } else {
        await context.store.put(LEGACY_EVENT_QUEUE_KEY, queue, StoreScope.FLOW);
      }

      // Optional logging for migration tracking
      // console.warn('[pineauto] Consumed from legacy queue - consider migrating to action-based events');

      return event;
    }
  }

  // No events in queue
  if (queue.length === 0) {
    return null;
  }

  // FIFO: shift from front
  const event = queue.shift() ?? null;

  // Cleanup or update queue
  if (queue.length === 0) {
    await context.store.delete(queueKey, StoreScope.FLOW);
  } else {
    await context.store.put(queueKey, queue, StoreScope.FLOW);
  }

  return event;
}
