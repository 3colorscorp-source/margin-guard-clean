# MG-SALES-READY-006B-B — controlled release (code present, production off)

Automatic Square SaaS activation is **in the repo** and **fail-closed**.

Do not enable until all of the following are done **outside Cursor**:

1. Review and apply `SUPABASE_MG_SALES_READY_006B_SAAS_SQUARE_ONBOARDING.sql`
2. Set Netlify Square env names (values never committed)
3. Create the Square Dashboard webhook subscription to  
   `https://marginguardsystem.netlify.app/.netlify/functions/square-saas-webhook`
4. Pass production smoke tests against sandbox only if `SQUARE_SAAS_ALLOW_SANDBOX=true` is intentional
5. Set `SQUARE_SAAS_AUTO_ACTIVATION_ENABLED=true`

Until step 5, the activation library will not change tenants.plan_status.

## Owner invite (v1)

The webhook does not send a Supabase Auth invite. Activation and invitation are separate so retries cannot duplicate invites.

Keep 006A owner/profile/invite preparation. The owner cannot use SaaS while `plan_status` is `pending`. After activation, send the invite (or complete password setup) as a human admin step.

## Register

`POST /.netlify/functions/register-saas-square-invoice`  
Platform admin cookie only. Body: `tenant_id`, `square_invoice_id`, `terms_confirmed: true`.

## Status

`GET /.netlify/functions/get-saas-onboarding-status?tenant_id=`  
Platform admin, read-only, no secrets.

## Dry-run (read-only)

`POST /.netlify/functions/admin-saas-square-dry-run`  
Platform admin cookie only. Does not write `tenants`, `saas_onboarding`, or `plan_status`.

Body: `{ "tenant_id": "<uuid>" }` or `{ "onboarding_id": "<uuid>" }`.

```bash
curl -sS -X POST "https://marginguardsystem.netlify.app/.netlify/functions/admin-saas-square-dry-run" \
  -H "Content-Type: application/json" \
  -H "Cookie: mg_session=<platform-admin-session>" \
  -d "{\"tenant_id\":\"8133cef9-29fc-4d08-9add-9768c0bced89\"}"
```

Expected unpaid decision while the test invoice is UNPAID: `registered_unpaid_no_action`.
A PAID invoice with `SQUARE_SAAS_AUTO_ACTIVATION_ENABLED` unset/false returns `paid_but_activation_disabled` and still does not activate.
