# Margin Guard Step 17C-FIX3 — Remaining Balance Duplicate Guard Strengthened

## Production issue found

After Step 17C / FIX1 / FIX2, production successfully created a Remaining Balance draft invoice:

| Field | Value |
|-------|--------|
| Customer | Gonzalo & Isamar |
| Project | Upstairs bath #2 |
| Amount | 1663.10 |
| Invoice | INV-1783285112897 |
| Status | draft |

A **second** Remaining Balance draft was then created for the **same source project/invoice** with a different manual amount:

| Field | Value |
|-------|--------|
| Amount | 1500.00 |
| Invoice | INV-1783285824747 |
| Status | draft |

### Counts after second create

| Metric | Value |
|--------|-------|
| `invoices_count` | 63 |
| `payments_count` | 0 |

## Root cause

`findDuplicateRemainingBalanceDraft` in `create-remaining-balance-invoice.js` blocked duplicates only when:

- Same `invoice_label` = `Remaining Balance`
- Same notes marker `[source_invoice:<uuid>]`
- Same **amount** (within 1¢)
- Active status (draft, open, sent, partial, overdue, issued)

A manual amount of **1500.00** did not match **1663.10**, so the guard allowed a second active draft.

## Fix

**Backend (`create-remaining-balance-invoice.js`):**

- Duplicate guard now blocks **any** active Remaining Balance invoice for the same source invoice marker, **regardless of amount**
- Match criteria:
  - `tenant_id`
  - `invoice_label = "Remaining Balance"`
  - `notes` contains `[source_invoice:<source_uuid>]`
  - Status in active set: `draft`, `open`, `sent`, `partial`, `overdue`, `issued`, `pending`
- Does **not** block: `void`, `archived`, `paid`, `cancelled`, `canceled`
- Safe duplicate message:
  > A remaining balance draft invoice already exists for this project/invoice. Review or cancel the existing draft before creating another.

**UI (`public/js/app.js`):**

- `formatHubRemainingBalanceInvoiceError` updated to show the same owner-safe duplicate message (no raw database text).

## Manual amount behavior preserved

- Manual amount option remains when **no** active Remaining Balance draft exists for the source
- Manual amount still validates: `> 0` and `<= remaining balance` (V1)
- DRAFT-only create; no send/email/payment/publish

## Safety confirmations

| Rule | Status |
|------|--------|
| DRAFT invoice only | Yes |
| No send/email | Yes |
| No payment creation | Yes |
| No publish | Yes |
| No original invoice mutation | Yes |
| No ledger mutation | Yes |
| No contract total mutation | Yes |
| No pricing/quote changes | Yes |
| No schema/SQL changes | Yes |
| No AI Closer / Seller / Supervisor changes | Yes |

## Test plan

1. Ensure one active Remaining Balance draft exists for source invoice (e.g. 1663.10).
2. Open same project drawer → Actions → **Create Remaining Balance Invoice**.
3. Select **Enter manual amount** → 1500.00 (or any valid amount).
4. Click **Create Draft Invoice**.
5. Confirm duplicate message appears; **no third invoice** created.
6. Confirm `invoices_count` unchanged.
7. Confirm `payments_count` unchanged.
8. **Void/cancel** the existing Remaining Balance draft (after Step 18C + schema fix).
9. Retry create — should succeed when no active Remaining Balance draft remains.

## Cleanup recommendation (accidental 1500.00 draft)

Production currently has **two** active Remaining Balance drafts for the same source:

- INV-1783285112897 — 1663.10 (intended)
- INV-1783285824747 — 1500.00 (accidental duplicate)

**Owner action (manual, after Cancel Invoice works):**

1. Keep **1663.10** draft as the canonical remaining balance invoice.
2. **Cancel/void** INV-1783285824747 (1500.00) via Invoice Hub → Actions → Cancel invoice (once Step 18B SQL + 18C are complete).
3. Do not delete rows; void preserves history.
4. Confirm `invoices_count` stays 63; void status on the 1500.00 row.

## Files changed

- `netlify/functions/create-remaining-balance-invoice.js` — duplicate guard without amount match
- `public/js/app.js` — duplicate error copy
- `docs/STEP17C_FIX3_REMAINING_BALANCE_DUPLICATE_GUARD.md` — this document

## Rollback note

Revert commit to restore amount-based duplicate guard (not recommended). No schema migration.
