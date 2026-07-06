# Invoice Hub Complete Project Summary — Margin Guard

**Last updated:** Step 18D (production verification complete)  
**Production URL:** `https://marginguardsystem.netlify.app`  
**Primary surface:** `/estimates-invoices.html` (Invoice Hub)

---

## 1. Purpose of Invoice Hub

Invoice Hub is Margin Guard’s owner-facing workspace for managing customer invoices tied to projects and quotes. In plain language, it lets the owner:

- View and manage **draft**, **sent**, and **archived** invoices
- Track **contract total**, **paid to date**, **remaining balance**, and **invoice amount**
- Record payments against the project ledger
- Send or resend invoices to customers
- Create **Remaining Balance** draft invoices from an existing project/invoice context
- Cancel/archive invoices without deleting history

Invoice Hub is **owner/admin controlled** and **tenant-scoped**. Invoices are created and displayed in the context of a customer and project—not as disconnected standalone records. The design goal is that every invoice row reflects who it belongs to, what project it relates to, and what payment history exists.

Invoice Hub is separate from AI Closer, Seller/Supervisor portals, and the global sidebar/navigation shell.

---

## 2. Current Verified Production Status

The following capabilities are **PASS REAL** in production as of Step 18D:

| Capability | Status |
|------------|--------|
| Invoice Hub loads | Verified |
| Project/invoice drawer opens | Verified |
| Drawer shows contract total, paid to date, remaining balance, invoice amount | Verified |
| Drawer shows last payment, payment history, delivery email | Verified |
| **Create Remaining Balance Invoice** from Actions menu | Verified |
| Remaining Balance review modal prefills correctly | Verified |
| Remaining Balance draft creation (DRAFT only) | Verified |
| Duplicate guard blocks second active Remaining Balance draft | Verified |
| **Cancel invoice** archives safely (no delete) | Verified |
| Cancel uses `status = archived` + `voided_at` | Verified |
| Remaining Balance invoices show **Remaining balance due** (not Initial deposit due) | Verified |
| Feature production-usable when needed | Verified |

**Owner conclusion (Step 18D):** No active Remaining Balance draft is required right now. Test drafts were archived intentionally after verification. The feature remains available for future use.

---

## 3. Main Pages and Files

### Primary UI

| File | Role |
|------|------|
| `public/estimates-invoices.html` | Invoice Hub page shell: table, filters, drawer, modals, Actions menu DOM |
| `public/js/app.js` | Invoice Hub logic: row merge, drawer render, Actions menu, modals, API calls |

### Public customer surface

| File | Role |
|------|------|
| `public/invoice-public.html` | Customer-facing invoice page (token-based); shows balance and payment progress; **no owner Actions menu** |

### Key UI areas in `estimates-invoices.html`

| Element | ID / area | Purpose |
|---------|-----------|---------|
| Invoice list / hub table | Hub list section | Browse and filter invoices |
| **Create Invoice** button | `#btnHubCreateInvoice` | General manual invoice flow (separate from Remaining Balance) |
| **Project/invoice drawer** | `#hubDrawer` | Detail view: stats, progress, ledger, contact |
| Drawer next action | `#hubDrawerNextAction` | e.g. Remaining balance due, Paid in full |
| Drawer stats | `#hubDrawerStats` | Contract total, paid to date, remaining balance, invoice amount |
| Payment ledger | `#hubDrawerLedgerWrap` | `tenant_project_payments` history |
| **Actions menu** | `#btnHubDrawerActionsMenu`, `#hubDrawerActionsMenu` | Top-right drawer actions (Payment, Links, Document, Manage) |
| Record payment modal | `#hubRecordPaymentModal` | Owner records ledger payment |
| Payment reminder modal | `#hubPaymentReminderModal` | Preview/send reminder |
| Duplicate invoice modal | `#hubDuplicateInvoiceModal` | Confirm full duplicate |
| **Remaining Balance modal** | `#hubRemainingBalanceInvoiceModal` | Review/create remaining balance draft |
| **Cancel invoice modal** | `#hubCancelInvoiceModal` | Confirm cancel/archive |

### Actions menu sections (drawer)

