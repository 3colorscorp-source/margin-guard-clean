# CH-013A.2.1Z — Zapier Contract Email (Catch Raw Hook → Gmail → Callback)

Active beta email transport for Margin Guard contract signing invitations.

**Margin Guard does not call Gmail API.**

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
6. Zap verifies HMAC → Storage dedupe → Gmail Send Email
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
| `CONTRACT_EMAIL_INTERNAL_ALLOWLIST` | Internal recipients only |
| `CONTRACT_EMAIL_DISPATCH_SECRET` | Background dispatch auth |
| `CONTRACT_EMAIL_HANDOFF_KEY` | 32-byte AES handoff key |

If `CONTRACT_EMAIL_ZAPIER_CALLBACK_SECRET` is unset, callback verification uses `CONTRACT_EMAIL_ZAPIER_HMAC_SECRET` with **direction binding**: signed material = `v1.callback.${rawBody}` (not the same bytes as outbound).

**Not required:** `RESEND_API_KEY`, `CONTRACT_EMAIL_FROM`.

---

## HMAC contract (byte-exact)

### Outbound (Netlify → Zapier)

1. Build payload object (see fields below).
2. `canonicalBody = JSON.stringify(recursivelyKeySorted(payload))` (UTF-8).
3. `timestamp = ISO-8601 UTC` (e.g. `2026-08-04T20:00:00.000Z`).
4. `signature = hex(HMAC-SHA256(HMAC_SECRET, timestamp + "." + canonicalBody))`.
5. POST `canonicalBody` as the raw HTTP body.
6. Headers:
   - `Content-Type: application/json`
   - `X-Margin-Guard-Timestamp: <timestamp>`
   - `X-Margin-Guard-Signature: <hex>`
   - `X-Margin-Guard-Idempotency-Key: zapier:attempt:{attempt_id}`

**Freshness window:** ±5 minutes (`TIMESTAMP_MAX_SKEW_MS`).

**Zapier Code step (Catch Raw Hook):**

1. Read **exact raw request body string** (do not rebuild JSON before verify).
2. Read timestamp + signature headers.
3. Reject missing/duplicate/invalid signature; reject stale/future timestamps.
4. Recompute hex HMAC over `timestamp + "." + rawBody` with constant-time compare.
5. Only then `JSON.parse(rawBody)`.

### Inbound callback (Zapier → Netlify)

`POST /.netlify/functions/contract-invitation-email-zapier-callback`

Same header scheme. Prefer dedicated `CONTRACT_EMAIL_ZAPIER_CALLBACK_SECRET` signing the **exact callback JSON string**.

Fallback (shared outbound secret): sign/verify `timestamp + "." + "v1.callback." + rawBody`.

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

Do **not** store Zap run id / webhook request id as if it were a Gmail message ID.

If Gmail message ID is only available after Send Email, that is why the **callback** exists.

---

## Exact Zap steps (async)

1. **Webhooks by Zapier — Catch Raw Hook** (raw body + headers for HMAC)
2. **Code by Zapier** — verify HMAC + timestamp + schema; parse JSON after verify
3. **Storage by Zapier** — lookup `idempotency_key` / `attempt_id` (secondary dedupe only)
4. **Filter** — continue only if valid and not already sent
5. **Gmail — Send Email** (To=`recipient_email`, Subject=`subject`, Body HTML=`html_body`, Reply-To=`reply_to`)
6. **Storage** — save attempt outcome + **Gmail message id**
7. **Webhooks by Zapier — Custom Request POST** signed callback to Margin Guard
8. Stop

Duplicate path: skip Gmail; callback same `provider_message_id` with `idempotent` semantics on MG side.

Invalid HMAC: no Gmail, no success storage, no sent callback.

---

## Source of truth / idempotency

| Concern | Authority |
|---|---|
| invitation / generation / attempt / queued→sending→sent|failed | **Margin Guard** |
| duplicate Gmail prevention | Zapier Storage (secondary) + MG attempt uniqueness |
| retry | same `attempt_id` + `zapier:attempt:{attempt_id}`; **no Gen N+2** |
| Zap History | **not** canonical |

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
| Storage outage | Prefer fail closed (no Gmail) or controlled retry; MG remains SoT |
| Gmail temp fail | Callback `failed` retryable or Zap retry; no duplicate if Storage marks |
| Gmail success, callback fail | Attempt sending / accepted_db_pending after pmid write; callback replay recovers |
| Netlify provider timeout before Catch Hook ack | Retryable dispatch may repost **only while handoff present**; after ack handoff consumed |
| Same attempt twice | Storage + MG idempotency; one Gmail |

---

## Offline QA

```bash
node scripts/qa-ch013a21z-zapier-email-adapter.js
```

Never calls a real webhook. Never sends email.
