# MG-SALES-READY-006B-A — Square automatic paid activation (design only)

Status: **design ready. Production activation is NOT implemented and MUST remain off.**

Annual SaaS: **USD $2,000** = **200000 cents**, currency **USD**. Stripe is not SaaS billing. QuickBooks stays manual.

Invariant already in production: only `plan_status === "active"` receives owner SaaS access. New tenants default to `pending`. Owner APIs, `auth-status`, and device portals re-check `planIsActive`.

This document does not authorize enabling the webhook in Netlify/Square until a later implementation task lands behind tests.

---

## 1. Inventory (current repo / origin/main)

### A. Current production code (not SaaS entitlement)

| Path | Role |
| --- | --- |
| `public/terms.html` | States manual QuickBooks/Square billing; access after confirmed payment |
| `public/index.html` | Login copy: manual billing confirmed by Margin Guard |
| `public/success.html` | Copy that annual subscription is confirmed internally after QuickBooks/Square |
| `public/js/app.js` | Project **migration baseline** `external_source` defaults to `"Square"` (job tracking, not SaaS) |
| `public/project-control.html` | Supervisor Square-in-progress template for migrated jobs |
| `public/business-settings.html` | Hint: external link only (bank, QuickBooks, Square) |
| `public/estimates-invoices.html` | CSS comment “Square-inspired” layout only |
| `netlify/functions/_lib/migration-baseline.js` | Default `external_source: "Square"` for project baselines |
| `netlify/functions/create-checkout-session.js` | Comment only; handler returns 403 `subscription_checkout_disabled` |
| `docs/MG_SALES_READY_006A_FIRST_CUSTOMER_RUNBOOK.md` | Manual Square invoice → admin sets `plan_status = active` |
| `SUPABASE_TENANT_PROJECT_MIGRATION_BASELINES.sql` | Project baseline table, default source Square |
| `SUPABASE_TENANT_PROJECT_PAYMENTS.sql` | Tenant **project** payment ledger; `payment_method` has `stripe`/`other`, not SaaS |
| `netlify/functions/stripe-invoice-webhook.js` | Stripe signature for **tenant project invoices**, not SaaS `plan_status` |
| `netlify/functions/record-tenant-payment.js` | Project invoice payments |

### B. Legacy / dead

- `docs/STEP17A_PROJECT_ACTIONS_REMAINING_BALANCE_INVOICE_PLAN.md` lists “Touch Stripe/Square payment flows” as something **not** to do in that plan.
- No `netlify/functions/*square*` files exist.

### C. Database artifact only

`public.square_webhook_events` is listed in `SUPABASE_MG_SALES_READY_004A_PUBLIC_SURFACE_HARDENING.sql` (RLS + revoke anon/authenticated, grant `service_role`). **There is no `CREATE TABLE` for it in this repo.** No Netlify function reads or writes it. Treat it as an unknown leftover production table. Do **not** reuse it for SaaS activation.

### D. Env / config only

**No `SQUARE_*` environment variables exist** in Netlify functions, `netlify.toml`, or tests. HMAC/signature code in-repo is Zapier/Support/Stripe — not Square.

### E. No implementation exists

- Square webhook endpoint
- Square signature verification (`x-square-hmacsha256-signature`)
- Square Invoices/Payments API client
- Server-side invoice → tenant registration
- Automatic `pending → active`
- SaaS billing/onboarding table

---

## 2. `square_webhook_events` — cannot be the SaaS ledger

Repo cannot state exact columns/indexes: they are not in git. Production existence is proven only as a 004A hardening target.

It is **unsuitable** as the activation authority because:

- schema is unknown in source control
- no application contract (event_id uniqueness, tenant_id, processing status)
- leftover POS/webhook experiments must not mix with SaaS entitlement

**Replacement (smallest safe):** two new `service_role`-only tables (see §7). Leave `square_webhook_events` untouched.

---

## 3. Payment-to-tenant correlation (critical)

A webhook must **never** choose a tenant from browser `tenant_id`, notes, email, slug, or unregistered metadata.

### Recommended for first 1–5 customers: **Option B + register-time Square GET**

Platform admin registers an already-created Square **invoice id** against a **pending** tenant **before** (or, if already paid, immediately after) the customer pays.

