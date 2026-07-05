# Margin Guard Step 17A — Project Actions Remaining Balance Invoice Plan

## 1. Purpose

Step 17A is **documentation only**. No production code changes are made in this step.

**Goal:** Plan a safe Owner workflow to create a **linked DRAFT invoice** from inside the existing top-right **Actions** menu in the Invoice Hub project/invoice detail drawer when the project shows **Remaining balance due**.

The owner must **not** feel like they are creating an invoice from zero. The new invoice should be generated from the current project/invoice context—already linked to the same customer, project, and payment history. The owner reviews, edits if needed, saves as draft, and later sends using the existing Invoice Hub send/resend flow.

**Step 17A delivers:** This plan document only. Implementation begins in Step 17B after owner approval.

---

## 2. Current existing behavior

The following capabilities already exist in production (Invoice Hub and related surfaces):

| Capability | Status |
|------------|--------|
| Invoice Hub project/invoice detail drawer (`#hubDrawer`) | Exists |
| Drawer header shows next action (e.g. **Remaining balance due**) | Exists |
| Stats grid: Contract total, Paid to date, Remaining balance, Invoice amount | Exists |
| Payment progress bar and last/next payment context | Exists |
| Delivery email and last reminder display | Exists |
| Ledger payment history (`tenant_project_payments` when server invoice) | Exists |
| Record payment from Actions menu | Exists |
| Send / Resend invoice from Actions menu | Exists |
| Send payment reminder from Actions menu | Exists |
| Duplicate as invoice (full copy of source amount) | Exists |
| Public invoice page shows remaining balance and payment progress | Exists |
| Remaining balance calculated as contract total minus payments recorded | Exists |

### Production example (verified UI context)

When a project has partial payment, the drawer currently shows values like:

| Field | Example |
|-------|---------|
| Project | Upstairs bath #2 |
| Customer | Gonzalo & Isamar |
| Email | chalonavarro835@gmail.com |
| Contract total | 6163.10 |
| Paid to date | 4500.00 |
| Remaining balance | 1663.10 |
| Invoice amount | 6163.10 |
| Last payment | 3500.00 on 07/02/2026 |
| Payment history | Present in ledger table |

**Next action label:** `Remaining balance due` (from `hubDrawerPaymentNextActionFromTotals()` when paid &lt; contract total).

### What is missing

There is **no** action to create a **linked draft invoice** for the remaining balance from this context. Owners must either:

- Use **Duplicate as invoice** (copies the **full** source invoice amount—not the remaining balance), or
- Use the general **Create Invoice** button (`#btnHubCreateInvoice`) and start from scratch.

Neither path matches the intended “remaining balance invoice from current project context” workflow.

### Relevant existing code anchors (for Step 17B inspection only)

| Area | Location |
|------|----------|
| Drawer Actions menu toggle | `public/estimates-invoices.html` — `#btnHubDrawerActionsMenu`, `#hubDrawerActionsMenu` |
| Actions menu builder | `public/js/app.js` — `renderHubDrawerActionsMenu(row)` |
| Menu enablement state | `public/js/app.js` — `getHubOverflowMenuState(row)` |
| Drawer detail / stats | `public/js/app.js` — `renderHubDrawerDetails(row, settings, handlers)` |
| Remaining balance logic | Contract total minus ledger net sum (or local paid fallback) |
| Active row context | `window.__MG_ACTIVE_INVOICE_ROW__` |
| Duplicate invoice backend | `netlify/functions/duplicate-tenant-invoice.js` |
| Manual invoice create | `netlify/functions/create-manual-invoice.js` (pricing engine; **not** the right pattern for remaining balance) |
| Draft upsert | `netlify/functions/upsert-tenant-invoice-draft.js` |

---

## 3. Exact UI placement

### Where the action belongs

Inside the existing top-right **Actions** menu of the Invoice Hub drawer (`#hubDrawerActionsMenu`), rendered by `renderHubDrawerActionsMenu(row)`.

```
┌─────────────────────────────────────────────────────────────┐
│  Remaining balance due                    [☰ Actions] [X] │
│  Upstairs bath #2                                           │
├─────────────────────────────────────────────────────────────┤
│  Contract total │ Paid to date │ Remaining │ Invoice amount │
│  ...            │ ...          │ 1663.10   │ ...             │
└─────────────────────────────────────────────────────────────┘
```

