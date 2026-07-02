# AI Closer Step 11D — Client Submit Guard

## Purpose

Prevent duplicate AI Closer prequote submissions from the client flow. A single user action should create only one prequote.

## Problem found in Step 11B

During the Step 11B fresh happy-path test, a double client submit created **two matching prequotes** for the same project and contact details. The likely cause was rapid double-click or repeated submit before the first request finished.

## What changed

Client UI/JS only (`public/ai-closer-client.html`, `public/js/ai-closer-client.js`):

1. **In-flight submit guard** — module-level `isSubmittingPrequote` blocks overlapping submits.
2. **Submit button UX** — `#aclContactSubmit` disables immediately, shows `Submitting...`, then `Submitted` on success; re-enables on failure.
3. **Session fingerprint cooldown** — `sessionStorage` stores a normalized fingerprint of public client fields for 10 minutes after a successful submit.
4. **Success messaging** — visible success copy: `Pre-quote submitted. The owner can review it now.`
5. **Post-success lock** — send/zoom entry buttons disable after a successful submit.

No backend, Netlify function, Supabase/schema, or API endpoint changes.

## In-flight guard behavior

- `isSubmittingPrequote` is set `true` immediately before the existing `POST` to `/.netlify/functions/ai-closer-submit-prequote`.
- If submit is already in flight, additional clicks are ignored.
- The contact submit button is disabled during the request.
- On **failure**: `isSubmittingPrequote` clears, the button re-enables, and a safe error message is shown. No auto-retry.
- On **success**: `isSubmittingPrequote` clears, but `prequoteSubmitted` stays `true` and the button remains disabled with label `Submitted`.

## Session duplicate fingerprint behavior

Fingerprint fields (normalized with trim / lowercase where appropriate):

- Tenant slug (URL query)
- Project name
- Client email
- Work type (service name)
- Scope size
- Budget min / max
- Phone

Stored in `sessionStorage` with timestamp after a **successful** submit only.

If the same fingerprint is submitted again within **10 minutes**, the client blocks the request and shows:

> This pre-quote was already submitted. Please wait or change the details before submitting again.

No internal pricing, margin, overhead, labor rate, or other protected internals are stored.

## Safety confirmations

| Check | Status |
|-------|--------|
| Client UI/JS only | Yes |
| Netlify functions unchanged | Yes |
| Supabase/schema unchanged | Yes |
| No new API endpoints | Yes |
| No new DB writes beyond existing submit endpoint | Yes |
| No quote/conversion/invoice/payment creation | Yes |
| No publish/send/email | Yes |
| Pricing/range calculation unchanged | Yes |
| No internal cost/margin exposure | Yes |

## Test plan

1. Open the AI Closer client flow with a tenant slug in the URL.
2. Complete scope, budget, and quote steps.
3. Use **Send starter quote** (or Zoom / print-with-contact path) and submit contact details once.
4. Confirm button shows `Submitting...` then `Submitted`.
5. Confirm success message: `Pre-quote submitted. The owner can review it now.`
6. Rapidly double-click submit (or click send again) — only **one** prequote should be created.
7. Try the same details again within 10 minutes — fingerprint message should block duplicate submit.
8. Change project name or email — submit should be allowed (new fingerprint).
9. Simulate network failure (offline / blocked request) — button re-enables, error shown, no auto-retry.
10. Verify print/download still works after successful submit when contact is already on file.

## Expected counts for a single new test

After one fresh client submit test:

| Metric | Expected change |
|--------|-----------------|
| `prequotes_count` | **+1** exactly |
| `conversion_rows` | unchanged |
| `quotes_count` | unchanged |
| `invoices_count` | unchanged |
| `payments_count` | unchanged |
