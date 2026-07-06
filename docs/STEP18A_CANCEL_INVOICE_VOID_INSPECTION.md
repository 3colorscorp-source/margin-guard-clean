# Margin Guard Step 18A — Cancel Invoice / Void Invoice Schema Inspection

## 1. Purpose

Step 18A is **inspection and documentation only**. No production code changes are made in this step.

**Goal:** Determine the safest fix path for **Cancel Invoice** after production showed a schema/code mismatch when voiding a DRAFT Remaining Balance invoice.

**Owner requirement:** Cancelled invoices must be **preserved as void/cancelled records**, not deleted. No payment, contract, or send side effects.

---

## 2. Production error

When the owner confirmed **Cancel invoice** on a DRAFT Remaining Balance invoice (Invoice Hub → Actions → Cancel invoice), the request failed with:

```
Supabase HTTP 400: Could not find the 'voided_at' column of 'invoices' in the schema cache | PGRST204
```

**Interpretation:** PostgREST/Supabase schema cache does not expose a `voided_at` column on `public.invoices`, but the cancel function attempted to PATCH that column.

---

## 3. Current UI behavior

| Step | Result |
|------|--------|
| Actions → **Cancel invoice** | Menu item enabled (when guards pass) |
| **Cancel invoice?** modal opens | **PASS** |
| Modal copy | *“This will mark the invoice as void. It will not delete the invoice, and it will not change any recorded payments…”* |
| Owner clicks **Cancel invoice** | **FAIL** — error above |
| Invoice deleted | **No** |
| Invoice status changed | **No** (PATCH failed) |
| Payment / send / email | **No side effects** |

This is a **schema/code mismatch**, not a payment or send workflow bug.

