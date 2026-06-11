# Margin Guard™ — Official Step Checkpoints

Authoritative closed-step records for reconnect and approval gates.

---

## Step 3E-C14-C — Supervisor Device Read Dual-Auth

**Status:** CLOSED — PRODUCTION PASS / DEVICE READ SMOKE COMPLETE / TEMP DEVICE REVOKED  
**Recorded:** 2026-06-10 (C14-C7 checkpoint close)

### Final production state

| Item | Value |
|------|--------|
| **Production commit** | `1080f63` |
| **Production URL** | https://marginguardsystem.netlify.app |
| **Last deploy ID** | `6a2a0e406c3f72b7f9279fb6` |
| **GitHub origin/main** | Matches local HEAD at close |
| **Working tree** | Clean |

### Implementation chain

1. **C14-C** added supervisor device read dual-auth on `get-supervisor-projects` and `get-supervisor-operational-snapshot`.
2. **Owner path** remains unchanged; owner DTO still exposes owner-only fields.
3. **Device path** filters by supervisor membership `auth_user_id` matching `tenant_projects.supervisor_user_id` for assigned projects only.
4. **Device project DTO** is sanitized — excludes financial and owner-only fields (`quoteId`, `clientEmail`, `depositPaid`, `notes`, `supervisorUserId`, sale/recommended/minimum price, profit, margin, etc.).
5. **Device operational snapshot** is sanitized — no invoice status labels, no financial fields, no quote linkage on device path.

### Commits and deploys

| Hash | Message |
|------|---------|
| `ac82a1e` | Step 3E-C14-C add supervisor read dual-auth |
| `fb0b8e9` | Step 3E-C14-C4a link membership auth user on login |
| `12fd9b4` | Step 3E-C14-C4b add supervisor assignment endpoint |
| `1080f63` | Step 3E-C14-C4a-b2 resolve membership auth user on bootstrap |

| Deploy | ID |
|--------|-----|
| C14-C read dual-auth baseline | `6a2a0130a8f5998430e9a209` |
| **Final production deploy** | `6a2a0e406c3f72b7f9279fb6` |

### C14-C5 / C14-C6 smoke evidence

| Item | Result |
|------|--------|
| **C7B test supervisor** (`mg-c7b-supervisor-001@marginguard.test`) | role `supervisor`, status `active`, auth link completed |
| **Project Test A** | client `Test A`, status `assigned`, assigned to C7B supervisor chain |
| **Protected production projects unchanged** | Soco bathroom, 625 2nd St RENOVATION, Freemont H. R304, Sharon Bathroom — all remain owner-assigned |
| **C14-C6 temp supervisor device** | created → paired → read smoke passed → revoked |
| **Active temp devices remaining** | 0 |

### Device read smoke results (C14-C6)

| Check | Result |
|-------|--------|
| Device `get-supervisor-projects` HTTP | 200 |
| Device project count | 1 |
| Project Test A visible | Yes |
| Protected production projects visible in device mode | No |
| Forbidden fields in device project list | None |
| Device `get-supervisor-operational-snapshot` HTTP (Project Test A) | 200 |
| Forbidden financial/owner fields in snapshot | None |
| Invoice status label leak on device path | No |
| Protected project snapshot guard (Soco bathroom) | 403 `supervisor_not_assigned` |
| Post-revoke device read | 401 |

### Device write guard results (C14-C6)

All device-mode write/send probes blocked — no successful mutations:

| Endpoint | Status |
|----------|--------|
| `save-project-report` | 401 |
| `save-project-expense` | 401 |
| `save-project-day-progress` | 401 |
| `assign-supervisor-project` | 401 |
| `send-quote-zapier` | 403 |
| `upsert-tenant-project` | 403 |
| `publish-public-quote` | 403 |
| `get-project-financial-detail` | 401 |

### Side effects and cleanup state

