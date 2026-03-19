import { v4 as uuidv4 } from 'uuid';
import { BatchDetectJobItem, BatchDetectJobStatusResponse } from '../../types';
import { getDbPool } from './pool';

type ScanJobStatusWithCancelled = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type ScanDomainItemStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export async function createScanJob(params: {
  domains: string[];
  nodeIds: string;
  nodesPerTask: number;
  estimatedPoints: number;
  ipWhitelist?: string[];
}): Promise<{ jobId: string }> {
  const pool = getDbPool();
  const jobId = uuidv4();

  const ipWhitelistJson = params.ipWhitelist && params.ipWhitelist.length > 0 ? params.ipWhitelist : null;

  await pool.query(
    `INSERT INTO scan_jobs
      (id, url_count, nodes_per_task, estimated_points, node_ids, ip_whitelist, status, total_items)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7)`,
    [
      jobId,
      params.domains.length,
      params.nodesPerTask,
      params.estimatedPoints,
      params.nodeIds,
      ipWhitelistJson,
      params.domains.length,
    ]
  );

  // Insert domain items
  for (const domain of params.domains) {
    const itemId = uuidv4();
    await pool.query(
      `INSERT INTO scan_job_domains (id, job_id, domain, node_ids, status)
       VALUES ($1,$2,$3,$4,'QUEUED')`,
      [itemId, jobId, domain, params.nodeIds]
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
       failed_items
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