**Actions menu (future):**

```
Payment
  Send / Resend invoice
  Record payment
  Send payment reminder
  Create Remaining Balance Invoice   ← NEW (Step 17B+)

Links
  ...

Document
  ...

Manage
  Edit client info
  Archive
  Duplicate as invoice
  Cancel invoice
```

### Recommended section

Place **Create Remaining Balance Invoice** in the **Payment** section (above or below **Send payment reminder**), because it is payment/balance-related—not a generic document or manage action.

### Visibility / enablement rules

| Condition | Behavior |
|-----------|----------|
| Remaining balance &gt; 0 | Show and enable **Create Remaining Balance Invoice** |
| Remaining balance ≤ 0 (paid in full) | Hide item **or** show disabled with reason: *“No remaining balance — project is settled.”* |
| Archived / void invoice (if applicable) | Disable with clear reason (align with existing reminder/payment guards) |
| Non-server / local-only row without ledger | Step 17B must confirm eligibility; prefer server invoice rows with valid UUID |

### Where it must NOT appear

| Surface | Reason |
|---------|--------|
| Standalone button outside the drawer | Violates design—Actions menu is the single drawer action surface |
| General **Create Invoice** button (`#btnHubCreateInvoice`) | That flow starts from zero; remaining balance is project-contextual |
| Public invoice page (`public/invoice-public.html`) | Customer-facing; no owner Actions menu |
| AI Closer Owner Inbox / lab flows | Out of scope |
| Seller / Supervisor portals | Owner-only feature |
| Sidebar or global nav | Out of scope |

---

## 4. Owner workflow goal

End-to-end Owner flow (future, after Step 17B/17C implementation):

1. Open **Invoice Hub** (`public/estimates-invoices.html`).
2. Open a project/invoice row whose next action is **Remaining balance due**.
3. Review contract total, paid to date, remaining balance, invoice amount, and payment history in the drawer.
4. Click top-right **Actions**.
5. Click **Create Remaining Balance Invoice**.
6. Review the prefilled confirmation modal (see Section 5).
7. Accept default remaining balance amount **or** enter a manual amount (within V1 rules).
8. Review/edit the default invoice message.
9. Click **Create Draft Invoice**.
10. New invoice appears in Invoice Hub as **draft**, linked to the same customer/project context.
11. Owner later edits (if needed) and sends via existing **Send invoice** / **Resend invoice** Actions flow—no automatic send in V1.

The owner should never need to re-enter customer name, project name, or email from scratch when the source drawer already has that context.

---

## 5. Review modal / confirmation screen

Before creating the invoice, show a dedicated review modal (new UI in Step 17B—not part of Step 17A).

### Prefilled read-only context

| Field | Source |
|-------|--------|
| Customer name | Active drawer row (`row.customer` / server invoice `customer_name`) |
| Delivery email | Drawer delivery email / `row.customerEmail` |
| Project name | `row.title` / `project_name` |
| Contract total | `row.projectContractTotal` |
| Paid to date | Ledger net sum (server) or local paid fallback |
| Remaining balance | `max(0, contractTotal - paidToDate)` |

### Editable / selectable fields

| Field | Behavior |
|-------|----------|
| **Invoice amount** | Numeric input, default = remaining balance |
| **Amount option: Use remaining balance** | Radio/toggle; sets amount to computed remaining balance |
| **Amount option: Enter manual amount** | Radio/toggle; enables manual entry; label clearly indicates manual |
| **Invoice label / type** | Display: **Remaining Balance** (stored in `invoice_label` or equivalent if supported) |
| **Default invoice message** | Textarea prefilled from template (Section 6); editable before create |
| **Optional internal owner note** | Include only if current Invoice Hub draft/create flow already supports a separate internal note field |

### Actions

| Button | Behavior |
|--------|----------|
| **Cancel** | Close modal; no API call; no draft created |
| **Create Draft Invoice** | Validate amount; confirm; call future backend; create DRAFT only |

Always show this confirmation step—no one-click draft creation without review.

---

## 6. Default invoice message

### Recommended template