| Item | Value |
|------|--------|
| SQL | 0 |
| New quotes / projects / invoices | 0 |
| `send-quote-zapier` successful calls | 0 |
| `upsert-tenant-project` successful calls | 0 |
| `publish-public-quote` successful calls | 0 |
| Supervisor save write success | 0 |
| Production project assignments changed | 0 |
| Temp C14-C6 device revoked | Yes |
| Active temp devices remaining | 0 |

### Remaining smoke artifacts (intentional)

These remain in production as documented test artifacts — see `MARGIN_GUARD_SMOKE_CLEANUP_POLICY.md` §11:

- C7B test supervisor membership — **active**
- C7B Supabase Auth user — exists (linked via C14-C4a-b2 bootstrap)
- Project Test A — **assigned to C7B**

### Known notes

- `assign-supervisor-project` (owner “Assign to me”) unchanged; new owner-only `assign-project-to-supervisor` assigns via supervisor membership `auth_user_id`.
- Five other supervisor-list projects remain owner-assigned; only Project Test A points at C7B.
- Supervisor device shell UI (C14-B) blocks field writes client-side; backend write endpoints still owner-session-only until C14-D.

### Approval gate (active)

Do **not** start without a fresh reconnect report and explicit approval:

- **C14-D** — supervisor device write path for reports / expenses / day-progress
- **Minimal owner UI** — assign projects to supervisor memberships from owner context
- C13-C / C13-D artifact cleanup (2026-0099, 2026-0100) — deferred unless separately approved

---

## Step 3E-C12 — Seller Performance Phase 2C v1

**Status:** CLOSED — COMPLETE / PRODUCTION PASS  
**Recorded:** 2026-06-10

### Final production state

| Item | Value |
|------|--------|
| **Production commit** | `6b0b49df9082c531986d70bbd7f3e3f82aac74b1` |
| **Production URL** | https://marginguardsystem.netlify.app |
| **Last deploy ID** | `6a29f988a364d577f815c74e` |
| **GitHub origin/main** | Matches local HEAD |
| **Working tree** | Clean |

### Commits

| Hash | Message |
|------|---------|
| `6b0b49d` | Step 3E-C12-B wire sales admin seller performance UI |

### Completed scope

1. Sales Admin Seller Performance Phase 2C v1 is live
2. Added display-only UI:
   - `public/js/sales-admin-sellers.js`
   - `public/sales-admin.html` seller section structure
3. No backend changes
4. No `app.js` changes
5. No seller `/sales` changes
6. Seller Performance aggregates existing owner-only read APIs:
   - `list-tenant-quotes`
   - `get-project-control-projects`
   - `get-sales-approvals`
7. Seller Performance shows: seller/source rows, seller-attributed quotes, owner / legacy quotes, linked-to-project count, total quoted, labor sold estimate, estimated commission, approval request counts
8. Labels are intentionally estimate-based: not email-sent, not paid commission, no win-rate / score overclaiming
9. No SQL used
10. No writes or mutations performed
11. No send/PDF/email/webhook triggered

### Production smoke results

| Check | Result |
|-------|--------|
| Seller Performance rows | 6 |
| Quotes aggregated | 237 |
| Seller-attributed quotes | 4 |
| Owner / legacy quotes | 233 |
| Linked to project | 69 |
| Total quoted | ~$1,592,717.10 |
| Approval requests | 6 |
| Owner / legacy bucket visible | Yes |
| Seller unattributed bucket visible | No |
| Labor sold estimate visible | Yes |
| Estimated commission visible | Yes |
| Existing Published KPI | PASS |
| Existing Quote Pipeline | PASS |
| Existing approval queue | PASS |
| Existing converted projects | PASS |
| Existing commission tracking | PASS |
| Existing recent activity | PASS |
| Seller `/sales` static regression | PASS |
| `public_token` omitted | PASS |
| Public URL omitted | PASS |
| Full UUIDs omitted from UI | PASS |
| `send-quote-zapier` called | 0 |
| `upsert-tenant-project` called | 0 |
| `publish-public-quote` called | 0 |
| PDF upload called | 0 |
| Email/webhook called | 0 |
| New data created | No |

