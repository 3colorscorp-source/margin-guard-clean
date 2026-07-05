# Margin Guard Step 17B — Remaining Balance Invoice Pre-Implementation Inspection

## 1. Purpose

Step 17B is **inspection and documentation only**. No production code changes are made in this step.

**Goal:** Inspect the current Invoice Hub project/invoice drawer, top-right Actions menu, invoice creation Netlify functions, and related data flows so Step 17C can implement **Create Remaining Balance Invoice** on the safest, smallest path.

**Baseline:** Step 17A plan approved and pushed (`ba4e35d`).

**Output:** This inspection report. **No code until owner approves this document.**

---

## 2. Files inspected

| File | Relevant symbols / areas | Change in Step 17C? |
|------|--------------------------|---------------------|
| `public/estimates-invoices.html` | `#hubDrawer`, `#btnHubDrawerActionsMenu`, `#hubDrawerActionsMenu`, `#hubDuplicateInvoiceModal`, `#hubPaymentReminderModal`, `#btnHubCreateInvoice` | **Yes** — add review modal DOM; optional CSS for new modal |
| `public/js/app.js` | `getHubOverflowMenuState`, `renderHubDrawerActionsMenu`, `dispatchHubDrawerAction`, `renderHubDrawerDetails`, `fetchHubDrawerLedgerPayments`, `resolveContractTotalForServerInvoiceNorm`, `normalizeServerInvoiceForHub`, `buildPortfolioRowFromServerInvoiceNorm`, `openHubDuplicateInvoiceModal`, `openHubPaymentReminderModal`, `postHubInvoiceDuplicate`, `window.__MG_ACTIVE_INVOICE_ROW__` | **Yes** — menu item, modal wiring, API call |
| `netlify/functions/duplicate-tenant-invoice.js` | `buildDuplicateInsert`, `exports.handler` | **No** — reference only; not suitable to extend |
| `netlify/functions/create-manual-invoice.js` | Pricing engine insert path; **LOCKED STABLE FILE** | **No** — must not use for remaining balance |
| `netlify/functions/upsert-tenant-invoice-draft.js` | `UPSERT_KEYS`, create draft insert | **No** — generic draft upsert; lacks balance math and duplicate guard |
| `netlify/functions/list-tenant-invoices.js` | `sumLedgerPaidByInvoiceId`, list + `ledger_paid_total` | **No** — read pattern for server-side ledger sums |
| `netlify/functions/list-tenant-payments.js` | GET ledger by `invoice_id` / `project_id` / `quote_id` | **No** — read pattern; new function should reuse query logic |
| `netlify/functions/record-tenant-payment.js` | POST payment + `syncInvoiceRollupFromLedger` | **No** — read-only; must not be invoked from remaining-balance create |
| `netlify/functions/send-invoice-zapier.js` | POST send/resend | **No** — must not be called on draft create |
| `netlify/functions/send-invoice-payment-reminder.js` | Reminder send | **No** |
| `netlify/functions/publish-public-invoice.js` | Publish flow | **No** |
| `netlify/functions/get-public-invoice.js` | Public payload fields (`notes`, `invoice_label`, amounts) | **No** — confirms public surface uses `notes` for client message |
| `netlify/functions/get-tenant-invoice.js` | Single invoice fetch | **No** — optional read helper pattern |
| `netlify/functions/patch-tenant-invoice-contact.js` | Contact edit | **No** |
| `netlify/functions/cancel-tenant-invoice.js` | Void invoice | **No** |
| `netlify/functions/hub-invoice-archive-delete.js` | Archive/delete | **No** |
| `docs/STEP17A_PROJECT_ACTIONS_REMAINING_BALANCE_INVOICE_PLAN.md` | Approved plan | **No** — reference |
| `public/invoice-public.html` | Customer-facing invoice | **Must NOT touch** |
| `public/js/sales-device-portal.js` | Seller portal | **Must NOT touch** |
| AI Closer HTML/JS under `public/` | Owner inbox / lab | **Must NOT touch** |

---

