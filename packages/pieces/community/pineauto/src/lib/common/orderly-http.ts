import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { encodeBase58 } from 'ethers';
import bs58 from 'bs58';
import { OrderlyEnvironment, resolveOrderlyBaseUrl } from './orderly-config';

export interface OrderlyHttpClient {
  request(input: URL | string, init?: RequestInit): Promise<Response>;
  get(input: URL | string, init?: RequestInit): Promise<Response>;
  post(input: URL | string, init?: RequestInit): Promise<Response>;
}

interface OrderlyCredentials {
  accountId: string;
  environment: OrderlyEnvironment;
  privateKey: Uint8Array;
  orderlyKey: string;
}

class OrderlyHttpClientImpl implements OrderlyHttpClient {
  constructor(private readonly credentials: OrderlyCredentials) {}

  async request(input: URL | string, init: RequestInit = {}): Promise<Response> {
    const url = input instanceof URL ? input : new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const timestamp = Date.now();

    const serializedBody = serializeBody(init.body);
    const message = `${timestamp}${method}${url.pathname}${url.search}${serializedBody ?? ''}`;
    const signatureBytes = await signAsync(new TextEncoder().encode(message), this.credentials.privateKey);

    const headers = new Headers(init.headers ?? {});
    headers.set('orderly-timestamp', String(timestamp));
    headers.set('orderly-account-id', this.credentials.accountId);
    headers.set('orderly-key', this.credentials.orderlyKey);
    headers.set('orderly-signature', Buffer.from(signatureBytes).toString('base64url'));

    if (serializedBody != null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return fetch(url, {
      ...init,
      method,
      body: serializedBody ?? undefined,
      headers,
    });
  }

  get(input: URL | string, init?: RequestInit): Promise<Response> {
    const requestInit: RequestInit = { ...(init ?? {}), method: 'GET' };
    return this.request(input, requestInit);
  }

  post(input: URL | string, init?: RequestInit): Promise<Response> {
    const requestInit: RequestInit = { ...(init ?? {}), method: 'POST' };
    return this.request(input, requestInit);
  }
}

function serializeBody(body: RequestInit['body']): string | null {
  if (!body) {
    return null;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof Blob) {
    throw new Error('Blob payloads are not supported for Orderly API requests.');
  }

  if (body instanceof FormData) {
    throw new Error('FormData payloads are not supported for Orderly API requests.');
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    throw new Error('Binary payloads are not supported for Orderly API requests.');
  }

  return JSON.stringify(body);
}

async function buildCredentials(params: {
  accountId: string;
  environment: OrderlyEnvironment;
  secretKey: string;
}): Promise<OrderlyCredentials> {
  const privateKey = decodeOrderlySecret(params.secretKey);
  const publicKey = await getPublicKeyAsync(privateKey);

  return {
    accountId: params.accountId,
    environment: params.environment,
    privateKey,
    orderlyKey: `ed25519:${encodeBase58(publicKey)}`,
  };
}

function decodeOrderlySecret(secretKey: string): Uint8Array {
  try {
    return bs58.decode(secretKey);
  } catch {
    throw new Error('Invalid secret key format. Expected Base58 encoded string.');
  }
}

export async function createOrderlyClientFromAuth(params: {
  accountId: string;
  environment: OrderlyEnvironment;
  secretKey: string;
}): Promise<OrderlyHttpClient> {
  const credentials = await buildCredentials(params);
  return new OrderlyHttpClientImpl(credentials);
}

export async function createOrderlyClient(params: {
  accountId: string;
  environment: OrderlyEnvironment;
  secretKey: string;
}): Promise<OrderlyHttpClient> {
  return createOrderlyClientFromAuth(params);
}

export function buildOrderlyUrl(environment: OrderlyEnvironment, path: string): URL {
  const baseUrl = resolveOrderlyBaseUrl(environment);
  return new URL(path, baseUrl);
}
