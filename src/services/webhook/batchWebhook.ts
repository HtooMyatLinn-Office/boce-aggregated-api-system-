import crypto from 'crypto';
import { config } from '../../config';
import { markJobWebhookResult, ScanJobWebhookPayload } from '../db/scanJobsRepo';

export async function sendBatchCompletedWebhook(params: {
  jobId: string;
  webhookUrl: string;
  payload: ScanJobWebhookPayload;
}): Promise<void> {
  try {
    const body = JSON.stringify({
      event: 'batch.detect.completed',
      sentAt: new Date().toISOString(),
      data: params.payload,
    });
    const signature = signPayload(body, config.integrations.webhookSigningSecret);

    const res = await fetch(params.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Boce-Event': 'batch.detect.completed',
        ...(signature ? { 'X-Boce-Signature': signature } : {}),
      },
      body,
    });

    if (!res.ok) {
      await markJobWebhookResult({
        jobId: params.jobId,
        ok: false,
        error: `Webhook HTTP ${res.status}`,
      });
      return;
    }

    await markJobWebhookResult({ jobId: params.jobId, ok: true });
  } catch (e) {
    await markJobWebhookResult({
      jobId: params.jobId,
      ok: false,
      error: e instanceof Error ? e.message : 'webhook request failed',
    });
  }
}

function signPayload(payload: string, secret: string): string | undefined {
  if (!secret) return undefined;
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