## 3. Existing Actions menu findings

### Where the menu is rendered

**HTML shell** (`public/estimates-invoices.html`, drawer header):

- Toggle: `#btnHubDrawerActionsMenu` — label `☰ Actions`
- Menu container: `#hubDrawerActionsMenu` (`role="menu"`, initially `hidden`)

**JS builder** (`public/js/app.js`, `renderHubDrawerActionsMenu(row)` ~6454):

- Builds four sections via innerHTML:
  1. **Payment** — send/resend, record payment, send payment reminder
  2. **Links** — open public, copy, share
  3. **Document** — download PDF, print
  4. **Manage** — edit client, archive, duplicate, cancel

Each item is a `<button role="menuitem" data-hub-drawer-action="…">` with `disabled` when not enabled.

### How clicks are handled

- `hubDrawerActionsMenu` click listener (~16611) → `dispatchHubDrawerAction(action)` (~15541)
- Actions close menu first via `closeHubDrawerActionsMenu()`
- Existing action keys: `send-invoice`, `record-payment`, `send-reminder`, `open-public`, `copy-link`, `share`, `download-pdf`, `print`, `edit-client`, `archive`, `duplicate`, `cancel`

### Where to insert **Create Remaining Balance Invoice**

**Recommended:** Payment section, after **Send payment reminder** (or before it), new action key e.g. `create-remaining-balance-invoice`.

```javascript
// renderHubDrawerActionsMenu — Payment section (future)
item("create-remaining-balance-invoice", "Create Remaining Balance Invoice", menuState.canCreateRemainingBalanceInvoice)
```

### Enablement conditions (existing pattern)

`getHubOverflowMenuState(row)` (~6185) returns flags such as:

| Flag | Current rule |
|------|----------------|
| `canDuplicateInvoice` | Server invoice + valid UUID + not archived |
| `canRecordPayment` | Ledger-capable row + balance + not archived |
| `canSendPaymentReminder` | Server + balance + not paid + email + not void/archived |
| `hasBalance` | `finiteNumber(row?.balance, 0) > 0.005` |

**New flag needed:** `canCreateRemainingBalanceInvoice` — recommend:

- `row.hubRowSource === "server_invoice"`
- Valid server invoice UUID (`hubRowServerInvoiceUuid`)
- Not archived / not void
- **Project remaining balance > 0** (contract total − ledger paid), not merely invoice row `balance`
- Has valid customer email (same guard as send reminder)

When remaining ≤ 0: hide item or show disabled with tooltip *“No remaining balance — project is settled.”*

### Modal patterns to reuse

| Feature | Modal | Pattern |
|---------|-------|---------|
| Duplicate | `#hubDuplicateInvoiceModal` | Simple confirm + POST |
| Payment reminder | `#hubPaymentReminderModal` | Prefilled copy + confirm send |
| Record payment | `#hubRecordPaymentModal` | Form + POST |

Remaining balance should follow **reminder + duplicate hybrid**: prefilled review fields (reminder) + create draft only (duplicate, no send).

---

## 4. Existing remaining balance data findings

### Contract total

| Location | Function / field |
|----------|------------------|
| Hub row | `row.projectContractTotal` |
| Normalization | `resolveContractTotalForServerInvoiceNorm(norm)` (~12256) |
| Priority | 1) `norm.quoteTotal` (from joined quote) → 2) local `loadProjects()` match by quote/project id → 3) name match → 4) fallback `norm.amount` |
| Drawer display | `renderHubDrawerDetails` — `contractTotal = Math.max(finiteNumber(row.projectContractTotal, 0), 0)` (~14842) |

### Paid to date

| Location | Function / field |
|----------|------------------|
| Server list cache | `normalizeServerInvoiceForHub` — `paidAmount` = max(`paid_amount`, `ledger_paid_total`) (~12196–12200) |
| Hub row (local) | `row.depositApplied + row.receivedApplied` |
| Drawer (async) | `fetchHubDrawerLedgerPayments(row)` → `pack.netSum` (~14065–14081) |
| Ledger API | `GET /.netlify/functions/list-tenant-payments?invoice_id|project_id|quote_id` |
| Ledger target resolution | `hubLedgerTargetIds(row)` — prefers `invoice_id`, else `project_id`, else `quote_id` (~14046) |

