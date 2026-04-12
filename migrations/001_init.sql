CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  max_user_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  user_fullname TEXT,
  org_name TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_offer_version TEXT,
  accepted_offer_at TIMESTAMPTZ,
  balance_rub INTEGER NOT NULL DEFAULT 0,
  acts_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prices (
  id BIGSERIAL PRIMARY KEY,
  user_type TEXT NOT NULL UNIQUE CHECK (user_type IN ('ordinary', 'verified')),
  price_rub INTEGER NOT NULL CHECK (price_rub >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offers (
  id BIGSERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_max_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('top_up', 'one_time', 'refund', 'balance_charge')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  amount_rub INTEGER NOT NULL CHECK (amount_rub >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  provider TEXT NOT NULL DEFAULT 'yookassa',
  provider_payment_id TEXT UNIQUE,
  confirmation_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_acts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'submission')),
  draft JSONB NOT NULL,
  price_rub INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled', 'completed')),
  payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS acts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'submission')),
  submission_id BIGINT,
  act_number TEXT NOT NULL,
  address TEXT NOT NULL,
  water_type TEXT NOT NULL CHECK (water_type IN ('ХВС', 'ГВС')),
  meter_model TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  current_reading NUMERIC(12,3) NOT NULL,
  check_date DATE NOT NULL,
  interval_years INTEGER NOT NULL CHECK (interval_years IN (4, 5, 6)),
  valid_until DATE NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('fit', 'unfit')),
  price_rub INTEGER NOT NULL,
  payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
  xlsx_path TEXT,
  pdf_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE INDEX IF NOT EXISTS idx_users_max_user_id ON users(max_user_id);
CREATE INDEX IF NOT EXISTS idx_acts_user_id ON acts(user_id);
CREATE INDEX IF NOT EXISTS idx_acts_created_at ON acts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_payment_id ON payments(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_act_generation_jobs_status_created_at
  ON act_generation_jobs(status, created_at);

INSERT INTO prices(user_type, price_rub)
VALUES
  ('ordinary', 40),
  ('verified', 0)
ON CONFLICT (user_type) DO NOTHING;
