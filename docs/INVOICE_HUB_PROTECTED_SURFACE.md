# Invoice Hub protected surface (V1)

Invoice Hub is a **protected area**. Future work on other modals or features must not accidentally edit or regress it.

This is a guardrail. It does not change Invoice Hub UI, business logic, amounts, payments, or public/PDF behavior.

## Rule

Non-Invoice-Hub work must **not** edit protected Invoice Hub files or Invoice Hub code regions in shared files.

A change is allowed only when the task, branch, or PR is **explicitly Invoice Hub**.

## When Invoice Hub work is allowed

Treat the work as explicitly Invoice Hub if **any** of these is true:

1. Branch name contains `invoice-hub`
2. Branch name contains `invoices`
3. `ALLOW_INVOICE_HUB_TOUCH=1`
4. PR title contains `[Invoice Hub]` (when a PR title is available)

Otherwise, touching the protected surface **fails**:

> Invoice Hub protected surface changed outside Invoice Hub scope. Stop and move this to an Invoice Hub PR.

## Any Invoice Hub touch requires regression tests

If protected files or Hub regions in `public/js/app.js` change under Invoice Hub scope, run:

```bash
node scripts/test-invoice-hub-regression-suite.js
```

Before that, you can check scope with:

```bash
node scripts/guard-invoice-hub-scope.js
```

Default comparison is `origin/main`. Override with `BASE_REF`.

## Do not change these unless the task is specifically about that area

- Invoice amounts
- Payment math
- Ledger behavior
- Public / PDF totals
- Zapier payloads
- Auth
- Tenant scoping

## Protected files

See `scripts/invoice-hub-protected-surface.json` for the machine-readable list.

Includes:

- `public/estimates-invoices.html`
- `public/invoice-public.html`
- Invoice Hub owner Netlify functions (create/list/send/cancel/record payment, hub actions, public publish/get, quote edit)
- `scripts/test-*invoice*.js` and `scripts/test-*hub*.js`
- Shield files dedicated to this protection (`docs/INVOICE_HUB_*`, `scripts/invoice-hub-*`, `scripts/guard-invoice-hub-scope.js`)

## Shared file: `public/js/app.js`

`app.js` is shared. V1 does **not** block every `app.js` change.

If `public/js/app.js` changes, the guard scans the **diff**. It fails (unless Invoice Hub scope) only when changed lines match Invoice Hub markers such as `hub`-prefixed identifiers, Invoice Hub copy, tenant invoice endpoints, record payment, project billing, remaining balance, material cost, public invoice, payment history, reminders, duplicate/archive/cancel invoice.

If the scan is uncertain, V1 **fails safe** and requires Invoice Hub scope.

## What V1 does not do

- It does not deploy, mutate production data, send email, or run SQL.
- It does not rewrite Invoice Hub code.
- There is no GitHub workflow in this repo yet (no `.github/workflows`).
- There is no `package.json` script wiring in this repo yet.
- Pattern matching on `app.js` is not an AST. Prefer an Invoice Hub PR when unsure.