1. **Payment** — Send/Resend, Record payment, Send payment reminder, **Create Remaining Balance Invoice**
2. **Links** — Open public link, Copy, Share
3. **Document** — Download PDF, Print
4. **Manage** — Edit client info, Archive, Duplicate as invoice, **Cancel invoice**

---

## 4. Main Netlify Functions

### Invoice listing and loading

| Function | Purpose |
|----------|---------|
| `list-tenant-invoices.js` | GET — list tenant invoices with ledger paid totals |
| `get-tenant-invoice.js` | GET — single invoice for owner |

### Invoice create / update

| Function | Purpose |
|----------|---------|
| `create-manual-invoice.js` | POST — manual invoice from pricing snapshot (**LOCKED**; general Create Invoice flow) |
| `upsert-tenant-invoice-draft.js` | POST — create/update draft invoice fields |
| `create-remaining-balance-invoice.js` | POST — **Remaining Balance** draft from source invoice (Step 17C) |
| `duplicate-tenant-invoice.js` | POST — duplicate full invoice as new draft |

### Send / publish / reminders

| Function | Purpose |
|----------|---------|
| `send-invoice-zapier.js` | POST — send/resend invoice email via Zapier |
| `publish-public-invoice.js` | Publish invoice to public surface |
| `send-invoice-payment-reminder.js` | POST — payment reminder email |
| `invoice-followups-due.js` | Scheduled follow-up processing |

### Payments

| Function | Purpose |
|----------|---------|
| `list-tenant-payments.js` | GET — ledger payments by invoice/project/quote |
| `record-tenant-payment.js` | POST — record payment; syncs invoice rollup |
| `create-invoice-checkout-session.js` | Stripe checkout for public pay |
| `stripe-invoice-webhook.js` | Stripe webhook handler |

### Cancel / archive / delete

| Function | Purpose |
|----------|---------|
| `cancel-tenant-invoice.js` | POST — cancel/archive invoice (`archived` + `voided_at`) |
| `hub-invoice-archive-delete.js` | POST — archive or hard delete (separate from cancel) |

### Public / contact

| Function | Purpose |
|----------|---------|
| `get-public-invoice.js` | GET — public invoice payload by token (no tenant/id exposure) |
| `patch-tenant-invoice-contact.js` | PATCH — edit client contact on invoice |

---

## 5. Core Invoice Workflows

### Draft invoice workflow

- Owner creates draft via **Create Invoice** (manual) or **Remaining Balance** (project-contextual) or duplicate.
- Draft stored with `status = draft` (or equivalent).
- Owner reviews in hub; edits via existing draft/contact flows if supported.
- **No automatic send** on create.

### Send / resend invoice workflow

- Drawer **Actions → Send invoice** or **Resend invoice**.
- Calls `send-invoice-zapier.js` with tenant-scoped invoice id/token.
- Owner-initiated only; not triggered by draft create.

### Record payment workflow

- Drawer **Actions → Record payment**.
- Modal collects amount, method, date.
- `record-tenant-payment.js` inserts `tenant_project_payments` row and may update invoice `paid_amount` / `balance_due` rollup.
- Does not change contract total or quote pricing.

### Remaining balance workflow

See Section 7.

### Cancel / archive invoice workflow

See Section 9.

### Public invoice view workflow

- Customer opens `invoice-public.html?token=...`.
- `get-public-invoice.js` returns safe public fields only.
- May show contract total, paid to date, remaining balance, payment link.
- **No owner Actions** on public page.

---

## 6. Remaining Balance Invoice Workflow (Verified)

### Owner flow

1. Open **Invoice Hub**.
2. Open original project/invoice drawer (e.g. **Remaining balance due**).
3. Click top-right **Actions**.
4. Click **Create Remaining Balance Invoice**.
5. Review modal: customer, email, project, contract total, paid to date, remaining balance.
6. Choose **Use remaining balance** or **Enter manual amount** (≤ remaining in V1).
7. Review/edit default message.
8. Click **Create Draft Invoice**.
9. Later: send manually via **Send invoice** / **Resend invoice** when ready.

### Safety (verified)