**Test context:** DRAFT **Remaining Balance** invoice created in Step 17C verification (Gonzalo & Isamar / Upstairs bath #2, amount 1663.10, no payments).

---

## 4. Current code findings

### UI entry points

| Location | Detail |
|----------|--------|
| `public/estimates-invoices.html` | `#hubCancelInvoiceModal` — title “Cancel invoice?”, void-not-delete subtitle |
| `public/js/app.js` | Actions menu item `cancel` → “Cancel invoice” in **Manage** section |
| `public/js/app.js` | `openHubCancelInvoiceModal`, `executeHubCancelInvoice`, `postHubInvoiceCancel` |
| `public/js/app.js` | `getHubOverflowMenuState` → `canCancelInvoice` |

### Client enablement (`canCancelInvoice`)

Server invoice + valid UUID + not archived + not void + not paid + `hasBalance` + `paidApplied <= 0.005`.

### Client → API call

```javascript
POST /.netlify/functions/cancel-tenant-invoice
Body: { invoice_id: "<uuid>" }
```

### Backend handler

**File:** `netlify/functions/cancel-tenant-invoice.js`

**Pre-void guards (server-side):**

| Guard | Reason code |
|-------|-------------|
| Not archived | `invoice_archived` |
| Not already void | `invoice_void` |
| Not paid status | `invoice_paid` |
| `paid_amount <= 0` | `invoice_has_payments` |
| `balance_due > 0` | `no_balance_due` |
| No Stripe session/intent ids | `invoice_stripe_payment` |
| No `tenant_project_payments` rows for invoice | `invoice_has_ledger_payments` |

**PATCH body (failure point):**

```javascript
{
  status: "void",
  voided_at: voidedAt,   // ← column missing in production
  updated_at: voidedAt
}
```

### Columns referenced in cancel flow

| Column | Used in cancel? | In production (per error)? |
|--------|-----------------|----------------------------|
| `status` | Yes → `"void"` | **Yes** (assumed; invoices work today) |
| `voided_at` | Yes → ISO timestamp | **No** — PGRST204 |
| `void_reason` | **No** | **No** (not in codebase) |
| `voided_by` | **No** | **No** (not in codebase) |
| `updated_at` | Yes | Likely yes |

### Related functions (not Cancel, for context)

| File | Behavior |
|------|----------|
| `netlify/functions/hub-invoice-archive-delete.js` | **Archive** → `status: archived`; **Delete** → hard DELETE (draft/sent only) — separate from Cancel |
| `netlify/functions/upsert-tenant-invoice-draft.js` | Allows `status: void` and lists `voided_at` in `UPSERT_KEYS` (client draft path) |
| `public/js/app.js` | `formatHubCancelInvoiceError` — maps known reasons; **falls through to raw `error` message** (exposes Supabase text today) |

### Display handling of void

- `hubRowIsVoidInvoice(row)` — checks `status === "void"`
- Hub list/drawer treat void invoices as terminal for several actions
- Public invoice (`get-public-invoice.js`) — no explicit void banner found in inspection; Step 18C should confirm void invoices are not presented as payable

---

## 5. Current schema assumptions (from repo, not live SQL writes)

### Base schema (`SUPABASE_INVOICES_SCHEMA.sql`)

- `status text default 'OPEN'`
- **No** `voided_at`, `void_reason`, or `voided_by`

### Hardening migration (`SUPABASE_INVOICES_MULTITENANT_HARDENING.sql`)

Defines (idempotent add):

```sql
alter table public.invoices
  add column if not exists voided_at timestamptz;
```

Also adds: `sent_at`, `paid_at`, `payment_status`, Stripe fields, `last_reminder_at`, etc.

**Production error indicates `voided_at` was never applied** (or schema cache not refreshed after apply). Code was written assuming hardening migration ran.

### Status values used in code

| Surface | Values |
|---------|--------|
| `cancel-tenant-invoice.js` | Sets **`void`** |
| `upsert-tenant-invoice-draft.js` | `draft`, `sent`, `partial`, `paid`, `overdue`, **`void`** |
| `list-tenant-invoices.js` | + `issued`, `archived`, `overdue` |
| UI | “void” displayed; modal says “mark as void” |

**Note:** Code uses **`void`**, not `cancelled` / `canceled`. No separate cancelled status in cancel function.

---

## 6. Recommended correct behavior

| Rule | Detail |
|------|--------|
| Cancel = soft void | **PATCH status**, never DELETE |
| Preserve row | Invoice remains in hub/history |
| Block if payments | `paid_amount > 0` or ledger rows or Stripe trace |
| Block if already void/archived/paid | Existing guards |
| No ledger mutation | Do not touch `tenant_project_payments` |
| No contract/quote mutation | Read-only on quote/project totals |
| No email/send | Cancel function does not call send/publish |
| Audit metadata | Set `voided_at` **when column exists**; optional future `void_reason` / `voided_by` |

---

## 7. Fix options

### Option A — Code-only fix (no schema change)

**Change:** `cancel-tenant-invoice.js` PATCH only:

```javascript
{ status: "void", updated_at: voidedAt }
```

Remove `voided_at` from PATCH until column exists. Optionally try `voided_at` with catch/fallback (fragile).

| Pros | Cons |
|------|------|
| Works immediately on current production schema | No void timestamp in DB |
| No Supabase migration approval | Weaker audit trail |
| Minimal blast radius | Diverges from `upsert-tenant-invoice-draft` UPSERT_KEYS |

### Option B — Schema + code alignment (recommended long-term)

**Change:**

1. Apply nullable **`voided_at timestamptz`** to production `invoices` (migration draft in Step 18B).
2. Keep cancel PATCH: `status: void`, `voided_at`, `updated_at`.
3. Optionally add nullable **`void_reason text`**, **`voided_by uuid`** in a later migration (not required for V1 fix).

| Pros | Cons |
|------|------|
| Matches existing code intent | Requires owner-approved SQL apply |
| Clean audit trail | Must verify PostgREST schema cache refresh |
| Aligns with `SUPABASE_INVOICES_MULTITENANT_HARDENING.sql` | Slightly longer rollout |

### Recommendation

**Option B long-term**, with **Option A as immediate hotfix** if cancel must work before migration is approved.

**Pragmatic sequence:**

1. **Step 18B** — SQL migration draft (nullable `voided_at` only, or targeted excerpt from hardening file).
2. **Step 18C** — After migration apply: verify cancel works; add owner-safe error sanitization in function + `formatHubCancelInvoiceError` so PGRST204 never reaches UI.
3. If urgent: **18C-hotfix** code-only (Option A) can ship before 18B, then re-enable `voided_at` write after migration.

---

## 8. Recommended Step 18B

**Deliverable:** SQL migration draft only — **do not apply until owner approval**.

Suggested minimal migration:

```sql
-- STEP18B: nullable void audit column for cancel invoice
alter table public.invoices
  add column if not exists voided_at timestamptz;

comment on column public.invoices.voided_at is
  'When the invoice was voided/cancelled by owner action. Null if never voided.';
```

**Rules:**

- Nullable, non-destructive
- No UPDATE of existing rows
- No NOT NULL constraints
- Owner runs in Supabase SQL editor or approved pipeline
- After apply: confirm PostgREST schema reload (PGRST204 cleared)

Optional follow-up (not required for V1):

```sql
alter table public.invoices add column if not exists void_reason text;
alter table public.invoices add column if not exists voided_by uuid;
```

---

## 9. Recommended Step 18C

**After Step 18B approval (or with Option A hotfix):**

| Item | Scope |
|------|--------|
| `netlify/functions/cancel-tenant-invoice.js` | Align PATCH with live schema; sanitize errors (no raw Supabase text) |
| `public/js/app.js` | `formatHubCancelInvoiceError` — map generic failures; never show PGRST204 |
| `public/estimates-invoices.html` | No change expected unless copy tweak |
| Public invoice | Display-only check: void invoices show non-payable state (if gap found) |

**Step 18C must:**

- Owner/admin session + tenant scope (already present)
- Block cancel when payments exist (already present)
- Set `status: void` (+ `voided_at` when column exists)
- **Never DELETE**
- Never mutate ledger, contract total, or send email

**Step 18C must not:**

- Delete invoices on cancel
- Create payments or new invoices
- Auto-send or publish

---

## 10. Test plan

### Happy path (DRAFT, no payments)

1. Open Invoice Hub → select DRAFT invoice (e.g. Remaining Balance 1663.10, no payments).
2. Actions → **Cancel invoice** → confirm modal → **Cancel invoice**.
3. Confirm success feedback.
4. Confirm invoice **still visible** with status **void**.
5. Confirm `invoices_count` **unchanged** (62 → 62).
6. Confirm `payments_count` **unchanged** (0).
7. Confirm no email sent.

### Guard paths

| Case | Expected |
|------|----------|
| Invoice with ledger payment | Block — `invoice_has_ledger_payments` |
| Paid invoice | Block — `invoice_paid` |
| Already void | Block — `invoice_void` |
| Stripe checkout on row | Block — `invoice_stripe_payment` |

### Public invoice (if token exists)

- Void invoice public page should not present as actively payable (verify in 18C).

---

## Safety confirmations (Step 18A)

| Rule | Status |
|------|--------|
| Inspection/documentation only | Yes |
| No production code changed | Yes |
| No Netlify function changes | Yes |
| No Supabase/schema changes in this step | Yes |
| No SQL executed | Yes |
| No DB writes | Yes |

---

## Rollback note

Step 18A creates documentation only. No rollback required.

Future Step 18B migration rollback: `alter table public.invoices drop column if exists voided_at;` only if no production dependency (avoid after voids recorded).

---

## Files inspected

| File | Relevance |
|------|-----------|
| `public/estimates-invoices.html` | Cancel modal UI |
| `public/js/app.js` | Actions menu, cancel modal wiring, error formatting |
| `netlify/functions/cancel-tenant-invoice.js` | **Primary failure** — writes `voided_at` |
| `netlify/functions/hub-invoice-archive-delete.js` | Archive vs delete (separate) |
| `netlify/functions/upsert-tenant-invoice-draft.js` | `void` status + `voided_at` in UPSERT_KEYS |
| `SUPABASE_INVOICES_SCHEMA.sql` | Base table — no `voided_at` |
| `SUPABASE_INVOICES_MULTITENANT_HARDENING.sql` | Defines `voided_at` — may be unapplied in production |
