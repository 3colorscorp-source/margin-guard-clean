# CH-013A.2.1Z — Zapier Contract Email (Catch Raw Hook → Gmail → Callback)

Active beta email transport for Margin Guard contract signing invitations.

**Margin Guard does not call Gmail API.**

**Margin Guard is the only source of truth** for invitation, generation, delivery attempt, `provider_message_id`, delivery status, events, and idempotency. Zapier only transports email and reports the final Gmail outcome via signed callback. Zapier must not persist delivery state.

## Architecture decision: ASYNCHRONOUS ACK ONLY (Model B)

Zapier **Catch Hook / Catch Raw Hook** returns an immediate generic HTTP 200 and **cannot**:

- wait for subsequent Zap steps (Code / Gmail) to finish, or
- return a custom JSON body with `accepted` + `provider_message_id` to the original Netlify `fetch`.

Official Zapier docs: response customization is not supported for Catch Hook / Catch Raw Hook.

Therefore:

| Signal | Meaning |
|---|---|
| Catch Hook HTTP 2xx | Zapier **received** the webhook (`awaiting_zapier_callback`) — **NOT** email sent |
| Signed callback `status=sent` + Gmail message id | Email **sent** |
| Signed callback `status=failed` | Email **failed** |

Do **not** mark Owner UI **Email sent** from a generic Catch Hook 200.

---

## End-to-end flow

1. Owner clicks **Email Signing Link**
2. Queue creates attempt `queued`, may rotate Generation N+1 atomically
3. Background decrypts handoff, builds ephemeral signing URL + template
4. `ZapierProvider.send` POSTs canonical HMAC-signed JSON to Catch **Raw** Hook
5. Zapier returns generic 200 → attempt stays `sending`, handoff consumed, **no sent**
6. Zap verifies HMAC + timestamp + schema → Gmail Send Email
7. Zap POSTs signed callback to Margin Guard with Gmail outcome
8. Callback finalizes `sent|failed` (write-once `provider_message_id`)

---

## Netlify environment

| Variable | Purpose |
|---|---|
| `CONTRACT_EMAIL_DELIVERY_ENABLED` | Feature gate |
| `CONTRACT_EMAIL_ZAPIER_WEBHOOK_URL` | Catch **Raw** Hook URL (never log) |
| `CONTRACT_EMAIL_ZAPIER_HMAC_SECRET` | Outbound webhook HMAC secret |
| `CONTRACT_EMAIL_ZAPIER_CALLBACK_SECRET` | **Preferred** inbound callback HMAC secret (separate) |
| `CONTRACT_EMAIL_FROM_NAME` | Display name in payload |
| `CONTRACT_EMAIL_REPLY_TO` | Reply-To |
| `CONTRACT_EMAIL_INTERNAL_ALLOWLIST` | Deprecated (CH-013A.30). No longer gates delivery. |
| `CONTRACT_EMAIL_DISPATCH_SECRET` | Background dispatch auth |
| `CONTRACT_EMAIL_HANDOFF_KEY` | 32-byte AES handoff key |

If `CONTRACT_EMAIL_ZAPIER_CALLBACK_SECRET` is unset, callback verification uses `CONTRACT_EMAIL_ZAPIER_HMAC_SECRET` with **direction binding**: signed material = `v1.callback.${rawBody}` (not the same bytes as outbound).

**Not required:** `RESEND_API_KEY`, `CONTRACT_EMAIL_FROM`.

---

## HMAC contract (byte-exact)

### Outbound (Netlify → Zapier) — CH-013A.2.9 body-signed envelope

Zapier Catch Raw Hook receives HTTP headers, but Code-by-Zapier Step 2 runtime
`inputData` does **not** reliably materialize mapped header fields. Therefore the
authoritative HMAC material lives **inside the JSON body**. Headers are kept for
diagnostics and must equal the body fields.

1. Build the invitation payload object (see fields below).
2. `signed_body = JSON.stringify(recursivelyKeySorted(payload))` (UTF-8).
3. `timestamp = ISO-8601 UTC` (e.g. `2026-08-04T20:00:00.000Z`).
4. `signature = lowercase hex(HMAC-SHA256(HMAC_SECRET, timestamp + "." + signed_body))`.
5. Outer wire body (also recursively key-sorted JSON):

```json
{
  "envelope_schema_version": "1",
  "timestamp": "<ISO timestamp>",
  "signature": "<lowercase hex HMAC>",
  "signed_body": "<exact canonical JSON string of invitation payload>"
}
```

6. POST the outer wire body as the raw HTTP body.
7. Headers (mirror body; do not rely on them in Step 2):
   - `Content-Type: application/json`
   - `X-Margin-Guard-Timestamp: <same timestamp>`
   - `X-Margin-Guard-Signature: <same signature>`
   - `X-Margin-Guard-Idempotency-Key: zapier:attempt:{attempt_id}`

**Freshness window:** ±5 minutes (`TIMESTAMP_MAX_SKEW_MS`).

**Zapier Code step (Catch Raw Hook) — inputs: `raw_body`, `hmac_secret` only:**

1. Read **exact raw request body string** from `inputData.raw_body`.
2. `JSON.parse(raw_body)` → outer envelope (`timestamp`, `signature`, `signed_body`).
3. Reject missing/malformed envelope fields; reject stale/future timestamps.
4. Recompute hex HMAC over `timestamp + "." + signed_body` with constant-time compare.
5. Only after HMAC passes: `JSON.parse(signed_body)` → invitation payload.
6. Apply invitation schema validation; return flat string Data Out fields.