Why not Option A first:

- Option A (server creates the Square invoice) is the long-term better lock, but it requires Invoices write, location, Square Customer create, publish, and more failure modes.
- First 1–5 already create invoices in the Square Dashboard (006A runbook). Option B matches that process with one extra **server-side bind**.

Why Option B is still safe:

1. Admin supplies `tenant_id` + `square_invoice_id` to a **platform-admin** endpoint (or SQL in v0, endpoint in v1).
2. Server `GET /v2/invoices/{id}` with the production access token.
3. Server rejects unless amount is 200000 cents, currency USD, invoice belongs to the configured merchant/environment, and tenant is `pending`.
4. Persist the bind **before** treating the invoice as activation-eligible.
5. Webhook looks up **only** by that registered `square_invoice_id`.

Do not discover tenants by email at webhook time.

If the invoice is already `PAID` at registration, run the **same** activation function used by the webhook (Square GET + CAS). Do not activate from the admin request body.

---

## 4. Invoice creation strategy

**v1 (1–5 customers):** create the USD $2,000 invoice in Square Dashboard (or Square Invoices UI). Put Terms/Privacy links in the invoice body (see §8). Then register the invoice id against the pending tenant.

**Later:** Option A — Netlify creates/publishes the Square invoice after registration, storing `square_invoice_id` from Square’s response (no human copy-paste).

---

## 5. Webhook endpoint

`POST /.netlify/functions/square-saas-webhook`

Public URL (must match Square subscription **byte-for-byte**):

`https://marginguardsystem.netlify.app/.netlify/functions/square-saas-webhook`

Behavior:

1. POST only. No cookies. No browser CORS need.
2. Preserve **raw** body (`event.body`, decode base64 if `isBase64Encoded`). Same pattern as `stripe-invoice-webhook.js` `getRawBody`.
3. Verify `x-square-hmacsha256-signature` **before** `JSON.parse`.
4. Reject missing/invalid signature (`401`).
5. Parse JSON only after verify.
6. Require `event_id` and `type`.
7. Insert `event_id` into `saas_square_webhook_events` (unique). Duplicate → idempotent `200`.
8. Known types: activate candidate `invoice.payment_made`; flag-only `invoice.refunded`, `refund.created`, `payment.updated` (refund/dispute never activate).
9. Unknown type → `ignored`, `200`.
10. Sandbox/`square-environment` not matching `SQUARE_ENVIRONMENT=production` → `ignored` unless `SQUARE_SAAS_ALLOW_SANDBOX=true` (must default false).
11. Never trust payload amount/customer/tenant. Extract invoice id from `data.id` only as a **hint**, then `GET` Square.
12. Return `500` if verification succeeded but durable activation/ignore did not commit (Square retry). Return `200` only when the event row is `activated`, `ignored`, or duplicate.

Zapier is **not** in this chain.

---

## 6. Signature verification

Square HMAC-SHA256 over **`notificationUrl + rawBody`**, key = webhook subscription signature key (verbatim, not pre-decoded), digest **base64**, header `x-square-hmacsha256-signature`. Compare with `crypto.timingSafeEqual`.

`SQUARE_WEBHOOK_NOTIFICATION_URL` must equal the Developer Console notification URL exactly (scheme, host, path, no extra slash).

Do not use legacy `x-square-signature` (SHA1). Do not put the signature key in the browser.

Access token is used only for server `GET` Invoice / Payment. Never returned to the client.

---

## 7. Authoritative payment verification (before CAS)

After signature + event_id insert, server must prove via Square APIs (production host when `SQUARE_ENVIRONMENT=production`):

- Invoice exists: `GET https://connect.squareup.com/v2/invoices/{registered_invoice_id}`
- Invoice id **equals** the registered row (not a payload-only id that failed lookup)
- `invoice.status === "PAID"` (not `CANCELED`, `FAILED`, `UNPAID`, `PARTIALLY_PAID`, `PAYMENT_PENDING`)
- Primary payment request `computed_amount_money.amount === 200000` and `currency === "USD"` (also require `total_completed_amount_money.amount === 200000`)
- Tenant onboarding row exists, `status` in (`registered`, `paid_verified`), tenant `plan_status = pending` (or already active from **this** payment)
- Payment id (from invoice/order tenders via `GET /v2/payments/{id}` if present) is not bound to another tenant

