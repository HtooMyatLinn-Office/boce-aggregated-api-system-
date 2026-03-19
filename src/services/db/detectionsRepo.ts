import { DetectionHistoryItem, DetectionResult } from '../../types';
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

export async function listDetectionHistoryByUrl(params: {
  url: string;
  limit?: number;
  cursor?: string; // `createdAt|requestId` of last item from previous page
}): Promise<{ items: DetectionHistoryItem[]; nextCursor: string | null }> {
  const pool = getDbPool();
  const capped = Math.min(Math.max(params.limit ?? 20, 1), 200);

  let cursorCreatedAt: Date | null = null;
  let cursorRequestId: string | null = null;
  if (params.cursor) {
    const [createdAtStr, requestId] = params.cursor.split('|');
    const d = createdAtStr ? new Date(createdAtStr) : null;
    if (d && !Number.isNaN(d.getTime()) && requestId) {
      cursorCreatedAt = d;
      cursorRequestId = requestId;
    }
  }

  const values: any[] = [params.url];
  let cursorClause = '';
  if (cursorCreatedAt && cursorRequestId) {
    values.push(cursorCreatedAt.toISOString(), cursorRequestId);
    cursorClause = ` AND (created_at, request_id) < ($2::timestamptz, $3::uuid)`;
  }
  values.push(capped + 1);

  const limitParamIndex = values.length;

  const res = await pool.query(
    `
    SELECT
      request_id,
      task_id,
      url,
      created_at,
      (result_json->'summary'->>'overallStatus') as overall_status,
      (result_json->'availability'->'global'->>'availabilityRate')::float as availability_rate
    FROM detections
    WHERE url = $1
    ${cursorClause}
    ORDER BY created_at DESC, request_id DESC
    LIMIT $${limitParamIndex}
    `,
    values
  );

  const rows = res.rows as Array<{
    request_id: string;
    task_id: string;
    url: string;
    created_at: Date;
    overall_status?: string | null;
    availability_rate?: number | null;
  }>;

  const page = rows.slice(0, capped);
  const next = rows.length > capped ? rows[capped] : null;
  const items: DetectionHistoryItem[] = page.map((r) => ({
    requestId: r.request_id,
    taskId: r.task_id,
    url: r.url,
    createdAt: r.created_at.toISOString(),
    overallStatus:
      r.overall_status === 'HEALTHY' || r.overall_status === 'DEGRADED' || r.overall_status === 'UNAVAILABLE'
        ? (r.overall_status as DetectionHistoryItem['overallStatus'])
        : undefined,
    availabilityRate: typeof r.availability_rate === 'number' ? r.availability_rate : undefined,
  }));

  const nextCursor = next ? `${next.created_at.toISOString()}|${next.request_id}` : null;
  return { items, nextCursor };
}

