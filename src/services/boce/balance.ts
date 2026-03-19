import { BoceApiError } from './client';

const BOCE_BALANCE_PATH = '/v3/balance';

export interface BoceBalanceResponse {
  error_code: number;
  error?: string;
  data?: {
    balance: number;
    point: number;
  };
}

export async function getBalance(baseUrl: string, key: string): Promise<BoceBalanceResponse> {
  const url = new URL(BOCE_BALANCE_PATH, baseUrl);
  url.searchParams.set('key', key);

  let res: Response;
  let body: BoceBalanceResponse;
  try {
    res = await fetch(url.toString(), { method: 'GET' });
    body = (await res.json()) as BoceBalanceResponse;
  } catch (e) {
    throw new BoceApiError(e instanceof Error ? e.message : 'Network request failed', -1);
  }

  if (!res.ok) {
    throw new BoceApiError(body?.error ?? `HTTP ${res.status}`, body?.error_code ?? res.status, body?.error);
  }

  if (body.error_code !== 0) {
    throw new BoceApiError(body.error ?? 'Boce API error', body.error_code, body.error);
  }

  return body;
}

