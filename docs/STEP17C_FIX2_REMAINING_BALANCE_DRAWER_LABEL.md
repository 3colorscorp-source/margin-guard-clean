# Margin Guard Step 17C-FIX2 — Remaining Balance Drawer Label Polish

## Problem found after smoke

After Step 17C-FIX1, the Remaining Balance draft invoice was created successfully:

| Metric | Result |
|--------|--------|
| `invoices_count` | 61 → 62 |
| `payments_count` | 0 (unchanged) |
| `quotes_count` | 280 (unchanged) |
| Side effects | None (no payment/email/send/publish) |

When opening the **new** Remaining Balance draft invoice in the Invoice Hub drawer, the header next-action showed:

**`Initial deposit due`**

This is misleading — the invoice is a **Remaining Balance** bill for the outstanding project balance, not an initial deposit request.

## Root cause

Drawer next-action copy comes from `hubDrawerPaymentNextActionFromTotals(paid, total)` in `public/js/app.js`.

For a new Remaining Balance invoice row:

- Ledger payments are tied to the **source** invoice / project, not the new invoice id
- **Paid to date** in the drawer context reads as **0** for the new row
- **Contract total** still reflects the full project quote (e.g. 6163.10)
- Logic `paid === 0` → **`Initial deposit due`**

That rule is correct for true deposit/first invoices but wrong for Remaining Balance drafts identified by `invoice_label` or the `[source_invoice:<uuid>]` notes marker.

## Fix

**Display-only** change in `public/js/app.js`:

1. **`hubRowIsRemainingBalanceInvoice(row)`** — detects Remaining Balance invoices via:
   - `invoice_label` / `hubInvoiceLabel` = `Remaining Balance`
   - OR `notes` / `hubInvoiceNotes` contains `[source_invoice:<uuid>]`

2. **`hubDrawerPaymentNextActionFromTotals(paid, total, row)`** — when remaining balance invoice:
   - Show **`Remaining balance due`** (not Initial deposit due) while unpaid
   - **`Paid in full`** when settled
   - Deposit/progress/final rows unchanged (no marker / different label)

3. **`hubDrawerNextPaymentPlaceholderText`** — remaining balance placeholder:
   - `This invoice bills the remaining project balance.`

4. **`updateHubDrawerPaymentDerivedUi`** — passes `row` through to label helpers

No API calls, no amount/status/ledger changes.

## Safety confirmations

| Rule | Status |
|------|--------|
| Display/copy only | Yes |
| No Netlify function changes | Yes |
| No schema/SQL | Yes |
| No invoice/payment/email behavior | Yes |
| No pricing/quote/contract changes | Yes |
| Deposit/progress/final labels preserved | Yes |
| Public invoice page unchanged | Yes |

## Test plan

1. Open the **Remaining Balance** draft invoice (label Remaining Balance, amount 1663.10).
2. Confirm drawer header shows **`Remaining balance due`** (not Initial deposit due).
3. Confirm subtitle/title still shows **Remaining Balance** where applicable.
4. Open original project invoice with partial payment — still **`Remaining balance due`**.
5. Open a true initial/deposit invoice (if available) — still **`Initial deposit due`** when paid = 0.
6. Paid-in-full invoice — still **`Paid in full`**.

## Rollback note

Revert commit `Polish remaining balance invoice drawer label` to restore prior next-action logic. No data migration.

## Files changed

- `public/js/app.js` — detection + drawer label copy
- `docs/STEP17C_FIX2_REMAINING_BALANCE_DRAWER_LABEL.md` — this document
