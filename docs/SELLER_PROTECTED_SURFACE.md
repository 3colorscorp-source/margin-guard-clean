# Seller protected surface (V1)

Seller is a **protected area**. Future work on other modals or features must not accidentally edit or regress it.

This is a guardrail. It does not change Seller UI, pricing, send, calendar, or voice behavior.

## Rule

Non-Seller work must **not** edit protected Seller files or Seller code regions in shared files.

A change is allowed only when the task, branch, or PR is **explicitly Seller**.

## When Seller work is allowed

Treat the work as explicitly Seller if **any** of these is true:

1. Branch name contains `seller`
2. Branch name contains `voice-plan`
3. Branch name contains `seller-shield`
4. `ALLOW_SELLER_TOUCH=1`
5. PR title contains `[Seller]`

Otherwise, touching the protected surface **fails**:

> Seller protected surface changed outside Seller scope. Stop and move this to a Seller PR.

## Any Seller touch requires the shield

If protected files or Seller regions in shared files change under Seller scope, run:

```bash
node scripts/test-mg-seller-shield-v1.js
```

Optional Hub-adjacent RLS suite:

```bash
node scripts/test-mg-seller-shield-v1.js --full
```

Before that, you can check scope with:

```bash
node scripts/guard-seller-scope.js
```

Default comparison is `origin/main`. Override with `BASE_REF`.

## Do not change these unless the task is specifically about that area

- Tenant rates / `hoursPerDay`
- Publish and send
- Calendar reservation
- Voice confirm-and-apply
- Device auth
- Estimate Zapier payload

The estimate Zapier webhook is an **unsigned JSON POST**. Do not copy HMAC guarantees from contracts or Invoice Hub onto this flow.

## What V1 does not do

- It does not deploy, mutate production data, send email, or run SQL.
- It does not freeze CSS or copy.
- Known gaps are printed by the runner and do not fail the gate:
  - `get-seller-business-settings`
  - Pairing UI
  - quote-number collision
- There is no GitHub workflow and no `package.json` script wiring.

See `MARGIN_GUARD_SELLER_PORTAL_SUMMARY.md` for the suite list and how to add a future suite.
