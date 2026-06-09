# Device-Bound Portal Guard Specification

**Status:** DRAFT — specification only (Step 3C)  
**Do not wire into Netlify functions until Step 3D+**  
**Companion migrations:** `SUPABASE_PROFILES_MEMBERSHIP_M1.sql` through `SUPABASE_ATTRIBUTION_COLUMNS_M4.sql` (DRAFT — DO NOT RUN)

---

## 1. Purpose

Define how Margin Guard™ enforces **company-owned, device-bound** access for:

- **Seller tablets** → reuse existing `sales.html` (Sales/Vendedor) workflow
- **Supervisor tablets** → reuse existing `supervisor.html` workflow

Owner/Admin continues using **`mg_session`** with full tenant access. Devices use **`mg_device_session`** with strict tenant + role + device scope.

**Core rule:** A seller/supervisor/device from Tenant A must never read, create, update, or report against Tenant B data.

---

## 2. Two session types

| Cookie | Users | Entitlement | Tenant resolution |
|--------|-------|-------------|-------------------|
| **`mg_session`** | Owner (v1 owner-only), platform `is_admin` | Stripe subscription or `tenants.plan_status` + owner membership | `session.c` + `session.e` → `resolveTenantFromSession` (existing) |
| **`mg_device_session`** | Seller / supervisor tablets | Company provisioning; no personal subscription | `session.t` + `device_id` → `device_sessions` + `tenant_devices` + `profiles` |

**Never** accept `mg_device_session` on owner financial endpoints.  
**Never** treat `mg_session` as seller/supervisor device without explicit membership role check.

### `mg_device_session` signed payload (proposed)

```json
{
  "sid": "<device_sessions.id>",
  "d": "<tenant_devices.id>",
  "t": "<tenant_id>",
  "m": "<profiles.id>",
  "p": "seller|supervisor",
  "iat": 0,
  "exp": 0
}
```

- HMAC-SHA256 with `SESSION_SECRET` (same family as `mg_session`)
- HttpOnly, Secure, SameSite=Lax, Path=/
- Role is **not** authoritative in cookie — revalidated from `profiles` row server-side

---

## 3. Device session validation flow

```
1. readDeviceSessionFromEvent(event)
   → missing/invalid signature/expired → 401

2. hash(cookie_token) → lookup device_sessions
   WHERE session_token_hash = hash
     AND status = 'active'
     AND expires_at > now()

3. load tenant_devices WHERE id = session.d
   → status must be 'active'
   → tenant_id must match session.t

4. load profiles WHERE id = session.m
   → status must be 'active'
   → tenant_id must match session.t
   → role must match portal_type (seller → role=seller, etc.)

5. attach context: { session, tenant, device, membership, portal_type }

6. handler runs with assertSameTenant on any row id touched
```

**Owner revoke:** `device_sessions.status = 'revoked'`, `revoked_at = now()` → step 2 fails immediately.

---

## 4. Pairing flow

**Owner-approved pairing code format:**

- Exactly **8 characters**
- Charset: **uppercase A–Z and digits 0–9** (`[A-Z0-9]{8}`)
- **5-minute TTL** (`pairing_expires_at`)
- **One-time use** (hash cleared on successful pair)
- **Normalize user input to uppercase** before format check and hash comparison

```
Owner (mg_session):
  POST create-tenant-device
    → generate code: 8 chars from A-Z0-9
    → tenant_devices: status=pending_pair, pairing_code_hash, pairing_expires_at

Tablet (unauthenticated or pre-pair page):
  POST pair-device { device_id, pairing_code, device_fingerprint? }

Server:
  1. load tenant_devices WHERE id AND status=pending_pair
  2. verify pairing_expires_at > now()
  3. normalize pairing_code = uppercase(trim(input))
  4. verify format matches /^[A-Z0-9]{8}$/
  5. verify hash(normalized_code) = pairing_code_hash
  4. load membership; assert membership.tenant_id = device.tenant_id
  5. assert membership.role matches device.portal_type
  6. if portal_type=seller: count active devices for membership < 3
  7. REVOKE any existing active device_sessions for device_id
  8. UPDATE device: status=active, clear pairing_code_hash, set fingerprint
  9. INSERT device_sessions (active, expires_at = now() + 30 days)
 10. Set-Cookie mg_device_session
 11. Redirect to /seller or /supervisor (device mode)
```

