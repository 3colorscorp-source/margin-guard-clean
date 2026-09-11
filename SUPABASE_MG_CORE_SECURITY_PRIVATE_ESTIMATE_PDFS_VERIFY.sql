-- MG-CORE-SECURITY-PRIVATE-ESTIMATE-PDFS — verification
-- Run after the apply file. Read-only checks; rolls back any local writes.
-- Fails closed if estimate-pdfs is still public, if sibling buckets changed,
-- or if this change created storage policies / grants.

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  n int;
  logos_public boolean;
  contracts_public boolean;
  policy_n int;
BEGIN
  SELECT COUNT(*) INTO n
  FROM storage.buckets
  WHERE id = 'estimate-pdfs'
    AND name = 'estimate-pdfs'
    AND public = false;
  IF n <> 1 THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS VERIFY FAIL: estimate-pdfs is not private';
  END IF;

  SELECT public INTO logos_public
  FROM storage.buckets
  WHERE id = 'tenant-logos'
  LIMIT 1;
  IF FOUND AND logos_public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS VERIFY FAIL: tenant-logos must stay public';
  END IF;

  SELECT public INTO contracts_public
  FROM storage.buckets
  WHERE id = 'contract-signed-pdfs'
  LIMIT 1;
  IF FOUND AND contracts_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS VERIFY FAIL: contract-signed-pdfs must stay private';
  END IF;

  IF to_regclass('storage.policies') IS NOT NULL THEN
    SELECT COUNT(*) INTO policy_n
    FROM storage.policies
    WHERE bucket_id = 'estimate-pdfs'
      AND name LIKE 'mg-core-security-private-estimate-pdfs%';
    IF policy_n <> 0 THEN
      RAISE EXCEPTION 'PRIVATE-ESTIMATE-PDFS VERIFY FAIL: unexpected estimate-pdfs policy created by this change';
    END IF;
  END IF;
END $$;

ROLLBACK;
