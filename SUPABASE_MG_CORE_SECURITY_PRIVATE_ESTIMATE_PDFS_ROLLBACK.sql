-- MG-CORE-SECURITY-PRIVATE-ESTIMATE-PDFS — emergency rollback
-- Restores storage.buckets.public = true for estimate-pdfs only.
-- DO NOT execute this file unless reversing an authorized apply.
-- Does not create/drop policies, GRANT to anon/authenticated, or touch
-- tenant-logos / contract-signed-pdfs.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'estimate-pdfs'
      AND name = 'estimate-pdfs'
  ) THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS ROLLBACK FAIL: estimate-pdfs does not exist';
  END IF;
END $$;

UPDATE storage.buckets
SET public = true
WHERE id = 'estimate-pdfs'
  AND name = 'estimate-pdfs';

DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM storage.buckets
  WHERE id = 'estimate-pdfs'
    AND name = 'estimate-pdfs'
    AND public = true;
  IF n <> 1 THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS ROLLBACK FAIL: estimate-pdfs was not restored to public=true';
  END IF;
END $$;

COMMIT;