| Rule | Enforced |
|------|----------|
| DRAFT only on create | Yes |
| No email sent automatically | Yes |
| No payment recorded automatically | Yes |
| No publish/send automatic | Yes |
| No contract total mutation | Yes |
| No payment ledger mutation on create | Yes |
| No source `quote_id` copy (unique constraint) | Yes |
| Linked via customer/project/email + label + notes marker | Yes |

### Linkage fields (no `source_invoice_id` column)

- `invoice_label = "Remaining Balance"`
- `notes` contains `[source_invoice:<source_invoice_uuid>]`
- Customer name, email, project name copied from source

---

## 7. Production Example Verified

| Field | Value |
|-------|--------|
| Customer | Gonzalo & Isamar |
| Project | Upstairs bath #2 |
| Contract total | 6163.10 |
| Paid to date | 4500.00 |
| Remaining balance | 1663.10 |

**Verified in production:**

- Remaining Balance draft created successfully (1663.10).
- Accidental second draft at 1500.00 exposed duplicate-guard gap (fixed in FIX3).
- Duplicate guard tested and working after FIX3.
- Both test drafts cancelled/archived intentionally—no active Remaining Balance draft needed now.
- `payments_count` remained 0 throughout.
- `invoices_count` does not decrease on cancel (archive, not delete).

---

## 8. Cancel / Archive Workflow

### What cancel does

- **Does not delete** the invoice row.
- Sets `status = archived` (production `invoice_status_check` does not allow `void`).
- Sets `voided_at` to current timestamp (nullable column added per Step 18B migration).
- Sets `updated_at`.

### What cancel does not do

- Does not mutate `tenant_project_payments` ledger.
- Does not change contract total, quote pricing, or source invoice amounts.
- Does not send email or publish.

### Guards (server-side)

Cancel blocked when: archived already, paid, `paid_amount > 0`, ledger payments exist, Stripe payment trace, no balance due.

### UI

- Modal: “Cancel invoice?” — explains void/archive, not delete.
- Success message: **Invoice cancelled and archived.**

---

## 9. Supabase / Data Model Notes

### Core tables

| Table | Role |
|-------|------|
| `invoices` | Core invoice rows: customer, project, amounts, status, labels, notes, tokens |
| `tenant_project_payments` | Payment ledger (referenced as payments in docs); tied to invoice/project/quote |

### Important invoice fields

| Field | Usage |
|-------|--------|
| `tenant_id` | Tenant isolation |
| `status` | draft, sent, partial, paid, overdue, archived, etc. |
| `amount`, `paid_amount`, `balance_due` | Money fields |
| `invoice_label` | e.g. **Remaining Balance** |
| `notes` | Client message + `[source_invoice:<uuid>]` marker |
| `voided_at` | Nullable; set on cancel/archive (Step 18B) |
| `quote_id` | One invoice per quote per tenant (unique constraint) |
| `project_id` | Optional link to tenant project |

### Remaining Balance specifics

- **Does not copy** source `quote_id` (avoids `invoices_tenant_quote_unique` violation).
- Linkage via label + notes marker + customer/project context.
- No dedicated `source_invoice_id` column in current schema.

---

## 10. Duplicate Prevention (Remaining Balance)

**Rule:** Block any **active** Remaining Balance invoice for the same source invoice marker—**regardless of amount**.

| Match | Required |
|-------|----------|
| `tenant_id` | Yes |
| `invoice_label = "Remaining Balance"` | Yes |
| `notes` contains `[source_invoice:<uuid>]` | Yes |
| Active status (draft, open, sent, partial, overdue, issued, pending) | Yes |
| Amount match | **No** (removed in FIX3) |

**Does not block:** void, archived, paid, cancelled historical rows.

**Owner message:**

> A remaining balance draft invoice already exists for this project/invoice. Review or cancel the existing draft before creating another.

After archiving/cancelling the existing draft, owner may create a new Remaining Balance invoice when needed.

---

## 11. Important Safety Rules (Verified)

- No automatic email on draft create
- No automatic payment on draft create
- No automatic publish/send on draft create
- No quote/pricing engine change from Remaining Balance flow
- No contract total change
- No payment ledger mutation during Remaining Balance create
- No invoice deletion on cancel (archive only)
- Tenant-scoped API functions
- Owner/admin session required
- Internal cost, margin, overhead, labor rate **not exposed** in Invoice Hub or Remaining Balance flows

