import { DetectionResult } from '../../types';
import { getDbPool } from './pool';

export async function saveDetection(result: DetectionResult): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO detections (request_id, task_id, url, result_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (request_id) DO UPDATE
       SET task_id = EXCLUDED.task_id,
           url = EXCLUDED.url,
           result_json = EXCLUDED.result_json`,
    [result.requestId, result.taskId, result.url, result]
  );
}

export async function getDetectionByRequestId(requestId: string): Promise<DetectionResult | null> {
  const pool = getDbPool();
  const res = await pool.query(`SELECT result_json FROM detections WHERE request_id = $1`, [requestId]);
  if (res.rowCount === 0) return null;
  return res.rows[0].result_json as DetectionResult;
}

export async function listDetectionsByUrl(url: string, limit = 20): Promise<DetectionResult[]> {
  const pool = getDbPool();
  const capped = Math.min(Math.max(limit, 1), 200);
  const res = await pool.query(
    `SELECT result_json
     FROM detections
     WHERE url = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [url, capped]
  );
  return res.rows.map((r: { result_json: unknown }) => r.result_json as DetectionResult);
}

