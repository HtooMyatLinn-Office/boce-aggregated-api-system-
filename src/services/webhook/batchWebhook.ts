import { markJobWebhookResult, ScanJobWebhookPayload } from '../db/scanJobsRepo';

export async function sendBatchCompletedWebhook(params: {
  jobId: string;
  webhookUrl: string;
  payload: ScanJobWebhookPayload;
}): Promise<void> {
  try {
    const res = await fetch(params.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'batch.detect.completed',
        sentAt: new Date().toISOString(),
        data: params.payload,
      }),
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

