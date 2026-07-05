# Margin Guard Step 17C — Remaining Balance Draft Invoice Implementation

## Purpose

Implement an Owner-only **Create Remaining Balance Invoice** action inside the existing Invoice Hub drawer **Actions** menu. The action opens a review modal and creates a **linked DRAFT invoice** for the project remaining balance (or a manual amount ≤ remaining balance in V1).

**No email is sent. No payment is recorded. The source invoice and ledger are unchanged.**

**Baseline plans:** Step 17A (`ba4e35d`), Step 17B inspection (`5f5474a`).

---

## Files changed

| File | Change |
|------|--------|
| `public/estimates-invoices.html` | Review modal `#hubRemainingBalanceInvoiceModal` + CSS |
| `public/js/app.js` | Actions menu item, modal wiring, client validation, API call |
| `netlify/functions/create-remaining-balance-invoice.js` | **New** — server-side balance math, duplicate guard, draft insert |
| `docs/STEP17C_REMAINING_BALANCE_DRAFT_INVOICE_IMPLEMENTATION.md` | This document |

**Not changed:** pricing engine, quote calculations, public invoice page, AI Closer, Seller/Supervisor, sidebar, Supabase schema, duplicate/manual invoice functions.

---

## UI placement

- **Location:** Invoice Hub drawer → top-right **Actions** → **Payment** section
- **Label:** `Create Remaining Balance Invoice`
- **Action key:** `create-remaining-balance-invoice`
- **Enabled when:** server invoice row, valid UUID, not archived/void, valid email, project remaining balance > 0 (`canCreateRemainingBalanceInvoice`)

Not added to: general Create Invoice button, public invoice page, Seller/Supervisor flows.

---

## Modal behavior

**Title:** Create Remaining Balance Draft Invoice

**Read-only summary:** customer, delivery email, project, contract total, paid to date, remaining balance, label “Remaining Balance”

**Amount options:**

- Use remaining balance (default)
- Enter manual amount (shown when selected; must be > 0 and ≤ remaining)

**Invoice message:** editable textarea with resolved default template

**Safety line:** `Draft only · No email will be sent · No payment will be recorded`

**Buttons:** Cancel · Create Draft Invoice

**Client behavior:**

- Loads ledger-aware totals via `hubRowResolveProjectPaymentTotals` before confirming amounts
- Disables confirm while loading/creating
- Prevents double submit via `hubRemainingBalanceInvoiceState.creating`
- On success: refetch hub invoices, optional open new draft row, hub feedback toast
- On error: re-enable button, show safe message (including duplicate 409)

---

## Backend function behavior

**Endpoint:** `POST /.netlify/functions/create-remaining-balance-invoice`

**Auth:** Session + tenant scope (same pattern as `duplicate-tenant-invoice.js`)

**Request:**

```json
{
  "source_invoice_id": "<uuid>",
  "amount_mode": "remaining_balance | manual",
  "manual_amount": 1663.10,
  "notes": "<client message>"
}
```

**Server steps:**

1. Load source invoice with `quotes(id,total)` embed
2. Reject archived/void source
3. Contract total = quote total if > 0, else source amount
4. Paid to date = sum `tenant_project_payments` (invoice_id → project_id → quote_id priority)
5. Remaining = contract total − paid; reject if ≤ 0
6. Validate manual amount ≤ remaining (V1)
7. Duplicate check (see below)
8. Insert draft invoice: copied customer/project/email, `invoice_label = "Remaining Balance"`, `type = PROGRESS`, `status = draft`, `amount = selected`, notes + `[source_invoice:<uuid>]` marker
9. Return `{ ok, invoice_id, status, amount, source_invoice_id, message }`

**Does not:** send email, create payments, PATCH source invoice, change contract total or quote pricing.

---

## Duplicate prevention strategy

V1 (no schema migration):

- Query tenant invoices with `invoice_label = "Remaining Balance"`
- Active statuses: draft, open, sent, partial, overdue, issued
- Exclude paid/void/archived
- Require `notes` contains `[source_invoice:<source_uuid>]`
- Block if existing row amount matches selected amount within 1¢
- Return HTTP 409 `duplicate_remaining_balance_draft`

---

## Safety confirmations

| Rule | Status |
|------|--------|
| DRAFT invoice only | Yes — `status: draft` on insert |
| Owner session required | Yes |
| Tenant scoped | Yes |
| No automatic email | Yes — no send/publish calls |
| No payment creation | Yes |
| No source invoice mutation | Yes — insert only |
| No ledger mutation | Yes |
| No contract total mutation | Yes — read-only |
| No pricing engine | Yes — function does not import pricing-engine |
| No internal cost/margin exposure | Yes — plain client message in notes |
| Server-side remaining balance | Yes — client preview not trusted |

---

## Test plan

Use production-style example:

| Field | Value |
|-------|-------|
| Contract total | 6163.10 |
| Paid to date | 4500.00 |
| Remaining balance | 1663.10 |

### Happy path

1. Open Invoice Hub → project with **Remaining balance due**
2. Open drawer → **Actions** → **Create Remaining Balance Invoice**
3. Confirm modal prefilled correctly
4. Keep **Use remaining balance** → **Create Draft Invoice**
5. Confirm success feedback; `invoices_count +1`
6. Confirm new invoice: amount 1663.10, status draft, label Remaining Balance, notes contain message + source marker
7. Confirm `payments_count` unchanged; source invoice unchanged; no email sent

### Manual amount

1. Select **Enter manual amount** → enter 500.00 (≤ remaining)
2. Create draft → amount = 500.00

### Validation

1. Manual amount 0 or > remaining → client error, no create
2. Paid-in-full project → menu item disabled/hidden

### Duplicate

1. Create remaining balance draft again for same source + same amount → 409, no second row

---

## Rollback note

To rollback Step 17C:

1. Revert commit (or remove menu item, modal HTML, app.js handlers, delete `create-remaining-balance-invoice.js`)
2. Existing draft remaining-balance invoices remain in DB (harmless); no payment or send side effects
3. No schema migration to undo

---

## Verification (pre-commit)

```bash
git diff --name-only
node --check public/js/app.js
node --check netlify/functions/create-remaining-balance-invoice.js
git status --short
```

Expected changed files only:

- `public/estimates-invoices.html`
- `public/js/app.js`
- `netlify/functions/create-remaining-balance-invoice.js`
- `docs/STEP17C_REMAINING_BALANCE_DRAFT_INVOICE_IMPLEMENTATION.md`
