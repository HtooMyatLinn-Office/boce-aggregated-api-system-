import { v4 as uuidv4 } from 'uuid';
import { BatchDetectJobItem, BatchDetectJobStatusResponse } from '../../types';
import { getDbPool } from './pool';

type ScanJobStatusWithCancelled = 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type ScanDomainItemStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export async function createScanJob(params: {
  domains: string[];
  nodeIds: string;
  nodesPerTask: number;
  estimatedPoints: number;
  ipWhitelist?: string[];
  webhookUrl?: string;
  clientId?: string;
  priority?: number;
}): Promise<{ jobId: string }> {
  const pool = getDbPool();
  const jobId = uuidv4();

  const ipWhitelistJson = params.ipWhitelist && params.ipWhitelist.length > 0 ? params.ipWhitelist : null;

  await pool.query(
    `INSERT INTO scan_jobs
      (id, client_id, url_count, nodes_per_task, estimated_points, node_ids, ip_whitelist, webhook_url, priority, status, total_items)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10)`,
    [
      jobId,
      params.clientId ?? null,
      params.domains.length,
      params.nodesPerTask,
      params.estimatedPoints,
      params.nodeIds,
      ipWhitelistJson,
      params.webhookUrl ?? null,
      params.priority ?? 0,
      params.domains.length,
    ]
  );

  // Insert domain items in chunks to avoid large write latency.
  const INSERT_CHUNK_SIZE = 2000;
  for (let i = 0; i < params.domains.length; i += INSERT_CHUNK_SIZE) {
    const chunk = params.domains.slice(i, i + INSERT_CHUNK_SIZE);
    const values: string[] = [];
    const bind: unknown[] = [];
    for (let idx = 0; idx < chunk.length; idx += 1) {
      const id = uuidv4();
      const domain = chunk[idx];
      const n = bind.length;
      values.push(`($${n + 1},$${n + 2},$${n + 3},$${n + 4},'PENDING')`);
      bind.push(id, jobId, domain, params.nodeIds);
    }
    await pool.query(
      `INSERT INTO scan_job_domains (id, job_id, domain, node_ids, status)
       VALUES ${values.join(',')}`,
      bind
    );
  }

  return { jobId };
}

export async function getScanJobStatus(jobId: string): Promise<BatchDetectJobStatusResponse> {
  const pool = getDbPool();

  const jobRes = await pool.query(
    `SELECT
       created_at,
       updated_at,
       id,
       url_count,
       nodes_per_task,
       estimated_points,
       status,
       last_error,
       total_items,
       finished_items,
       success_items,
       failed_items,
       priority
     FROM scan_jobs
     WHERE id = $1`,
    [jobId]
  );
  if (jobRes.rowCount === 0) {
    throw new Error(`scan job not found: ${jobId}`);
  }

  const job = jobRes.rows[0];

  return {
    jobId: job.id,
    status: job.status as ScanJobStatusWithCancelled,
    totalItems: Number(job.total_items ?? job.url_count),
    finishedItems: Number(job.finished_items ?? 0),
    successItems: Number(job.success_items ?? 0),
    failedItems: Number(job.failed_items ?? 0),
    estimatedPoints: Number(job.estimated_points),
    lastError: job.last_error,
    createdAt: job.created_at?.toISOString(),
    updatedAt: job.updated_at?.toISOString(),
  };
}

export async function listScanJobItems(params: {
  jobId: string;
  status?: ScanDomainItemStatus;
  limit?: number;
}): Promise<BatchDetectJobItem[]> {
  const pool = getDbPool();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const status = params.status;

  const q = status
    ? `SELECT id, domain, status, request_id, task_id, attempts, last_error
       FROM scan_job_domains
       WHERE job_id=$1 AND status=$2
       ORDER BY created_at DESC
       LIMIT $3`
    : `SELECT id, domain, status, request_id, task_id, attempts, last_error
       FROM scan_job_domains
       WHERE job_id=$1
       ORDER BY created_at DESC
       LIMIT $2`;

  const res = status
    ? await pool.query(q, [params.jobId, status, limit])
    : await pool.query(q, [params.jobId, limit]);

  return res.rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    status: r.status as ScanDomainItemStatus,
    requestId: r.request_id,
    taskId: r.task_id,
    attempts: Number(r.attempts ?? 0),
    lastError: r.last_error,
  }));
}