**Pairing code:** never logged in plaintext in production; store hash only.

---

## 5. Heartbeat / renewal flow

```
POST device-heartbeat (requireTenantDevice)

1. validate session (section 3)
2. UPDATE device_sessions SET last_seen_at = now()
3. IF expires_at < now() + 7 days:
     SET expires_at = now() + 30 days  -- rolling TTL
4. UPDATE tenant_devices SET last_seen_at = now()
5. return { ok: true, expires_at }
```

**30-day rolling TTL** (owner-approved). Job may mark `status=expired` where `expires_at < now()` for housekeeping.

---

## 6. Logout flow

```
POST device-logout (requireTenantDevice)

1. UPDATE device_sessions SET status=revoked, revoked_at=now()
   WHERE id = session.sid AND status=active
2. Set-Cookie mg_device_session Max-Age=0
3. Redirect to /pair or static "device logged out" page
```

---

## 7. Revoke / reset / reassign flow

### Revoke (owner)

```
POST revoke-tenant-device { device_id }

→ tenant_devices.status = revoked, revoked_at = now()
→ all device_sessions for device_id → revoked
→ tablet gets 401 on next request
```

### Reset (owner)

```
POST reset-tenant-device { device_id }

→ revoke all sessions
→ tenant_devices.status = pending_pair
→ new pairing_code_hash + pairing_expires_at (+5 min)
→ clear device_fingerprint
→ tablet must re-pair
```

### Reassign (owner, owner-approved)

```
PATCH reassign-tenant-device { device_id, assigned_membership_id }

→ assert same tenant_id
→ assert new membership.role matches portal_type
→ REVOKE all sessions (required)
→ UPDATE assigned_membership_id
→ status = pending_pair (require re-pair — owner-approved)
→ clear fingerprint + new pairing code
```

---

## 8. API guard helper design

**Target module (Step 3D+):** `netlify/functions/_lib/tenant-device-guard.js`  
**Step 3C:** spec only — **not imported** by live handlers.

### Helpers

| Helper | Behavior |
|--------|----------|
| `requireTenantSession(event)` | Valid `mg_session`; resolve tenant + membership; membership `active` |
| `requireOwner(event)` | `requireTenantSession` + `membership.role === 'owner'` (v1 owner-only; `admin` reserved) |
| `requireTenantDevice(event, { portals })` | Valid `mg_device_session`; device `active`; membership `active`; portal_type in allowed set |
| `requireSellerDevice(event)` | `requireTenantDevice(..., { portals: ['seller'] })` + `role === 'seller'` |
| `requireSupervisorDevice(event)` | `requireTenantDevice(..., { portals: ['supervisor'] })` + `role === 'supervisor'` |
| `assertSameTenant(tenantId, row.tenant_id)` | Strict equality; 403/404 on mismatch |
| `assertAssignedSupervisorProject(membership, projectRow)` | `projectRow.supervisor_user_id === membership.auth_user_id` OR owner session |
| `assertSellerOwnQuote(membership, quoteRow)` | Seller device only: `quoteRow.tenant_id === membership.tenant_id` **and** `quoteRow.seller_membership_id === membership.id`. Reject null `seller_membership_id`. |

### Legacy quote access policy (seller device)

**Seller devices must NOT see legacy/null-attribution quotes.**

A seller device may read a quote only when **both** are true:

1. `quote.tenant_id` matches the device session tenant
2. `quote.seller_membership_id` matches the device session membership (`profiles.id`)

Quotes with `seller_membership_id IS NULL` (pre-attribution / owner-created legacy rows) are **invisible** to seller device APIs and UI lists. Return **403** or omit from list responses — do not leak existence via different error codes.

**Owner/admin (`mg_session`)** may still read all tenant quotes, including legacy/null-attribution rows. No filter on `seller_membership_id` for owner paths.

Apply this policy on seller-device quote list, quote detail, publish follow-up, and any seller-scoped read endpoint in Step 3E+.

### Context object returned

```js
{
  session,       // raw cookie payload
  tenant,        // tenants row
  membership,    // profiles row
  device,        // tenant_devices row (device sessions only)
  portalType,    // seller | supervisor | null (owner)
  authMode       // 'owner' | 'device'
}
```

---

## 9. Endpoint rollout plan (do not wire in Step 3C)

### Phase 3D — device auth endpoints (new)

