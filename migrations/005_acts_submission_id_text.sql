DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'acts'
      AND column_name = 'submission_id'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE acts
      ALTER COLUMN submission_id TYPE TEXT
      USING submission_id::text;
  END IF;
END $$;