```
Hi {{customer_name}}, here is the remaining balance invoice for {{project_name}}. This invoice reflects the payments recorded to date. Please review the balance due and let us know if you have any questions. Thank you for choosing {{business_name}}.
```

### Placeholder resolution (Step 17B)

| Token | Source |
|-------|--------|
| `{{customer_name}}` | Customer name from source row |
| `{{project_name}}` | Project / invoice title |
| `{{business_name}}` | Tenant business name from settings / invoice row |

### Requirements

- Message is stored/copied into the new invoice **notes** or **message** field if the schema supports it.
- Message remains editable later via existing Invoice Hub edit flow if supported.
- **Do not send automatically in V1.** Draft only; owner sends manually later.

---

## 7. Amount rules

| Rule | Detail |
|------|--------|
| Default amount | Current **remaining balance** (server-calculated in backend; UI preview from drawer) |
| Minimum | Manual amount must be **&gt; 0** |
| Maximum (V1) | Manual amount should **not exceed remaining balance** unless a future step adds explicit owner override with additional confirmation |
| Rounding | Round to cents (2 decimal places) on client display and server validation |
| Manual selection | When manual amount is chosen, UI must label it clearly (e.g. “Manual amount”) |
| Confirmation | Always require review modal + **Create Draft Invoice** click before insert |

### Production example amounts

| Field | Value |
|-------|-------|
| Contract total | 6163.10 |
| Paid to date | 4500.00 |
| Remaining balance (default invoice amount) | **1663.10** |

---

## 8. Linked invoice behavior

The new invoice must inherit from the source project/invoice as much as the current schema allows. It is **not** a blank manual invoice.

### Fields to copy / set on create

| Field | Value |
|-------|-------|
| `tenant_id` | From session / source invoice |
| `customer_name` | From source |
| `customer_email` | From source |
| `project_name` | From source |
| `project_id` | From source if UUID present (see `duplicate-tenant-invoice.js` pattern) |
| Quote / project reference | Copy if available on source row |
| Source invoice reference | Store link to source `invoice_id` if schema supports (`source_invoice_id` or metadata—Step 17B to confirm) |
| `invoice_label` | **Remaining Balance** (or normalized equivalent) |
| `notes` / message | Default message from Section 6 |
| `amount` | Selected amount (default remaining balance) |
| `paid_amount` | **0** |
| `balance_due` | Same as `amount` |
| `status` | **draft** |
| `type` | Step 17B to map to allowed types (`DEPOSIT`, `PROGRESS`, `FINAL`)—likely **PROGRESS** or a dedicated label via `invoice_label` |
| `public_token` | New token (do not reuse source) |
| `invoice_no` | New number (do not reuse source) |

### Must not copy blindly

- Do **not** copy source `amount` when it equals contract total—use **remaining balance** instead.
- Do **not** copy payment history onto the new invoice row.
- Do **not** alter the original invoice row.

---

## 9. Duplicate prevention

Prevent accidental duplicate remaining-balance draft invoices for the same source context.

### V1 intent

| Scenario | Behavior |
|----------|----------|
| Active draft/open remaining-balance invoice already exists for same source project/invoice and same amount | **Warn or block** duplicate creation |
| Historical paid/completed remaining-balance invoices | **Do not block**—only active duplicates |
| Owner intentionally creates a second draft after deleting the first | Allow (Step 17B defines “active”) |

### Proposed duplicate key (subject to Step 17B schema inspection)

Candidate match criteria (all must be confirmed against actual `invoices` table columns):

- Same `tenant_id`
- Same `project_id` (or same `project_name` + `customer_email` fallback if no project_id)
- Same `source_invoice_id` (if column added) or same source invoice UUID in metadata
- `invoice_label` indicates **Remaining Balance**
- `status` in (`draft`, `open`, `sent`, `published`) — exclude `paid`, `void`, `archived`, `cancelled`
- Optional: same `amount` within cent tolerance

**Step 17B must inspect existing invoice fields and duplicate patterns before choosing the exact strategy.** Do not implement duplicate logic until inspection confirms available columns and indexes.

---

## 10. Backend recommendation for future implementation

After Step 17A owner approval, **Step 17B** should produce a pre-implementation inspection report **before** any coding.