Do not activate from webhook `data.object` money fields.

---

## 8. Idempotent activation (fail-closed)

Single function `activateTenantFromVerifiedSquareInvoice({ tenantId, invoiceId, paymentId })`:

```sql
UPDATE public.tenants
SET plan_status = 'active', updated_at = now()
WHERE id = $tenant_id
  AND lower(trim(plan_status)) = 'pending'
RETURNING id;
```

| Result | Action |
| --- | --- |
| 1 row updated | Set onboarding `activated`, `activated_at`, `term_start_at`, `term_expires_at = term_start_at + 1 year`, store payment id |
| 0 rows, tenant already `active`, same `square_invoice_id` / `square_payment_id` | Idempotent success |
| 0 rows, tenant `active`, **different** payment/invoice | Do **not** overwrite audit; mark event `failed` / `ignored`; notify admin |
| Tenant `canceled` / `expired` | Do **not** auto-reactivate; `ignored` |
| Webhook retry | Unique `event_id` + unique `(provider, square_invoice_id)` prevent duplicate subscriptions/invites |

v1 webhook **does not send Auth invites** (retries would duplicate). Invite after activation is an admin step.

---

## 9. Minimal billing schema (proposed, not applied)

Do **not** use `tenant_project_payments` or `invoices` (those are tenant-to-customer project bills). Do **not** add card/CVV/bank credentials.

### `public.saas_onboarding`

- `id uuid PK`
- `tenant_id uuid NOT NULL REFERENCES public.tenants(id)` UNIQUE for v1 (one Square annual bind)
- `provider text NOT NULL CHECK (provider = 'square')`
- `external_invoice_id text NOT NULL` (Square invoice id)
- `external_payment_id text NULL`
- `square_customer_id text NULL` (audit only; not a correlation key)
- `expected_amount_cents integer NOT NULL DEFAULT 200000 CHECK (expected_amount_cents = 200000)`
- `currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD')`
- `status text NOT NULL` (`registered`, `paid_verified`, `activated`, `ignored`, `failed`)
- `terms_accepted_at timestamptz NULL`
- `registered_at timestamptz NOT NULL DEFAULT now()`
- `paid_at timestamptz NULL`
- `activated_at timestamptz NULL`
- `term_start_at timestamptz NULL`
- `term_expires_at timestamptz NULL`
- `last_error text NULL`
- UNIQUE (`provider`, `external_invoice_id`)
- UNIQUE (`provider`, `external_payment_id`) WHERE `external_payment_id IS NOT NULL`

RLS on; revoke `anon`/`authenticated`; `GRANT` DML to `service_role` only.

### `public.saas_square_webhook_events`

- `event_id text PRIMARY KEY` (Square `event_id`)
- `event_type text NOT NULL`
- `processing_status text NOT NULL` (`received`, `verified`, `processing`, `activated`, `ignored`, `failed`)
- `received_at timestamptz NOT NULL DEFAULT now()`
- `processed_at timestamptz NULL`
- `external_invoice_id text NULL`
- `external_payment_id text NULL`
- `tenant_id uuid NULL`
- `error_code text NULL`

No card data. Raw webhook body optional and **not** required for v1 (avoid storing PAN if Square ever included it; store type/ids only).

---

## 10. Terms acceptance

Not a legal guarantee. Practical first-customer rule:

**Both:**

- **A.** Square invoice title/body states that payment constitutes agreement to Margin Guard Terms of Service and acknowledgment of the Privacy Policy, with `https://marginguardsystem.netlify.app/terms.html` and `.../privacy.html`.
- **B.** Platform admin sets `terms_accepted_at` on the onboarding row (written email or invoice-language acknowledgment recorded) **before** the row is activation-eligible.

Webhook refuses activation if `terms_accepted_at` is null. Login page acknowledgment remains; it is not the activation authority.

---

## 11. Owner invite timing

**Recommend B: send Supabase Auth invite only after `plan_status = active`.**

Invite-before-payment is technically fail-closed (pending cannot mint `mg_session` or call owner APIs), but the customer hits a dead login and may think the product is broken. Invite-after avoids that and prevents webhook retries from sending duplicate invites if someone later automates mail.

