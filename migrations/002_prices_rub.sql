DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'balance_kopecks'
  ) THEN
    ALTER TABLE users RENAME COLUMN balance_kopecks TO balance_rub;
    UPDATE users SET balance_rub = ROUND(balance_rub / 100.0)::INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'amount_kopecks'
  ) THEN
    ALTER TABLE payments RENAME COLUMN amount_kopecks TO amount_rub;
    UPDATE payments SET amount_rub = ROUND(amount_rub / 100.0)::INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pending_acts' AND column_name = 'price_kopecks'
  ) THEN
    ALTER TABLE pending_acts RENAME COLUMN price_kopecks TO price_rub;
    UPDATE pending_acts SET price_rub = ROUND(price_rub / 100.0)::INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'acts' AND column_name = 'price_kopecks'
  ) THEN
    ALTER TABLE acts RENAME COLUMN price_kopecks TO price_rub;
    UPDATE acts SET price_rub = ROUND(price_rub / 100.0)::INTEGER;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS prices (
  id BIGSERIAL PRIMARY KEY,
  user_type TEXT NOT NULL UNIQUE CHECK (user_type IN ('ordinary', 'verified')),
  price_rub INTEGER NOT NULL CHECK (price_rub >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO prices(user_type, price_rub)
VALUES
  ('ordinary', 40),
  ('verified', 0)
ON CONFLICT (user_type) DO NOTHING;

DO $$
DECLARE
  default_from_settings INTEGER;
  verified_from_settings INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'settings'
  ) THEN
    SELECT ROUND(COALESCE(value, '0')::NUMERIC / 100.0)::INTEGER
      INTO default_from_settings
    FROM settings
    WHERE key = 'act_price_default';

    SELECT ROUND(COALESCE(value, '0')::NUMERIC / 100.0)::INTEGER
      INTO verified_from_settings
    FROM settings
    WHERE key = 'act_price_verified';

    IF default_from_settings IS NOT NULL THEN
      UPDATE prices SET price_rub = default_from_settings, updated_at = NOW() WHERE user_type = 'ordinary';
    END IF;

    IF verified_from_settings IS NOT NULL THEN
      UPDATE prices SET price_rub = verified_from_settings, updated_at = NOW() WHERE user_type = 'verified';
    END IF;
  END IF;
END $$;