### Remaining balance

| Location | Calculation |
|----------|-------------|
| Hub row (norm) | `balanceDue = max(0, contractTotal - paidAmount)` in `normalizeServerInvoiceForHub` (~12211) |
| Drawer (initial) | `max(0, contractTotal - localPaid)` before ledger loads (~14846) |
| Drawer (after ledger) | `max(0, contractTotal - pack.netSum)` (~14925) |
| Next action label | `hubDrawerPaymentNextActionFromTotals(paid, total)` → `"Remaining balance due"` when `0 < paid < total` (~14735) |

### Invoice amount (separate from remaining)

- Drawer stat **Invoice amount** = `row.amount` (amount billed on **this** invoice row), not remaining balance (~14841, ~14869).

### Available in drawer state vs server recalculation

| Value | Client drawer | Server required? |
|-------|---------------|------------------|
| Customer / email / project name | Yes — `row.customer`, `row.customerEmail`, `row.title` | Re-load from source invoice for trust |
| Contract total | Yes — `row.projectContractTotal` | **Yes — recalculate** (quote join + fallbacks) |
| Paid to date | Yes after ledger fetch; may be stale briefly | **Yes — sum `tenant_project_payments` server-side** |
| Remaining balance | Yes in DOM `#hubDrawerLedgerRemainingBig` after load | **Yes — never trust client amount alone** |

**Important:** Drawer ledger filter uses `invoice_id` first when present. Server function must mirror `hubLedgerTargetIds` priority so remaining balance matches what the owner sees.

### Active row context

- `window.__MG_ACTIVE_INVOICE_ROW__ = row` set in `renderHubDrawerDetails` (~14835)
- Drawer row key: `drawerEl.dataset.hubDrawerRowKey` = server invoice id or project id

---

## 5. Existing invoice creation findings

### UI entry points (distinct flows)

| Entry | Function / endpoint | Purpose |
|-------|---------------------|---------|
| **Create Invoice** button | `#btnHubCreateInvoice` → manual invoice form → `create-manual-invoice` | Blank/manual with pricing engine |
| **Duplicate as invoice** | Actions → `duplicate-tenant-invoice` | Full copy of source row |
| **Draft upsert** (elsewhere) | `upsert-tenant-invoice-draft` (~5618 in app.js) | Generic draft create/update |

Remaining balance must **not** use Create Invoice or manual form.

### Netlify functions that insert invoices

#### `duplicate-tenant-invoice.js`

- **Body:** `{ invoice_id }`
- **Auth:** session + `resolveTenantFromSession`
- **Insert:** `buildDuplicateInsert` — copies source fields, **`amount = source.amount`**, `paid_amount = 0`, `status = "draft"`, new `public_token` / `invoice_no`
- **Types:** `DEPOSIT` | `PROGRESS` | `FINAL` (default PROGRESS)
- **Optional:** `project_id` if UUID on source

#### `upsert-tenant-invoice-draft.js`

- **Body:** any of `UPSERT_KEYS` (customer, project, amount, notes, `invoice_label`, `type`, `status`, etc.)
- **Create:** defaults `status = draft`, computes `balance_due = amount - paid_amount`
- **No** contract-total or ledger logic
- **No** duplicate prevention

#### `create-manual-invoice.js` (LOCKED)

- Requires pricing snapshot + billing type + quantity
- Builds structured `notes` with labor/material breakdown (exposes sell rates in notes — **wrong surface for remaining balance**)
- Sets `invoice_label: "Manual Invoice"`, `type: "PROGRESS"`

### Field storage conventions (`invoices` table, from function usage)