### Likely new Netlify function

**Name:** `create-remaining-balance-invoice.js`

**HTTP:** `POST`

**Auth:** Owner/admin session required (same pattern as `duplicate-tenant-invoice.js`).

### Request body (draft)

```json
{
  "source_invoice_id": "<uuid>",
  "amount_mode": "remaining_balance | manual",
  "manual_amount": 1663.10,
  "notes": "Hi Gonzalo & Isamar, here is the remaining balance invoice for Upstairs bath #2. ..."
}
```

### Server responsibilities

1. Resolve tenant from session (`resolveTenantFromSession`).
2. Load source invoice/project (tenant-scoped).
3. **Recalculate remaining balance server-side** from contract total and ledger payments—do not trust client-only totals.
4. Validate manual amount (&gt; 0, ≤ remaining balance in V1).
5. Check duplicate prevention rules (Section 9).
6. Insert **one DRAFT invoice row** only.
7. Return `{ ok: true, invoice_id, status: "draft", amount, ... }`.

### Function must NOT

| Prohibited action | Reason |
|-------------------|--------|
| Send email | V1 draft only; owner sends later |
| Create payment | Payments remain on ledger / separate flow |
| Mark invoice paid | Would corrupt balances |
| Publish/send automatically | Owner review required |
| Alter quote/project pricing | Pricing engine out of scope |
| Alter `paid_to_date` on source | Ledger is source of truth |
| Alter original invoice `amount` | Original invoice unchanged |
| Alter contract total | Display/calculation read-only |

### Reuse candidates (Step 17B to confirm)

- `duplicate-tenant-invoice.js` — insert pattern, `makePublicToken`, field picking
- `upsert-tenant-invoice-draft.js` — draft status handling
- Ledger fetch used by drawer — same remaining balance math as UI
- `_lib/session`, `_lib/supabase-admin`, `_lib/tenant-for-session`

**Do not reuse** `create-manual-invoice.js` as-is—it invokes pricing engine and blank-invoice semantics.

---

## 11. Future Step 17B inspection scope

Step 17B must **not code immediately**. First deliver an inspection report confirming exact files, functions, and schema fields.

### Areas to inspect (read-only)

| Area | Files / symbols |
|------|-----------------|
| Invoice Hub HTML | `public/estimates-invoices.html` — drawer, Actions menu DOM, modal slots |
| Invoice Hub JS | `public/js/app.js` — `renderHubDrawerActionsMenu`, `getHubOverflowMenuState`, `renderHubDrawerDetails`, drawer action handlers, `fetchHubDrawerLedgerPayments`, duplicate handler |
| Netlify invoice functions | `duplicate-tenant-invoice.js`, `upsert-tenant-invoice-draft.js`, `publish-public-invoice.js`, send/reminder functions |
| Invoice create payloads | Existing POST bodies and insert columns |
| Invoices table | Read-only inspection of fields: `project_id`, `invoice_label`, `type`, `status`, `notes`, linkage columns |
| Public invoice | `public/invoice-public.html` — confirm no owner Actions leakage |

### Step 17B deliverables

1. Exact files to modify (likely `app.js`, `estimates-invoices.html`, new function file, docs).
2. Exact existing functions to reuse vs. extend.
3. Exact new function contract if required.
4. Exact duplicate prevention strategy and query.
5. Exact UI placement in Actions menu (Payment section).
6. Exact field mapping for customer/project/email/message/amount/status.
7. **No production commit until owner approves Step 17B report.**

---

## 12. Safety confirmations for future Step 17C

Before production deploy of the feature, Step 17C must confirm:

| Safety rule | Expected |
|-------------|----------|
| DRAFT invoice only on create | Yes |
| Owner review modal before create | Yes |
| No automatic email on create | Yes |
| No automatic payment on create | Yes |
| No publish/send trigger on create | Yes |
| No quote/pricing engine change | Yes |
| No project contract total change | Yes |
| No payment ledger change | Yes |
| Owner/admin auth only | Yes |
| Tenant-scoped queries and inserts | Yes |
| Duplicate protected | Yes |
| Linked to source project/invoice context | Yes |
| No internal cost/margin/overhead/labor exposure | Yes |
| Seller/Supervisor/AI Closer untouched | Yes |