---

## 12. Known Current State

| Item | State |
|------|--------|
| Remaining Balance create flow | Production-usable when needed |
| Active Remaining Balance draft | **None required now** (test drafts archived) |
| Owner can create new one later | Yes — Actions → Create Remaining Balance Invoice |
| Sidebar integration | Not part of this feature |
| AI Closer | Separate; do not touch from Invoice Hub work |
| Cancel invoice | Works with `archived` + `voided_at` |
| General Create Invoice (manual) | Uses locked `create-manual-invoice.js` + pricing snapshot |

---

## 13. Recent Relevant Milestone Commits

| Commit | Description |
|--------|-------------|
| `ba4e35d` | Document project actions remaining balance invoice plan (Step 17A) |
| `5f5474a` | Inspect remaining balance invoice implementation path (Step 17B) |
| `b12ea15` | Add remaining balance draft invoice action (Step 17C) |
| `4e802a3` | Fix remaining balance invoice quote_id constraint (Step 17C-FIX1) |
| `2144d06` | Polish remaining balance invoice drawer label (Step 17C-FIX2) |
| `c91d69c` | Document remaining balance draft invoice verification (Step 17D) |
| `cff2180` | Inspect cancel invoice void workflow (Step 18A) |
| `5740f91` | Draft cancel invoice voided_at migration (Step 18B) |
| `d1b011e` | Strengthen remaining balance invoice duplicate guard (Step 17C-FIX3) |
| `54c9ca7` | Fix cancel invoice archived status (Step 18C-FIX1) |
| `b13854a` | Document remaining balance create cancel verification (Step 18D) |

---

## 14. What Should Not Be Changed Casually

- **Pricing engine** (`create-manual-invoice.js` is LOCKED)
- **Quote calculations** and contract total resolution logic
- **Payment ledger** insert/rollup logic (`record-tenant-payment.js`)
- **Public invoice** payment and display behavior without a plan
- **Send/resend** Zapier integration without regression testing
- **Seller/Supervisor** portal visibility or flows
- **AI Closer** modules
- **Sidebar / global navigation** shell
- **Supabase schema** without an approved migration plan (e.g. Step 18B-style drafts)

---

## 15. Recommended Next Safe Work

Possible future improvements (plan before coding):

1. **Step 19A** — Improve owner review/send workflow for Remaining Balance drafts (plan only first).
2. Clearer **filter** for archived/cancelled invoices in hub list.
3. **Remaining Balance** category or badge in Invoice Hub table.
4. **Project-linked invoice history** panel in drawer.
5. **Default message** templates polish.
6. Public invoice void/archived state display (display-only, if gap found).

**Do not add** automatic send, automatic payment recording, or publish-on-create without a separate approved plan.

---

## 16. Related Documentation Index

| Document | Topic |
|----------|--------|
| `STEP17A_PROJECT_ACTIONS_REMAINING_BALANCE_INVOICE_PLAN.md` | Remaining Balance plan |
| `STEP17B_REMAINING_BALANCE_INVOICE_INSPECTION.md` | Pre-implementation inspection |
| `STEP17C_REMAINING_BALANCE_DRAFT_INVOICE_IMPLEMENTATION.md` | Implementation notes |
| `STEP17C_FIX1` / `FIX2` / `FIX3` docs | quote_id, drawer label, duplicate guard |
| `STEP17D_REMAINING_BALANCE_DRAFT_INVOICE_VERIFIED.md` | Production verification |
| `STEP18A_CANCEL_INVOICE_VOID_INSPECTION.md` | Cancel void inspection |
| `STEP18B_CANCEL_INVOICE_VOIDED_AT_SQL_DRAFT.sql` | voided_at migration draft |
| `STEP18C_FIX1_CANCEL_INVOICE_STATUS_ARCHIVED.md` | archived status fix |
| `STEP18D_REMAINING_BALANCE_CREATE_CANCEL_VERIFIED.md` | Final create/cancel verification |

---

## 17. Final Summary

Invoice Hub is production-usable for draft creation, payment tracking, remaining balance invoice creation, and cancel/archive workflows. The safest next step is to leave this stable unless a new planned improvement is approved.
