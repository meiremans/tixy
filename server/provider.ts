import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

const secretsClient = new SecretsManagerClient({});
const schema = z.object({ apiKey: z.string().min(1), webhookSecret: z.string().min(1) });
let cached: { value: z.infer<typeof schema>; expires: number } | undefined;
export async function secrets() {
  if (!cached || cached.expires < Date.now()) {
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.SECRET }));
    cached = { value: schema.parse(JSON.parse(result.SecretString!)), expires: Date.now() + 60_000 };
  }
  return cached.value;
}
export class ProviderError extends Error {
  constructor(public status: number) { super('Revolut request failed'); }
}
async function request<T>(path: string, body?: object): Promise<T> {
  const host = process.env.STAGE === 'production' ? 'merchant.revolut.com' : 'sandbox-merchant.revolut.com';
  const result = await fetch(`https://${host}/api/orders${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${(await secrets()).apiKey}`, 'Revolut-Api-Version': '2026-08-17', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!result.ok) throw new ProviderError(result.status);
  return result.json() as Promise<T>;
}
export type RemoteOrder = {
  id: string; type: string; state: string; amount: number; currency: string; checkout_url?: string;
  merchant_order_data?: { reference?: string }; related_order_id?: string; completed_at?: string; updated_at?: string;
};
export const createRemote = (body: object) => request<RemoteOrder>('', body);
export const retrieve = (id: string) => request<RemoteOrder>(`/${encodeURIComponent(id)}`);
export const list = (params: URLSearchParams) => request<{ orders: RemoteOrder[] }>(`?${params}`);