| Field | Usage |
|-------|--------|
| `tenant_id` | Always from session on create |
| `customer_name`, `customer_email`, `project_name` | Client-facing identity |
| `project_id` | Optional UUID link to `tenant_projects` |
| `quote_id` | Optional UUID link to quote |
| `amount`, `paid_amount`, `balance_due` | Money; new invoice starts paid=0, balance=amount |
| `status` | `draft`, `sent`, `partial`, `paid`, `overdue`, `void`, `archived` |
| `type` | `DEPOSIT`, `PROGRESS`, `FINAL` only |
| `invoice_label` | Human label (e.g. "Manual Invoice", deposit/progress labels) — **use for "Remaining Balance"** |
| `notes` | Client-visible message on public invoice (`get-public-invoice` selects `notes`) |
| `business_name`, `currency`, `issue_date`, `due_date` | Branding / dates |
| `public_token`, `invoice_no` | New per invoice |

**No `source_invoice_id` column** is written anywhere in the codebase. `duplicate-tenant-invoice` returns `source_invoice_id` in the JSON response only; it is not persisted on the new row.

### Internal owner note

No separate internal-only note field found in `UPSERT_KEYS` or duplicate insert. **V1:** use `notes` for the default client message (same as reminder/duplicate pattern). Owner can edit via existing draft edit if available.

---

## 6. Existing duplicate invoice behavior

### What `duplicate-tenant-invoice.js` does

1. Loads source invoice (tenant-scoped GET)
2. Rejects archived source
3. Inserts new row with **same `amount` as source**, same `invoice_label`, same `notes`, same `type`
4. Resets `paid_amount = 0`, `balance_due = amount`, `status = draft`
5. Does **not** send email, record payment, or modify source

### Can it be reused?

**No — not safely for remaining balance.**

| Issue | Detail |
|-------|--------|
| Wrong amount | Always copies `source.amount` (e.g. 6163.10), not remaining (1663.10) |
| Wrong label | Copies source label, not "Remaining Balance" |
| Wrong notes | Copies original invoice notes, not balance message |
| No duplicate guard | Always creates another draft |
| No balance validation | No server-side remaining math |

### Could it be extended?

Technically possible (add body params for amount/label/notes) but would **blur** duplicate semantics and risk regressions on existing **Duplicate as invoice** flow. Not recommended.

### Recommendation

**New dedicated function** `create-remaining-balance-invoice.js` that borrows **insert shape** from `buildDuplicateInsert` but with different amount/label/notes logic and duplicate checks.

---

## 7. Recommended implementation path for Step 17C

### **Option B: New owner-only Netlify function** (recommended)

| Option | Verdict |
|--------|---------|
| **A — Reuse duplicate/create** | Rejected — wrong amount semantics; `create-manual-invoice` locked and pricing-based |
| **B — New function** | **Recommended** — isolated, testable, server-side balance + duplicate guard |
| **C — Hybrid** | Partially valid: UI in app.js + HTML modal, but backend should still be **new function**, not upsert-only |

### Why Option B

1. Server must recalculate remaining balance (ledger + contract total) — none of the existing create endpoints do this.
2. Duplicate prevention requires a targeted query — not in upsert or duplicate.
3. Keeps **Duplicate as invoice** and **Create manual invoice** untouched.
4. Single POST with explicit intent; easier smoke test (`invoices_count +1`, `payments_count` unchanged).
5. No schema migration required for V1.

---

## 8. Recommended exact files for Step 17C

### Files to modify / add

| File | Changes |
|------|---------|
| `public/estimates-invoices.html` | Add `#hubRemainingBalanceInvoiceModal` (review UI); optional CSS block near other hub modals |
| `public/js/app.js` | `canCreateRemainingBalanceInvoice` in `getHubOverflowMenuState`; menu item in `renderHubDrawerActionsMenu`; handler in `dispatchHubDrawerAction`; modal open/confirm/close helpers; `postHubRemainingBalanceInvoice` fetch |
| `netlify/functions/create-remaining-balance-invoice.js` | **New** — auth, load source, balance math, duplicate check, draft insert |
| `docs/STEP17C_REMAINING_BALANCE_INVOICE_IMPLEMENTATION.md` | Implementation + smoke verification doc (after coding) |

