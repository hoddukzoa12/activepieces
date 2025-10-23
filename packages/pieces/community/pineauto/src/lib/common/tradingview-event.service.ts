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

const EVENT_QUEUE_KEY = 'pineauto:tradingview:event_queue';

export async function enqueueTradingViewEvent(
  context: StoreContext,
  event: TradingViewOrderEvent,
): Promise<void> {
  const queue =
    (await context.store.get<TradingViewOrderEvent[]>(EVENT_QUEUE_KEY, StoreScope.FLOW))?.slice() ?? [];
  queue.push(event);
  await context.store.put(EVENT_QUEUE_KEY, queue, StoreScope.FLOW);
}

export async function consumeQueuedTradingViewEvent(
  context: StoreContext,
): Promise<TradingViewOrderEvent | null> {
  const queue =
    (await context.store.get<TradingViewOrderEvent[]>(EVENT_QUEUE_KEY, StoreScope.FLOW))?.slice() ?? [];

  if (queue.length === 0) {
    return null;
  }

  const event = queue.shift() ?? null;

  if (queue.length === 0) {
    await context.store.delete(EVENT_QUEUE_KEY, StoreScope.FLOW);
  } else {
    await context.store.put(EVENT_QUEUE_KEY, queue, StoreScope.FLOW);
  }

  return event;
}
