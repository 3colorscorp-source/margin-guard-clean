# MG-SALES-READY-006A — first-customer runbook

Manual annual SaaS: **USD $2,000**. Payment is collected outside Margin Guard through **QuickBooks** or **Square**. Stripe is not the SaaS billing authority.

**Invariant:** only `public.tenants.plan_status = 'active'` receives owner SaaS access. Every other value fails closed (login, recovery, Netlify owner APIs, device portals).

**Activation authority:** platform admin in the Supabase SQL editor (or Table Editor). There is no browser, email-only, tenant self-serve, or Stripe Checkout path that can set `plan_status`.

**Do not store card or bank payment credentials in Margin Guard.** Keep the QuickBooks or Square invoice id in this runbook / email thread. No new billing tables for the first 1–5 customers.

After `SUPABASE_MG_SALES_READY_006A_SAFE_TENANT_ACTIVATION.sql` is applied, a new tenant row with no `plan_status` supplied defaults to **`pending`**, not `active`. Existing tenants (including Three Colors) are not updated by that migration.

---

## Decision: create the tenant only after payment is confirmed

For the first 1–5 customers, do **not** create a live tenant before money is confirmed.

1. Invoice and collect payment first.
2. Collect written Terms / Privacy acceptance.
3. Then create the tenant as `pending`, attach the owner, invite Auth, and **only then** set `plan_status = 'active'`.

Creating the row as `pending` before the activation UPDATE is the safety net if any later step is delayed. Do not set `active` in the same INSERT as the tenant create.

No self-service signup.

---

## Q. Exact checklist to onboard the first paying customer

Replace bracketed values. Do not paste production owner emails, tenant ids, or secrets into chat logs.

### Shared steps (QuickBooks and Square)

1. Prospect agrees to the **USD $2,000** annual Margin Guard plan.
2. Send the invoice (method-specific steps below).
3. Customer accepts [Terms](/terms.html) and acknowledges [Privacy](/privacy.html) **in writing** (email is enough). Keep that message with the invoice.
4. **Wait until payment is CONFIRMED** in QuickBooks or Square. Do not activate on “invoice sent” or “customer said they paid.”
5. Create the tenant in Supabase (`pending` by default — do not supply `plan_status`):

   ```sql
   INSERT INTO public.tenants (slug, name, owner_email)
   VALUES ('customer-slug', 'Customer Legal Name', 'owner@customer.example');
   ```

6. Create the owner profile on that tenant (`role = 'owner'`, `status = 'active'`). Associate `tenant_id` and the owner email. Do not grant `public.users.is_admin`.
7. Invite / create the owner through **Supabase Auth** with **verified email** (invite or magic link / password recovery as you already use for owners). They cannot obtain a working `mg_session` while the tenant is `pending`.
8. **Activate only after steps 4–7:**

   ```sql
   UPDATE public.tenants
   SET plan_status = 'active'
   WHERE slug = 'customer-slug'
     AND plan_status IS DISTINCT FROM 'active';
   ```

   Confirm exactly one row updated. This is the SaaS access grant.
9. Owner establishes their password (Supabase recovery / invite completion).
10. Owner logs in at `/index.html` (password → `restore-owner-session` with verified JWT). Confirm dashboard loads.
11. Verify tenant isolation: owner sees only this tenant’s quotes / invoices / projects. They must not see Three Colors data.
12. Optional: Connect Bank through Financial Connections (read-only balances). This is **not** SaaS billing and does not replace QuickBooks/Square payment.
13. Verify Ask Margin Guard, Invoice Hub, and Dashboard for this owner only.

### G. QuickBooks first-customer flow

- Create a QuickBooks invoice for **USD $2,000** (annual Margin Guard SaaS).
- Send it to the buyer. Record the QuickBooks invoice number in the same email thread as Terms acceptance.
- When QuickBooks shows the payment as received/cleared, treat that as CONFIRMED.
- Then run shared steps 5–13. Margin Guard does not import QuickBooks; the invoice number is the external payment evidence.

### H. Square first-customer flow

- Create a Square invoice or payment request for **USD $2,000** (annual Margin Guard SaaS).
- Send it to the buyer. Record the Square invoice / payment id in the same email thread as Terms acceptance.
- When Square shows the payment as completed, treat that as CONFIRMED.
- Then run shared steps 5–13. Margin Guard does not import Square SaaS charges; the Square id is the external payment evidence.

---

## I. Cancellation / expiration (manual annual lifecycle)

Keep the calendar/reminder outside Margin Guard (invoice due date + 1 year).

| Event | Admin action | Result |
| --- | --- | --- |
| Payment confirmed | `plan_status = 'active'` | Owner SaaS allowed |
| Not renewed / expired | `plan_status = 'expired'` (or `pending`) | New owner sessions blocked; existing APIs fail closed |
| Canceled | `plan_status = 'canceled'` | Access blocked |

Example:

```sql
UPDATE public.tenants
SET plan_status = 'canceled'   -- or 'expired'
WHERE slug = 'customer-slug';
```

Do not delete the tenant unless you intend to destroy isolation data. Deactivation is a status change, not a Stripe event.

---

## J. Existing-session revocation

`mg_session` cookies last up to 30 days, but **every** owner Netlify tenant resolve re-reads `plan_status` and requires `active`. Device portals do the same. `auth-status` also clears the cookie when the plan is not active.

After you set a non-active status, the owner cannot mint a new session, cannot keep using owner APIs with the old cookie, and UI pages that call `auth-status` send them back to login.

Platform `public.users.is_admin` can still pass `auth-status` without an active plan. That is a **platform-admin** exception, not customer self-activation. Do not grant `is_admin` to paying customers.

---

## Payment record (no new columns)

Do **not** add `subscription_source`, `subscription_started_at`, `subscription_expires_at`, or `external_invoice_reference` for the first 1–5 customers. Store the QuickBooks or Square invoice id in the admin email/runbook copy of this checklist.
