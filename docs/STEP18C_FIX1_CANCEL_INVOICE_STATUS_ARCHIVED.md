# Margin Guard Step 18C-FIX1 — Cancel Invoice Status Archived Fix

## Problem found after applying `voided_at`

After Step 18B (`voided_at` column applied in production), Cancel Invoice no longer failed with PGRST204.

Cancel then failed with:

```
violates check constraint "invoice_status_check"
```

The failing PATCH attempted:

```javascript
status: "void",
voided_at: <timestamp>
```

## Root cause

Production `public.invoices` has a check constraint `invoice_status_check` that does **not** allow `status = 'void'`.

Existing production rows already use `status = 'archived'` for inactive invoices. The cancel function was written assuming `void` was a valid status value.

## Fix

**`netlify/functions/cancel-tenant-invoice.js`:**

- PATCH now sets `status: "archived"` (not `"void"`)
- Still sets `voided_at` and `updated_at` on cancel
- No DELETE; invoice row preserved
- Payment guards unchanged
- Returns `{ ok: true, status: "archived", voided_at, message: "Invoice cancelled and archived." }`
- Sanitized error if status constraint still fails

**`public/js/app.js`:**

- Success feedback: `Invoice cancelled and archived.`
- `formatHubCancelInvoiceError` strips raw Supabase/constraint text

**UI modal** can still say “Cancel invoice” / “mark as void” — stored status is `archived`.

## Safety confirmations

| Rule | Status |
|------|--------|
| No delete | Yes — PATCH only |
| No payment mutation | Yes |
| No ledger mutation | Yes |
| No contract/quote/pricing change | Yes |
| No send/email/publish | Yes |
| Owner session + tenant scope | Yes |
| Payments guard preserved | Yes |
| No schema/SQL changes in this step | Yes |
| Invoice remains in history | Yes (`archived` + `voided_at`) |

## Test plan

1. Pick a **DRAFT** invoice with **no payments** (e.g. accidental Remaining Balance 1500.00 draft INV-1783285824747).
2. Invoice Hub → Actions → **Cancel invoice** → confirm modal.
3. Confirm success: **Invoice cancelled and archived.**
4. Confirm invoice still exists with `status = archived` and `voided_at` set.
5. Confirm `invoices_count` unchanged.
6. Confirm `payments_count` unchanged.
7. Confirm no email sent.
8. Try cancel again → blocked (already archived).
9. Try cancel on invoice with ledger payment → blocked with safe message.

## Rollback note

Revert commit to restore `status: "void"` PATCH (will re-fail `invoice_status_check` in production). No migration to undo.

## Files changed

- `netlify/functions/cancel-tenant-invoice.js`
- `public/js/app.js`
- `docs/STEP18C_FIX1_CANCEL_INVOICE_STATUS_ARCHIVED.md`