---

## 13. Test plan for future production smoke

Use the production example project:

| Metric | Value |
|--------|-------|
| Contract total | 6163.10 |
| Paid to date | 4500.00 |
| Remaining balance | 1663.10 |

### Test steps

1. Open Invoice Hub.
2. Open the project/invoice detail drawer for **Upstairs bath #2** (or equivalent test row).
3. Confirm next action: **Remaining balance due**.
4. Open top-right **Actions**.
5. Confirm **Create Remaining Balance Invoice** is visible and enabled.
6. Click **Create Remaining Balance Invoice**.
7. Confirm review modal prefilled:
   - Customer: Gonzalo & Isamar
   - Email: chalonavarro835@gmail.com
   - Project: Upstairs bath #2
   - Contract total: 6163.10
   - Paid to date: 4500.00
   - Remaining balance: 1663.10
   - Default amount: 1663.10
   - Invoice label/type: Remaining Balance
   - Default message present with resolved names
8. Click **Create Draft Invoice**.
9. Confirm `invoices_count` increases by **+1 only**.
10. Confirm `payments_count` **unchanged**.
11. Confirm **original invoice unchanged** (amount, status, payments).
12. Confirm **new invoice**:
    - `amount` = 1663.10
    - `status` = draft
    - Customer/project/email copied correctly
    - Default message in notes/message field
13. Confirm **no email sent** (no send webhook, no sent timestamp unless owner sends later).
14. Confirm **no payment created**.
15. Repeat **Create Remaining Balance Invoice** on same source—confirm duplicate guard blocks or warns; **no second draft** created.

### Negative tests

| Case | Expected |
|------|----------|
| Paid-in-full project | Action hidden or disabled with reason |
| Manual amount 0 or negative | Validation error; no create |
| Manual amount &gt; remaining balance (V1) | Validation error; no create |
| Cancel on review modal | No API call; counts unchanged |

---

## 14. Must-not-do list

Step 17A and all future steps in this feature must **not**:

- Send invoice automatically in V1
- Record payment on create
- Mark invoice paid on create
- Modify payments ledger
- Modify contract total
- Modify original invoice amount
- Delete or overwrite existing invoices
- Touch Stripe/Square payment flows
- Touch AI Closer
- Touch Seller/Supervisor flows
- Touch sidebar or global navigation
- Expose internal cost, margin, overhead, labor rate, or protected pricing internals
- Modify `public/estimates-invoices.html` in Step 17A (planning only)
- Modify `public/js/app.js` in Step 17A
- Modify Netlify functions in Step 17A
- Modify Supabase schema or run SQL in Step 17A

---

## 15. Final recommendation

1. **Approve this Step 17A plan** before any implementation work.
2. **Proceed with Step 17B inspection report only** after approval—no coding until the report confirms the exact path.
3. Keep the workflow **inside the existing project/invoice Actions menu**—not a separate button, not general Create Invoice, not public page.
4. **V1 scope:** Create **DRAFT** invoice only; owner sends later via existing Invoice Hub flow.
5. Prefer a dedicated **`create-remaining-balance-invoice.js`** function over reusing duplicate or manual-create flows, because amount semantics and duplicate rules differ.
6. Do **not push** Step 17A documentation until owner approves (local commit only).

### Suggested sequence

| Step | Deliverable |
|------|-------------|
| **17A** (this document) | Plan — documentation only |
| **17B** | Pre-implementation inspection report + approved file/function list |
| **17C** | Implementation + production smoke verification doc |

---

## Appendix — Step 17A verification checklist

This step created **one file only:**

- `docs/STEP17A_PROJECT_ACTIONS_REMAINING_BALANCE_INVOICE_PLAN.md`

Confirm before commit:

- [ ] Only the doc file changed
- [ ] Documentation only
- [ ] No production code changed
- [ ] No `estimates-invoices.html` / `app.js` changes
- [ ] No Netlify function changes
- [ ] No Supabase/schema changes
- [ ] No SQL executed
- [ ] No DB writes or API calls added
- [ ] No invoice/payment/email behavior changed
- [ ] No pricing/quote behavior changed
- [ ] No internal cost/margin exposed
