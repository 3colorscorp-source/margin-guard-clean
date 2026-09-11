-- MG-CORE-SECURITY-PRIVATE-ESTIMATE-PDFS — privatize estimate-pdfs
-- DO NOT apply from CI. Review, then run once in the Supabase SQL editor.
-- Changes only storage.buckets.public for id/name = estimate-pdfs.
-- Does not INSERT/DELETE rows, create/drop policies, GRANT to anon or
-- authenticated, enable/disable RLS, or touch tenant-logos / contract-signed-pdfs.
-- Writes and signed URLs stay server-side via Netlify service_role.
--
-- After this apply, historical /storage/v1/object/public/estimate-pdfs/...
-- links stop working. New get-estimate-pdf?token=&path=&sig= links still work.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'estimate-pdfs'
      AND name = 'estimate-pdfs'
  ) THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS APPLY FAIL: estimate-pdfs does not exist';
  END IF;
END $$;

UPDATE storage.buckets
SET public = false
WHERE id = 'estimate-pdfs'
  AND name = 'estimate-pdfs';

DO $$
DECLARE
  n int;
  logos_public boolean;
  contracts_public boolean;
BEGIN
  SELECT COUNT(*) INTO n
  FROM storage.buckets
  WHERE id = 'estimate-pdfs'
    AND name = 'estimate-pdfs'
    AND public = false;
  IF n <> 1 THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS APPLY FAIL: estimate-pdfs was not set public=false';
  END IF;

  SELECT public INTO logos_public
  FROM storage.buckets
  WHERE id = 'tenant-logos'
  LIMIT 1;
  IF FOUND AND logos_public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS APPLY FAIL: tenant-logos public flag changed';
  END IF;

  SELECT public INTO contracts_public
  FROM storage.buckets
  WHERE id = 'contract-signed-pdfs'
  LIMIT 1;
  IF FOUND AND contracts_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS APPLY FAIL: contract-signed-pdfs public flag changed';
  END IF;
END $$;

COMMIT;