### Files that must NOT be touched

| File | Reason |
|------|--------|
| `netlify/functions/create-manual-invoice.js` | LOCKED STABLE FILE |
| `netlify/functions/duplicate-tenant-invoice.js` | Existing behavior must not change |
| `public/invoice-public.html` | Out of scope |
| `public/js/sales-device-portal.js` | Seller — out of scope |
| AI Closer files | Out of scope |
| Sidebar / dashboard / `mg-app-nav.js` | Out of scope |
| Supabase SQL / schema | No migration for V1 |
| Pricing engine `_lib/pricing-engine` | Out of scope |

---

## 9. Recommended UI design for Step 17C

### Actions menu

- **Label:** `Create Remaining Balance Invoice`
- **Action key:** `create-remaining-balance-invoice`
- **Section:** Payment
- **Visible when:** `canCreateRemainingBalanceInvoice === true`

### Review modal (`#hubRemainingBalanceInvoiceModal`)

Mirror structure of `#hubDuplicateInvoiceModal` + prefilled fields from `#hubPaymentReminderModal`.

**Read-only summary**

- Customer name
- Delivery email
- Project name
- Contract total
- Paid to date
- Remaining balance

**Editable**

- Amount mode radio:
  - **Use remaining balance** (default) — amount locked to computed remaining
  - **Enter manual amount** — number input; show “Manual amount” helper text
- Invoice label display: **Remaining Balance** (read-only or hidden field)
- Default message textarea (prefilled from Step 17A template, tokens resolved client-side for preview; server resolves again on create)

**Buttons**

- **Cancel** — close, no API
- **Create Draft Invoice** — POST new function; disable while loading

**After success**

- Refetch hub invoices (`__mgHubRefetchServerInvoices`)
- Optional: open new draft row in drawer (same as duplicate success path ~16676–16686)
- Hub feedback: “Remaining balance draft invoice created.”
- **Do not** call send-invoice or publish

### Default message (from Step 17A)

```
Hi {{customer_name}}, here is the remaining balance invoice for {{project_name}}. This invoice reflects the payments recorded to date. Please review the balance due and let us know if you have any questions. Thank you for choosing {{business_name}}.
```

---

## 10. Recommended backend validation for Step 17C

New function: `POST /.netlify/functions/create-remaining-balance-invoice`

### Request body (proposed)

```json
{
  "source_invoice_id": "<uuid>",
  "amount_mode": "remaining_balance",
  "manual_amount": null,
  "notes": "<resolved default message, editable>"
}
```

### Server steps

1. **Auth** — `readSessionFromEvent`; 401 if missing
2. **Tenant** — `resolveTenantFromSession`; reject cross-tenant `tenant_id` in body
3. **Load source** — GET `invoices` where `id` + `tenant_id`; 404 if missing; 422 if archived/void
4. **Contract total** — mirror client logic: prefer joined `quotes.total`, else source amount (server cannot call `loadProjects()`; use quote embed or invoice amount)
5. **Paid to date** — sum `tenant_project_payments` using same priority as drawer: filter by source `invoice_id`, else `project_id`, else `quote_id` (reuse pattern from `list-tenant-payments.js`)
6. **Remaining** — `max(0, round(contractTotal - paid, 2))`; reject if ≤ 0
7. **Amount** — if `remaining_balance` mode: use remaining; if manual: validate `> 0` and `<= remaining` (V1)
8. **Duplicate check** — see Section 11
9. **Insert** — draft row only:
   - Copy customer/project/email/quote_id/project_id/business_name/currency from source
   - `amount = selected`, `paid_amount = 0`, `balance_due = selected`
   - `invoice_label = "Remaining Balance"`
   - `type = "PROGRESS"` (or `FINAL` if remaining equals full contract — optional; default PROGRESS)
   - `notes =` provided message (append machine-readable source marker — Section 11)
   - `status = "draft"`
   - New `public_token`, `invoice_no`
10. **Return** — `{ ok: true, invoice, remaining_balance, source_invoice_id }`

