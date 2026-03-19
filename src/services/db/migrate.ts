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

  // Batch scan jobs (Steps 11+)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_jobs (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      client_id text,

      -- config
      url_count int NOT NULL,
      nodes_per_task int NOT NULL,
      estimated_points int NOT NULL,

      node_ids text NOT NULL,
      ip_whitelist jsonb,
      webhook_url text,

      -- status & progress
      status text NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
      total_items int NOT NULL,
      finished_items int NOT NULL DEFAULT 0,
      success_items int NOT NULL DEFAULT 0,
      failed_items int NOT NULL DEFAULT 0,
      last_error text,
      callback_sent_at timestamptz,
      callback_last_status text,
      callback_last_error text
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_jobs_created_at ON scan_jobs (created_at DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_job_domains (
      id uuid PRIMARY KEY,
      job_id uuid NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,

      domain text NOT NULL,
      node_ids text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      status text NOT NULL CHECK (status IN ('PENDING','QUEUED','RUNNING','COMPLETED','FAILED')),

      request_id uuid,
      task_id text,
      attempts int NOT NULL DEFAULT 0,
      last_error text
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_job_domains_job ON scan_job_domains(job_id, status);`);

  // ---- Best-effort schema alignment for existing DBs ----
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='job_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='id'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs RENAME COLUMN job_id TO id';
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='domains_count'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='url_count'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs RENAME COLUMN domains_count TO url_count';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='client_id'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN client_id text';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='total_items'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN total_items int NOT NULL DEFAULT 0';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='finished_items'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN finished_items int NOT NULL DEFAULT 0';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='success_items'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN success_items int NOT NULL DEFAULT 0';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='failed_items'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN failed_items int NOT NULL DEFAULT 0';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='webhook_url'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN webhook_url text';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='callback_sent_at'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN callback_sent_at timestamptz';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='callback_last_status'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN callback_last_status text';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='scan_jobs' AND column_name='callback_last_error'
      ) THEN
        EXECUTE 'ALTER TABLE scan_jobs ADD COLUMN callback_last_error text';
      END IF;
    END $$;
  `);

  // Backfill total_items for previously-created jobs
  await pool.query(`
    UPDATE scan_jobs
    SET total_items = url_count
    WHERE total_items = 0 AND url_count IS NOT NULL;
  `);

  // Re-apply CHECK constraints to include CANCELLED/PENDING where needed
  await pool.query(`
    DO $$
    DECLARE
      r record;
    BEGIN
      -- scan_jobs status check
      FOR r IN (
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name='scan_jobs'
          AND constraint_type='CHECK'
          AND constraint_name ILIKE '%status%'
      ) LOOP
        EXECUTE 'ALTER TABLE scan_jobs DROP CONSTRAINT ' || quote_ident(r.constraint_name);
      END LOOP;

      EXECUTE 'ALTER TABLE scan_jobs ADD CONSTRAINT scan_jobs_status_check
        CHECK (status IN (''PENDING'',''RUNNING'',''COMPLETED'',''FAILED'',''CANCELLED''))';

      -- scan_job_domains status check
      FOR r IN (
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name='scan_job_domains'
          AND constraint_type='CHECK'
          AND constraint_name ILIKE '%status%'
      ) LOOP
        EXECUTE 'ALTER TABLE scan_job_domains DROP CONSTRAINT ' || quote_ident(r.constraint_name);
      END LOOP;

      EXECUTE 'ALTER TABLE scan_job_domains ADD CONSTRAINT scan_job_domains_status_check
        CHECK (status IN (''PENDING'',''QUEUED'',''RUNNING'',''COMPLETED'',''FAILED''))';
    END $$;
  `);
}

