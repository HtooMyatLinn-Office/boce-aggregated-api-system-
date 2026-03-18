import { getDbPool } from './pool';

export async function migrate(): Promise<void> {
  const pool = getDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS detections (
      request_id uuid PRIMARY KEY,
      task_id text NOT NULL,
      url text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      result_json jsonb NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_detections_url_created ON detections (url, created_at DESC);`);
}

