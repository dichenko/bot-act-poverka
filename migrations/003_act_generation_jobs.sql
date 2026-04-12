ALTER TABLE acts
ADD COLUMN IF NOT EXISTS xlsx_path TEXT;

CREATE TABLE IF NOT EXISTS act_generation_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pending_act_id BIGINT UNIQUE REFERENCES pending_acts(id) ON DELETE CASCADE,
  payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  draft JSONB NOT NULL,
  price_rub INTEGER NOT NULL CHECK (price_rub >= 0),
  xlsx_path TEXT,
  pdf_path TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_act_generation_jobs_status_created_at
  ON act_generation_jobs(status, created_at);