export async function markDomainRunning(params: { jobId: string; domain: string }): Promise<boolean> {
  const pool = getDbPool();
  const res = await pool.query(
    `UPDATE scan_job_domains
     SET status='RUNNING', attempts = attempts + 1, updated_at = now()
     WHERE job_id=$1 AND domain=$2 AND status IN ('QUEUED','FAILED')
     RETURNING id`,
    [params.jobId, params.domain]
  );
  if ((res.rowCount ?? 0) > 0) {
    // best-effort: mark job running
    await pool.query(
      `UPDATE scan_jobs SET status='RUNNING', updated_at=now()
       WHERE id=$1 AND status IN ('PENDING')`,
      [params.jobId]
    );
    return true;
  }
  return false;
}

export async function markDomainCompleted(params: {
  jobId: string;
  domain: string;
  requestId: string;
  taskId: string;
}): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const domainRes = await client.query(
      `UPDATE scan_job_domains
       SET status='COMPLETED', request_id=$1, task_id=$2, updated_at=now()
       WHERE job_id=$3 AND domain=$4 AND status='RUNNING'`,
      [params.requestId, params.taskId, params.jobId, params.domain]
    );
    if ((domainRes.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE scan_jobs
       SET finished_items = finished_items + 1,
           success_items = success_items + 1,
           updated_at = now()
       WHERE id=$1`,
      [params.jobId]
    );

    await finalizeJobIfDone(client, params.jobId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function markDomainFailed(params: {
  jobId: string;
  domain: string;
  lastError: string;
}): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const domainRes = await client.query(
      `UPDATE scan_job_domains
       SET status='FAILED', last_error=$1, updated_at=now()
       WHERE job_id=$2 AND domain=$3 AND status='RUNNING'`,
      [params.lastError, params.jobId, params.domain]
    );
    if ((domainRes.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE scan_jobs
       SET finished_items = finished_items + 1,
           failed_items = failed_items + 1,
           updated_at = now()
       WHERE id=$1`,
      [params.jobId]
    );

    await finalizeJobIfDone(client, params.jobId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function finalizeJobIfDone(client: { query: (q: string, params?: any[]) => Promise<any> }, jobId: string): Promise<void> {
  const statusRes = await client.query(
    `SELECT total_items, finished_items, failed_items
     FROM scan_jobs
     WHERE id=$1
     FOR UPDATE`,
    [jobId]
  );

  if ((statusRes.rowCount ?? 0) === 0) return;
  const row = statusRes.rows[0];
  const total = Number(row.total_items ?? 0);
  const finished = Number(row.finished_items ?? 0);
  const failed = Number(row.failed_items ?? 0);

  if (total <= 0) return;
  if (finished !== total) return;

  const newStatus: ScanJobStatusWithCancelled = failed > 0 ? 'FAILED' : 'COMPLETED';

  await client.query(
    `UPDATE scan_jobs
     SET status=$2, updated_at=now()
     WHERE id=$1`,
    [jobId, newStatus]
  );
}

export interface ScanJobWebhookPayload {
  jobId: string;
  status: ScanJobStatusWithCancelled;
  totalItems: number;
  finishedItems: number;
  successItems: number;
  failedItems: number;
  estimatedPoints: number;
  updatedAt: string;
}

/**
 * Atomically claim webhook delivery once when the job reaches terminal state.
 */
export async function claimFinalizedJobWebhook(jobId: string): Promise<{ webhookUrl: string; payload: ScanJobWebhookPayload } | null> {
  const pool = getDbPool();
  const res = await pool.query(
    `UPDATE scan_jobs
     SET callback_sent_at = now(), callback_last_status = 'PENDING', updated_at = now()
     WHERE id = $1
       AND status IN ('COMPLETED', 'FAILED', 'CANCELLED')
       AND callback_sent_at IS NULL
       AND webhook_url IS NOT NULL
     RETURNING id, webhook_url, status, total_items, finished_items, success_items, failed_items, estimated_points, updated_at`,
    [jobId]
  );

  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0];
  return {
    webhookUrl: row.webhook_url as string,
    payload: {
      jobId: row.id,
      status: row.status as ScanJobStatusWithCancelled,
      totalItems: Number(row.total_items ?? 0),
      finishedItems: Number(row.finished_items ?? 0),
      successItems: Number(row.success_items ?? 0),
      failedItems: Number(row.failed_items ?? 0),
      estimatedPoints: Number(row.estimated_points ?? 0),
      updatedAt: row.updated_at?.toISOString?.() ?? new Date().toISOString(),
    },
  };
}

export async function markJobWebhookResult(params: { jobId: string; ok: boolean; error?: string }): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE scan_jobs
     SET callback_last_status = $2,
         callback_last_error = $3,
         updated_at = now()
     WHERE id = $1`,
    [params.jobId, params.ok ? 'SENT' : 'FAILED', params.error ?? null]
  );
}

export async function claimPendingDomainsForDispatch(limit: number): Promise<Array<{ jobId: string; domain: string; nodeIds: string; ipWhitelist?: string[] }>> {
  const pool = getDbPool();
  const capped = Math.max(1, Math.min(limit, 2000));
  const res = await pool.query(
    `WITH picked AS (
      SELECT d.id
      FROM scan_job_domains d
      JOIN scan_jobs j ON j.id = d.job_id
      WHERE d.status='PENDING'
        AND j.status IN ('PENDING','RUNNING')
      ORDER BY j.priority DESC, d.created_at ASC
      LIMIT $1
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE scan_job_domains d
    SET status='QUEUED', updated_at=now()
    FROM picked
    WHERE d.id = picked.id
    RETURNING d.job_id, d.domain, d.node_ids`,
    [capped]
  );

  return res.rows.map((r) => ({
    jobId: r.job_id as string,
    domain: r.domain as string,
    nodeIds: r.node_ids as string,
    ipWhitelist: undefined,
  }));
}

export async function pauseScanJob(jobId: string): Promise<boolean> {
  const pool = getDbPool();
  const res = await pool.query(
    `UPDATE scan_jobs
     SET status='PAUSED', updated_at=now()
     WHERE id=$1 AND status IN ('PENDING','RUNNING')
     RETURNING id`,
    [jobId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function resumeScanJob(jobId: string): Promise<boolean> {
  const pool = getDbPool();
  const res = await pool.query(
    `UPDATE scan_jobs
     SET status='PENDING', updated_at=now()
     WHERE id=$1 AND status IN ('PAUSED')
     RETURNING id`,
    [jobId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function cancelScanJob(jobId: string): Promise<boolean> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE scan_jobs
       SET status='CANCELLED', updated_at=now()
       WHERE id=$1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED')
       RETURNING id`,
      [jobId]
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE scan_job_domains
       SET status='CANCELLED', updated_at=now(), last_error='cancelled by user'
       WHERE job_id=$1 AND status IN ('PENDING','QUEUED')`,
      [jobId]
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function setScanJobPriority(jobId: string, priority: number): Promise<boolean> {
  const pool = getDbPool();
  const p = Math.max(0, Math.min(100, Math.trunc(priority)));
  const res = await pool.query(
    `UPDATE scan_jobs SET priority=$2, updated_at=now() WHERE id=$1 RETURNING id`,
    [jobId, p]
  );
  return (res.rowCount ?? 0) > 0;
}

