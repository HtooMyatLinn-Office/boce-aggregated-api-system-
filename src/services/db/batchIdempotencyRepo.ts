import { getDbPool } from './pool';

export class IdempotencyConflictError extends Error {}

export async function reserveBatchIdempotency(params: {
  clientId: string;
  idemKey: string;
  requestHash: string;
}): Promise<{ existingJobId?: string; reserved: boolean }> {
  const pool = getDbPool();

  // Try to create placeholder row.
  await pool.query(
    `INSERT INTO batch_idempotency (client_id, idem_key, request_hash, job_id)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (client_id, idem_key) DO NOTHING`,
    [params.clientId, params.idemKey, params.requestHash]
  );

  const res = await pool.query(
    `SELECT request_hash, job_id
     FROM batch_idempotency
     WHERE client_id=$1 AND idem_key=$2`,
    [params.clientId, params.idemKey]
  );
  if ((res.rowCount ?? 0) === 0) return { reserved: true };

  const row = res.rows[0];
  if (row.request_hash !== params.requestHash) {
    throw new IdempotencyConflictError('Idempotency key is already used with different request payload');
  }
  if (row.job_id) {
    return { reserved: false, existingJobId: row.job_id as string };
  }
  return { reserved: true };
}

export async function attachIdempotencyJob(params: {
  clientId: string;
  idemKey: string;
  requestHash: string;
  jobId: string;
}): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE batch_idempotency
     SET job_id=$4
     WHERE client_id=$1 AND idem_key=$2 AND request_hash=$3 AND job_id IS NULL`,
    [params.clientId, params.idemKey, params.requestHash, params.jobId]
  );
}