| Endpoint | Guard | Notes |
|----------|-------|-------|
| `pair-device` | public + code | Creates session |
| `device-auth-status` | device cookie | |
| `device-heartbeat` | requireTenantDevice | |
| `device-logout` | requireTenantDevice | |

### Phase 3D — owner device management (new)

| Endpoint | Guard |
|----------|-------|
| `create-tenant-device` | requireOwner |
| `revoke-tenant-device` | requireOwner |
| `reset-tenant-device` | requireOwner |
| `reassign-tenant-device` | requireOwner |
| `list-tenant-devices` | requireOwner |
| `list-team-members` | requireOwner |
| `create-seller-profile` | requireOwner |
| `create-supervisor-profile` | requireOwner |

### Phase 3E — existing endpoints (guard retrofit)

| Endpoint | Owner | Seller device | Supervisor device |
|----------|-------|---------------|-------------------|
| `publish-public-quote` | ✓ | ✓ + attribution | ✗ |
| `calc-secure-pricing` | ✓ | ✓ | ✗ |
| `get-supervisor-projects` | ✓ all | ✗ | ✓ assigned only |
| `get-supervisor-operational-snapshot` | ✓ | ✗ | ✓ assigned |
| `save-project-day-progress` | ✓ | ✗ | ✓ assigned |
| `save-project-report` | ✓ | ✗ | ✓ assigned |
| `save-project-expense` | ✓ | ✗ | ✓ assigned |
| `get-project-financial-detail` | ✓ | ✗ | ✗ |
| `list-tenant-invoices` | ✓ | ✗ | ✗ |
| `save-tenant-snapshot` | ✓ | ✗ | ✗ |
| `get-sales-approvals` | ✓ | ✗ | ✗ |
| `bootstrap-tenant` | ✓ owner path only | ✗ skip / no-op | ✗ |

**Step 3C:** none of the above wired.

---

## 10. Security notes

| Topic | Mitigation |
|-------|------------|
| Cross-tenant devices | DB triggers on `tenant_devices` + `device_sessions`; `assertSameTenant` on every row |
| Stolen tablet | Owner revoke; short pairing TTL; no financial APIs on device session |
| Pairing code reuse | Clear hash on success; expire at 5 minutes; A-Z0-9 uppercase only |
| Legacy quote leakage | Seller device filtered to `seller_membership_id = membership.id`; null attribution hidden |
| Session replay | One active session per device (partial unique index); revoke on re-pair |
| Seller → owner routes | API 403 + UI nav hidden in device mode |
| Supervisor → wrong project | `assertAssignedSupervisorProject` |
| Owner financial exposure on supervisor | Strip salePrice / margin from supervisor device DTOs; block financial-detail API |

---

## 11. Owner-approved decisions (Step 3B)

| # | Decision |
|---|----------|
| 1 | Add `display_name` on profiles |
| 2 | Max **3** active seller devices per membership (app-enforced at pair) |
| 3 | Reassign device → revoke sessions + **require re-pair** |
| 4 | Device session TTL = **30 days** rolling via heartbeat |
| 5 | Pairing code = **8 chars A–Z0-9 uppercase**, **5-minute** TTL; normalize input to uppercase |
| 6 | **Owner-only v1**; `admin` role in CHECK for future |
| 7 | Keep **`supervisor_user_id`** on projects; set from `membership.auth_user_id` at assign |
| 8 | **One active session per device**; revoke previous on new pair |

---

## 12. UI scope (reference for 3D/3E — not implemented in 3C)

### Seller device (`sales.html` device mode)

**Show:** existing Sales/Vendedor workflow  
**Hide:** Dashboard, Business Settings, Sales Admin, Invoice Hub, Supervisor, Owner, Project Control

### Supervisor device (`supervisor.html` device mode)

**Show:** assigned projects, day progress, reports, expenses  
**Hide:** all owner nav; contract total, profit, margin, client price in API responses

---

## 13. Migration apply order (when approved — not Step 3C)

1. `SUPABASE_PROFILES_MEMBERSHIP_M1.sql` — preflight SELECTs first  
2. `SUPABASE_TENANT_DEVICES_M2.sql`  
3. `SUPABASE_DEVICE_SESSIONS_M3.sql`  
4. `SUPABASE_ATTRIBUTION_COLUMNS_M4.sql`  

**No production RUN until explicit owner sign-off per environment.**

---

*End of DEVICE_BOUND_PORTAL_GUARD_SPEC.md — DRAFT*