### Known notes

- Owner / legacy dominates because historical and owner-created quotes do not always carry seller attribution
- Four seller-attributed rows currently come from E2E seller smoke history
- Estimated commission depends on owner browser `localStorage` `salesCommissionPct`; it is not a paid commission ledger
- True email-sent count still requires future `sent_at` / send-flow tracking
- Seller Performance Phase 2C v1 is display-only

### Approval gate (active)

Do **not** start without a fresh reconnect report and explicit approval:

- Supervisor device shell
- Seller full send E2E
- Artifact cleanup / unlink work
- `sent_at` / send-tracking work

---

## Step 3E-C11-B — Sales Admin Phase 2B Quote List

**Status:** CLOSED — COMPLETE / PRODUCTION PASS  
**Recorded:** 2026-06-10

### Final production state

| Item | Value |
|------|--------|
| **Production commit** | `87823a4f2060c769c55c2738d734d72cf9616437` |
| **Backend API commit** | `50b14fcabcd78ce737d1c9cb49b72e2f7bb06358` |
| **Production URL** | https://marginguardsystem.netlify.app |
| **Last deploy ID** | `6a29f654e261f02ce25df5dd` |
| **GitHub origin/main** | Matches local HEAD |
| **Working tree** | Clean |

### Commits

| Hash | Message |
|------|---------|
| `50b14fc` | Step 3E-C11-B2 add owner quote list API |
| `87823a4` | Step 3E-C11-B4 wire sales admin quote pipeline UI |

### Completed scope

1. Added owner-only read API: `/.netlify/functions/list-tenant-quotes`
2. API is: owner-only, tenant-scoped, read-only, paginated, filterable, safe DTO only
3. API excludes: `public_token`, public URL, `source_device_id`, full raw quote rows
4. Sales Admin UI now shows:
   - “Published This Month” KPI
   - Quote Pipeline section
   - 25-row first page from `list-tenant-quotes`
5. “Published This Month” correctly means quote records created in the current UTC month, not email-sent quotes
6. Existing Sales Admin sections remain working: approval queue, converted projects, commission tracking, recent activity
7. Seller `/sales` regression static check passed
8. No SQL used
9. No writes or mutations performed
10. No send/PDF/email/webhook triggered

### Production smoke results

| Check | Result |
|-------|--------|
| `list-tenant-quotes` owner GET | PASS |
| Unauthenticated GET | 401 PASS |
| Non-GET method | 405 PASS |
| Pagination | PASS |
| Filters | PASS |
| Invalid input validation | PASS |
| Sales Admin KPI value | 13 |
| Quote Pipeline rows rendered | 25 |
| `public_token` omitted | PASS |
| Public URL omitted | PASS |
| Full UUIDs omitted from UI | PASS |
| `send-quote-zapier` called | 0 |
| `upsert-tenant-project` called | 0 |
| `publish-public-quote` called | 0 |
| PDF upload called | 0 |
| Email/webhook called | 0 |
| New data created | No |

### Known notes

- Seller performance section remains a stub; handle later in Phase 2C
- KPI is “published” / created quotes, not true email-sent count
- True email-sent count requires future `sent_at` / status tracking in send flow

### Approval gate (active)

Do **not** start without a fresh reconnect report and explicit approval:

- Seller full send E2E
- Supervisor device shell
- Seller Performance Phase 2C
- Artifact cleanup / unlink work

---

## Prior closed checkpoint (reference)

**Step 3E-C9-C10** — Seller Firmar dual-auth + UI unblock — COMPLETE / PRODUCTION PASS  
Production commit at close: `be4d0039717c3ef7b4bfcb41532559f0108016eb`  
Deploy ID: `6a29f1217808ff0d7e24e40a`
