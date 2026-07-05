# Margin Guard Step 17D — Remaining Balance Draft Invoice Production Verification

## 1. Purpose

Step 17D is **documentation only**. No production code changes are made in this step.

**Goal:** Record real production verification of the Remaining Balance Draft Invoice feature delivered in Step 17C, Step 17C-FIX1, and Step 17C-FIX2.

**Production URL:** `https://marginguardsystem.netlify.app`

---

## 2. Production test context

| Field | Value |
|-------|--------|
| Surface | Invoice Hub (`/estimates-invoices.html`) |
| Customer | Gonzalo & Isamar |
| Project | Upstairs bath #2 |
| Contract total | 6163.10 |
| Paid to date | 4500.00 |
| Remaining balance | 1663.10 |
| Action path | Remaining balance due drawer → top-right **Actions** → **Create Remaining Balance Invoice** |

---

## 3. Step 17C initial smoke result

**Deploy baseline:** commit `b12ea15` — Add remaining balance draft invoice action

| Check | Result |
|-------|--------|
| Actions menu item visible in Payment section | **PASS** |
| Review modal opens from Actions | **PASS** |
| Modal prefilled: customer, email, project | **PASS** |
| Modal prefilled: contract total, paid to date, remaining balance | **PASS** |
| Modal prefilled: invoice label Remaining Balance, default message | **PASS** |
| Create Draft Invoice | **FAIL** — Supabase HTTP 409 |

**Failure detail:**

```
duplicate key value violates unique constraint "invoices_tenant_quote_unique"
Key (tenant_id, quote_id) already exists
```

**Counts after failed attempt:**

- No invoice created by the failed POST
- No payment recorded
- No email sent

---

## 4. Step 17C-FIX1 verification

**Deploy baseline:** commit `4e802a3` — Fix remaining balance invoice quote id constraint

### Root cause

`create-remaining-balance-invoice.js` copied `quote_id` from the source invoice into the new draft row. The `invoices` table enforces **one invoice per `(tenant_id, quote_id)`**, so the insert failed with 409.

### Fix applied

- Remaining Balance draft inserts **do not copy** source `quote_id`
- Linkage preserved via:
  - `customer_name` / `customer_email` / `project_name`
  - `invoice_label = "Remaining Balance"`
  - Notes marker: `[source_invoice:<source_invoice_uuid>]`
  - `status = draft`, selected amount (1663.10)

### Production smoke after FIX1 deploy

| Check | Result |
|-------|--------|
| Create Draft Invoice succeeds | **PASS REAL** |
| New invoice status | **draft** |
| New invoice amount | **1663.10** |
| Email sent | **No** |
| Payment recorded | **No** |
| Publish/send triggered | **No** |
| Source invoice unchanged | **Yes** |

### Counts (FIX1 smoke)

| Metric | Before | After |
|--------|--------|-------|
| `invoices_count` | 61 | **62** |
| `payments_count` | 0 | **0** |
| `quotes_count` | 280 | **280** |

---

## 5. Step 17C-FIX2 verification

**Deploy baseline:** commit `2144d06` — Polish remaining balance invoice drawer label

### Problem

After FIX1, opening the new Remaining Balance draft in the drawer showed header next-action:

**`Initial deposit due`**

Misleading for a Remaining Balance invoice.

### Root cause

Display logic in `hubDrawerPaymentNextActionFromTotals` treated `paid === 0` as initial deposit. The new invoice row has no payments on its own `invoice_id`, while contract total still reflects the full project quote.

### Fix applied

Display-only detection via `invoice_label === "Remaining Balance"` or notes marker `[source_invoice:<uuid>]`. Remaining Balance invoices show **`Remaining balance due`** instead of Initial deposit due.

### Production visual verification

| Check | Result |
|-------|--------|
| Drawer header shows **Remaining balance due** | **PASS REAL** |
| Drawer does **not** show Initial deposit due | **PASS REAL** |
| Subtitle/title preserves **Remaining Balance** label | **PASS REAL** |

---

## 6. Duplicate guard verification

| Check | Result |
|-------|--------|
| Second create attempt (same source + amount) | **Blocked** |
| Owner-safe message shown | `A remaining balance draft invoice already exists for this project/invoice.` |
| Raw Supabase constraint text exposed | **No** |
| Second draft created | **No** |

### Counts after duplicate attempt

| Metric | Value |
|--------|-------|
| `invoices_count` | **62** (unchanged) |
| `payments_count` | **0** (unchanged) |

---

## 7. Final Supabase counts

Post-verification production baseline:

| Metric | Count |
|--------|-------|
| `prequotes_count` | 4 |
| `conversion_rows` | 2 |
| `quotes_count` | 280 |
| `invoices_count` | 62 |
| `payments_count` | 0 |

---

## 8. Safety confirmation

| Rule | Verified |
|------|----------|
| Created exactly one new DRAFT invoice | Yes |
| No email sent | Yes |
| No payment recorded | Yes |
| No publish/send triggered | Yes |
| No original invoice mutation | Yes |
| No payment ledger mutation | Yes |
| No contract total mutation | Yes |
| No pricing/quote behavior changed | Yes |
| No Supabase/schema changes in verification steps | Yes |
| No AI Closer changes | Yes |
| No Seller/Supervisor/sidebar changes | Yes |
| No internal cost/margin exposed | Yes |

---

## 9. Current status

| Step | Status |
|------|--------|
| **17C** — Remaining Balance Draft Invoice action | **PASS REAL complete** |
| **17C-FIX1** — quote_id constraint fix | **PASS REAL** |
| **17C-FIX2** — drawer label polish | **PASS REAL** |
| **Feature usable from Invoice Hub Actions** | **Yes** |

### Commit trail (main)

| Commit | Description |
|--------|-------------|
| `b12ea15` | Add remaining balance draft invoice action |
| `4e802a3` | Fix remaining balance invoice quote id constraint |
| `2144d06` | Polish remaining balance invoice drawer label |

---

## 10. Recommended next steps

1. **Step 18A** should be a **plan-only** step before any further code.
2. **Safe next options (owner choice):**
   - Improve owner workflow for **reviewing and sending** the new Remaining Balance draft via existing Invoice Hub send/resend flow (plan first)
   - **Leave feature stable** — current V1 meets create-draft + duplicate-guard + correct drawer copy requirements
3. **Do not** add automatic send, automatic payment recording, or publish-on-create without a separate approved plan.

---

## Appendix — Step 17D verification checklist

- [x] Documentation only
- [x] No production code changed
- [x] No Invoice Hub HTML/JS changed
- [x] No Netlify function changes
- [x] No Supabase/schema changes
- [x] No SQL executed
- [x] No DB writes or API calls added
- [x] No invoice/payment/email behavior changed in this step