### Must NOT

- Call Zapier / send email
- Insert into `tenant_project_payments`
- PATCH source invoice
- Change quote totals or contract total anywhere
- Publish or set `sent_at`

---

## 11. Recommended duplicate prevention strategy

### Schema findings

- **`source_invoice_id`:** not persisted on invoice rows in current code
- **`invoice_label`:** supported, sanitized max 200 chars
- **`notes`:** free text, public-facing
- **`project_id` / `quote_id`:** optional UUIDs on invoice rows
- **`status`:** draft/sent/partial/overdue vs paid/void/archived

### V1 strategy (no schema changes)

Before insert, query tenant invoices matching **all**:

| Criterion | Value |
|-----------|--------|
| `tenant_id` | session tenant |
| `invoice_label` | `Remaining Balance` (exact, case-normalized) |
| `status` | `in.(draft,sent,partial,overdue)` — exclude paid/void/archived |
| Link scope | **(A)** same `quote_id` when present, **else (B)** same `project_id`, **else (C)** same `project_name` + `customer_email` |
| Source marker | `notes` contains `[source_invoice:<uuid>]` **or** exact amount match within 1¢ |

If match found → return `409` with `{ reason: "duplicate_remaining_balance_draft", existing_invoice_id }`; UI shows warning and blocks second create.

### Source marker in notes

Append on server (after client message):

```
[source_invoice:550e8400-e29b-41d4-a716-446655440000]
```

- Enables duplicate detection without migration
- Hidden from customer-facing display if trimmed in public template later (optional polish)
- Do **not** rely on notes alone without label + status filter

### Historical invoices

Paid/void/archived remaining-balance invoices do **not** block new drafts (owner may bill again after corrections).

---

## 12. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| **Duplicate draft invoice** | Server duplicate query (Section 11); disable confirm button while POST in flight |
| **Copying wrong amount** | Never use `duplicate-tenant-invoice`; server computes amount from ledger; manual capped at remaining |
| **Sending automatically** | New function inserts `status: draft` only; no call to `send-invoice-zapier` or `publish-public-invoice` |
| **Changing original invoice** | Insert-only path; no PATCH on source; no payment rollup |
| **Stale client-side remaining balance** | Server recalculates; modal shows server response errors if client preview drifted |
| **Contract total mismatch** | Server uses quote total from DB join; document fallback to invoice amount when no quote |
| **Ledger scope mismatch** | Mirror `hubLedgerTargetIds` priority in server payment sum |
| **Exposing pricing internals** | Do not use `create-manual-invoice`; notes = plain client message only |
| **Regression on Duplicate flow** | Do not modify `duplicate-tenant-invoice.js` |
| **Locked file violation** | Do not touch `create-manual-invoice.js` |

---

## 13. Final Step 17C recommendation

### Concise implementation plan

1. **Owner approves this Step 17B report.**
2. Add **`create-remaining-balance-invoice.js`** (Option B) with auth, balance math, duplicate guard, draft insert.
3. Add **review modal** HTML in `estimates-invoices.html` (clone duplicate/reminder modal patterns).
4. Wire **Actions menu item** + `dispatchHubDrawerAction` branch + modal lifecycle in `app.js`.
5. On success: refetch invoices, show feedback, optionally open new draft in drawer.
6. Production smoke per Step 17A (6163.10 / 4500 / 1663.10 example): +1 invoice, 0 payments, no email, duplicate blocked.
7. Document in `docs/STEP17C_…` verification file.

### Explicit gate

**Do not write Step 17C code until the owner approves this inspection report.**

---

## Appendix — Inspection verification checklist

- [x] Inspection/documentation only
- [x] No production code changed
- [x] No `estimates-invoices.html` changes
- [x] No `public/js/app.js` changes
- [x] No Netlify function changes
- [x] No Supabase/schema changes
- [x] No SQL executed
- [x] No DB writes or API calls added
- [x] No invoice/payment/email behavior changed
- [x] No pricing/quote behavior changed
- [x] No internal cost/margin exposed