Do **not** map `signature_header` / `timestamp_header` / `headers_json` into Step 2.
Do **not** reconstruct `signed_body` before verification.

### Inbound callback (Zapier → Netlify)

`POST /.netlify/functions/contract-invitation-email-zapier-callback`

Same header scheme. Prefer dedicated `CONTRACT_EMAIL_ZAPIER_CALLBACK_SECRET` signing the **exact callback JSON string**.

Fallback (shared outbound secret): sign/verify `timestamp + "." + "v1.callback." + rawBody`.

Callback signing is **unchanged** by CH-013A.2.9 (no body envelope on the callback).

---

## Canonical outbound payload fields

`schema_version`, `event_type=contract_signing_invitation`, `tenant_id`, `project_id`, `quote_id`, `package_id`, `envelope_id`, `invitation_id`, `generation_id`, `generation_number`, `attempt_id`, `recipient_email`, `recipient_name`, `subject`, `html_body`, `text_body`, `reply_to`, `from_name`, `expires_at`, `correlation_id`, `sent_at`, `idempotency_key`

Signing URL may appear **only** inside `html_body` / `text_body`. Never as a separate field. Never send raw token / token_hash / token_id / API keys.

---

## Callback payload

```json
{
  "schema_version": "1",
  "attempt_id": "<uuid>",
  "invitation_id": "<uuid>",
  "generation_id": "<uuid>",
  "tenant_id": "<uuid>",
  "status": "sent",
  "provider_message_id": "<gmail_message_id>",
  "error_code": null,
  "retryable": false,
  "occurred_at": "<iso>",
  "idempotency_key": "zapier:attempt:<attempt_id>:callback"
}
```

`status=failed` omits requirement for `provider_message_id`.

Security:

- HMAC + timestamp freshness
- Tenant resolved from attempt row (payload tenant mismatch → 403)
- invitation/generation relationship checks
- `provider_message_id` write-once
- replay idempotent
- no session/browser auth

---

## provider_message_id source

**Required:** Gmail message ID from the Gmail Send Email step.

Do **not** treat Zap run id / webhook request id as if it were a Gmail message ID.

If Gmail message ID is only available after Send Email, that is why the **callback** exists.

---

## Exact Zap steps (async)

Official Zap contains **only** these steps. Do not add any Zapier-side database, key-value store, record lookup, record create, Filter-on-lookup, or delivery ledger steps.

1. **Webhooks by Zapier — Catch Raw Hook** (raw body + headers for HMAC)
2. **Code by Zapier** — verify HMAC + timestamp + schema; parse JSON after verify
3. **Gmail — Send Email** (To=`recipient_email`, Subject=`subject`, Body HTML=`html_body`, Reply-To=`reply_to`)
4. **Webhooks by Zapier — Custom Request POST** signed callback to Margin Guard
5. **Stop**

Invalid HMAC: no Gmail, no sent callback.

Duplicate / retry outcomes are finalized only inside Margin Guard (callback replay + write-once `provider_message_id`). Zapier must not keep a parallel delivery ledger.

---

## Source of truth / idempotency

**Margin Guard is the only system of record.**

| Concern | Authority |
|---|---|
| invitation / generation / attempt / queued→sending→sent\|failed | **Margin Guard** (`tenant_contract_invitation_delivery_attempts`, invitation, generation) |
| duplicate prevention | **Margin Guard only**: `attempt_id`, write-once `provider_message_id`, callback verification, backend idempotency keys (`zapier:attempt:{attempt_id}`) |
| retry | same `attempt_id` + `zapier:attempt:{attempt_id}`; **no Gen N+2** |
| Zap History | **not** canonical |

Never rely on Zapier for idempotency or delivery history.

Netlify background must **not** treat Catch Hook 200 as failure-retryable in a way that spam-posts webhooks after handoff consume; after ack, wait for callback.

---

## UI truth

| State | When |
|---|---|
| Email queued | Queue HTTP 200 |
| Sending email | Attempt `sending` (incl. awaiting callback) |
| Email accepted — finalizing status | Gmail success recorded, DB `sent` pending |
| Email sent | Callback `status=sent` finalized |
| Email delivery failed | Controlled terminal failure |

---

## Failure matrix (summary)

| Case | Outcome |
|---|---|
| Catch Hook 200, Code HMAC fail | No Gmail; attempt stays sending until timeout/ops; no sent |
| Gmail temp fail | Callback `failed` retryable or Zap retry; MG finalizes once via callback |
| Gmail success, callback fail | Attempt sending / accepted_db_pending after pmid write; callback replay recovers |
| Netlify provider timeout before Catch Hook ack | Retryable dispatch may repost **only while handoff present**; after ack handoff consumed |
| Same attempt twice | MG attempt uniqueness + callback idempotency + write-once `provider_message_id` |
| Attempt `queued` + handoff missing/expired | Terminal `failed` with `handoff_missing` / `handoff_expired` (never dispatched) |
| Attempt `sending` + handoff missing/expired | **Not** failed — `handoff_already_consumed`, stays `sending` awaiting callback (CH-013A.2.4) |
| Duplicate / late dispatch after Catch Hook ack | Harmless: no attempt transition, no `delivery.channel.failed`, no invitation failure |
| Idempotent Email re-click while `sending` with no handoff | Queue returns the in-flight attempt and does **not** re-invoke background dispatch |

---

## Offline QA

```bash
node scripts/qa-ch013a21z-zapier-email-adapter.js
```

Never calls a real webhook. Never sends email.