No email-only `restore-owner-session`.

---

## 12. Refunds / disputes (v1)

- `invoice.refunded` / `refund.created` / `payment.updated` with refunded state: **never** create or reactivate access.
- Persist event as `ignored` or `failed` with `error_code = refund_or_dispute`.
- Notify platform admin (existing Support email path or a single admin email env). Do not auto-deactivate or delete tenant data in 006B.

---

## 13. Failure + retry

| Status | Meaning |
| --- | --- |
| received | Unique `event_id` inserted |
| verified | Signature + JSON + type OK |
| processing | Square GET in flight / CAS |
| activated | Tenant CAS succeeded or idempotent same payment |
| ignored | Sandbox, unknown type, canceled tenant, refund |
| failed | Unexpected; HTTP 500 so Square retries |

No internal infinite retry loop. Square’s delivery retries are the retry. After N durable `failed` with non-retryable reason (wrong amount), mark `ignored` and `200` so Square stops.

---

## 14. Trusted chain (no Zapier authority)

Square → signed Netlify webhook → Square GET Invoice/Payment → Supabase `service_role` CAS → `plan_status = active`.

Zapier may later send “you’re paid” email. It must not write `plan_status`.

---

## 15. Security invariants this design preserves

- `tenant_id` from registered onboarding row, not the browser
- No browser `plan_status` write
- No tenant self-activation
- Stripe Checkout remains 403; Stripe invoice webhook must not gain SaaS activation
- 004A/004B/004C files unchanged
- 006A pending default unchanged
- `planIsActive` fail-closed unchanged
- DB mutation `service_role` only
- Square secrets server-only (`SQUARE_ACCESS_TOKEN`, `SQUARE_WEBHOOK_SIGNATURE_KEY`)

---

## 16. Implementation package (later task — do not build now)

1. **DB:** `SUPABASE_MG_SALES_READY_006B_SAAS_SQUARE_ONBOARDING.sql` (+ rollback). Create `saas_onboarding` and `saas_square_webhook_events` only. No `UPDATE` of existing tenants. Do not alter `square_webhook_events`.
2. **New functions:** `square-saas-webhook.js`, `_lib/square-webhook-signature.js`, `_lib/square-saas-api.js`, `_lib/saas-square-activate.js`, `register-saas-square-invoice.js` (platform admin).
3. **Existing functions changed:** none required. Do not modify 004A/B/C SQL, FC, Stripe SaaS-disabled checkout, or `planIsActive`.
4. **Square Dashboard:** production app; webhook subscription to the exact Netlify URL; events `invoice.payment_made`, `invoice.refunded`, `refund.created`; optional `payment.updated` for flags only; signature key + access token with **INVOICES_READ** and **PAYMENTS_READ** (no write for Option B).
5. **Env names:** `SQUARE_ACCESS_TOKEN`, `SQUARE_ENVIRONMENT`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`, `SQUARE_SAAS_EXPECTED_AMOUNT_CENTS`, `SQUARE_SAAS_CURRENCY`, `SQUARE_SAAS_ALLOW_SANDBOX` (default unset/false). Optional `SQUARE_MERCHANT_ID` to reject foreign merchant_id. Optional `SQUARE_LOCATION_ID` only when Option A is added.
6. **Admin:** platform-admin Netlify register endpoint; no customer UI.
7. **Event types:** `invoice.payment_made` (activate path); `invoice.refunded`, `refund.created` (never activate).
8. **Tests:** signature reject; JSON after verify; amount/currency; pending CAS; idempotent same payment; different payment on active tenant; canceled tenant; sandbox ignored; browser cannot register; Zapier cannot activate; Stripe checkout still 403; 004A/B/C intact.
9. **Rollback:** drop new tables (if empty) or leave them; remove webhook subscription; delete Square env vars; functions return 404 if removed. Never bulk-deactivate Three Colors.

---

## 17. Recommendation

**GO** for a later 006B implementation of Option B + signed webhook + Square GET + CAS.

**NO-GO** for turning the webhook on before that package, tests, and env are live.

Until then, first customers stay on the 006A manual checklist.
