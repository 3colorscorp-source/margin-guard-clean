# Margin Guard Step 17C-FIX1 — Remaining Balance Invoice quote_id Constraint Fix

## Problem found in production smoke

After Step 17C deploy, the **Create Remaining Balance Invoice** flow worked through the review modal (prefilled correctly for Gonzalo & Isamar / Upstairs bath #2: contract 6163.10, paid 4500.00, remaining 1663.10), but **Create Draft Invoice** failed with:

```
supabase HTTP 409: duplicate key value violates unique constraint "invoices_tenant_quote_unique"
Key (tenant_id, quote_id)=(…, …) already exists.
```

## Root cause

`create-remaining-balance-invoice.js` copied `quote_id` from the source invoice into the new remaining-balance draft insert. The `invoices` table enforces **one invoice per `(tenant_id, quote_id)`**, so a second row with the same quote cannot be inserted.

## Fix

**Do not set `quote_id` on Remaining Balance draft invoice inserts.**

The new invoice still links to the project/customer context via:

| Field | Value |
|-------|--------|
| `tenant_id` | Session tenant |
| `customer_name` / `customer_email` | From source |
| `project_name` | From source |
| `project_id` | Copied when present (if column exists) |
| `invoice_label` | `Remaining Balance` |
| `notes` | Client message + `[source_invoice:<source_uuid>]` marker |
| `amount` / `status` | Selected amount; `draft` |

`quote_id` is still **read** from the source invoice for contract-total and ledger payment resolution only — it is **not written** on insert.

## Duplicate prevention (unchanged strategy, no quote_id)

Active duplicate detection uses:

- `tenant_id`
- `invoice_label = "Remaining Balance"`
- `notes` contains `[source_invoice:<source_uuid>]`
- Selected amount (within 1¢)
- Active status (draft, open, sent, partial, overdue, issued)

Does **not** use `quote_id`. Paid/void/archived historical rows do not block.

## Friendly error handling

- Server returns owner-safe messages; no raw Supabase constraint text or UUIDs in UI responses.
- Duplicate: `A remaining balance draft invoice already exists for this project/invoice.`
- Insert/constraint failures: `Could not create the remaining balance draft invoice. Please refresh and try again.`
- Client `formatHubRemainingBalanceInvoiceError` strips any leaked database text.

## Safety confirmations

| Rule | Status |
|------|--------|
| DRAFT invoice only | Yes |
| No send/email | Yes |
| No payment creation | Yes |
| No publish | Yes |
| No source invoice mutation | Yes |
| No payment ledger mutation | Yes |
| No contract total mutation | Yes |
| No pricing/quote calculation change | Yes — read quote total only |
| No schema/SQL changes | Yes |
| No AI Closer / Seller / Supervisor changes | Yes |

## Test plan

1. Open Invoice Hub → **Upstairs bath #2** (Remaining balance due).
2. Actions → **Create Remaining Balance Invoice**.
3. Confirm modal prefilled (6163.10 / 4500.00 / 1663.10).
4. **Create Draft Invoice** → success (no 409 on `invoices_tenant_quote_unique`).
5. Confirm new invoice: amount 1663.10, status draft, label Remaining Balance, notes contain message + `[source_invoice:…]`, **no quote_id** on new row (or null).
6. Confirm source invoice unchanged; `payments_count` unchanged; no email sent.
7. Repeat create with same amount → duplicate guard message (no second draft).

## Rollback note

Revert commit `Fix remaining balance invoice quote id constraint` to restore prior insert behavior (will reintroduce the 409). No schema migration to undo.

## Files changed

- `netlify/functions/create-remaining-balance-invoice.js` — omit `quote_id` on insert; safe errors
- `public/js/app.js` — owner-safe error copy
- `docs/STEP17C_FIX1_REMAINING_BALANCE_QUOTE_ID_CONSTRAINT.md` — this document
