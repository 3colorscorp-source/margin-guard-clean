# Margin Guard™ — Official Step Checkpoints

Authoritative closed-step records for reconnect and approval gates.

---

## Step 3E-C14 Rollout Checkpoint — Supervisor + Seller Device Pilot

**Status:** CLOSED — SUPERVISOR PILOT PASS / SELLER PILOT PASS / SELLER SEND BACKEND HARD-DENY PASS  
**Recorded:** 2026-06-12 (C14-E4-CP1 checkpoint close)

### Production

| Item | Value |
|------|--------|
| **Production URL** | https://marginguardsystem.netlify.app |
| **Production deploy** | `6a2c3c6f1e90b02e40a5c299` |
| **Current commit** | `2e73319` |
| **Previous checkpoint/base commit** | `34bf724` |

### Supervisor Pilot final state

| Item | Value |
|------|--------|
| **Display name** | Librado Muñoz — Supervisor Pilot |
| **Email** | libradomunoztcc@gmail.com |
| **Role** | supervisor |
| **Status** | active |
| **Auth linked** | true |
| **Active devices** | 1 |
| **Assigned project** | Bridge Link Test |
| **Device** | Librado — Supervisor Device Pilot |
| **Device portal type** | supervisor |
| **Device status** | active |
| **Read scope verified** | sees Bridge Link Test only |
| **Hidden from supervisor device** | Project Test A, C7B project, protected projects, owner-wide projects |
| **Operational policy** | read-only approved; report writes deferred; expenses disabled; day-progress disabled |

### Seller Pilot final state

| Item | Value |
|------|--------|
| **Display name** | Librado Muñoz — Seller Pilot |
| **Email** | 3colorscorp+mg-seller-librado@gmail.com |
| **Role** | seller |
| **Status** | active |
| **Auth linked** | false (expected — device-bound) |
| **Active devices** | 1 |
| **Device** | Librado — Seller Device Pilot |
| **Device portal type** | seller |
| **Device status** | active |
| **Paired profile** | `C:\Users\lalom\AppData\Local\mg-e4c-seller-device-profile` |

**Seller `/sales` mode verified:**

- owner nav hidden
- Business Settings hidden
- Supervisor controls hidden
- Sales Admin hidden
- owner/admin controls hidden
- seller notice visible

**Seller allowed pilot actions:**

- build quote draft
- create public quote link
- Firmar only with owner approval

**Seller blocked actions:**

- send quote email
- PDF/send flow
- invoice creation
- owner settings
- supervisor controls
- protected project data

### Seller smoke artifacts

| Artifact | Detail |
|----------|--------|
| **E4-E quote** | Estimate `2026-0101`; marker `E4-E Seller Publish Smoke — Do Not Send`; status `archived`; no project; no invoice; no send/PDF |
| **E4-F quote** | Estimate `2026-0102`; marker `E4-F Firmar Smoke — Do Not Send`; status `accepted`; linked to archived QA project; retained as audit artifact; no invoice; no send/PDF |
| **E4-F QA project** | Marker `E4-F Firmar Smoke — Do Not Send`; status `archived`; no invoice; no supervisor assignment |

### Backend hardening

| Item | Value |
|------|--------|
| **Commit** | `2e73319` |
| **File changed** | `netlify/functions/send-quote-zapier.js` |
| **Behavior** | seller device direct POST to `send-quote-zapier` returns 403; safe response code `seller_device_send_blocked`; deny occurs before quote lookup, PDF upload, Zapier/email |
| **Owner path** | empty-body POST reaches normal `client_email` validation — owner path not blocked |

**Production smoke (C14-E4-H1-D):**

| Check | Result |
|-------|--------|
| Seller direct send POST | 403 `seller_device_send_blocked` |
| Owner safe empty-body POST | 400 missing `client_email` validation |
| Quotes / projects / invoices / PDF / email side effects | 0 |

### Protected baseline

| Item | Value |
|------|--------|
| **Owner/Admin** | 3colorscorp@gmail.com |
| **Bridge Link Test** | assigned to Supervisor Pilot |
| **C7B** | unchanged |
| **Project Test A** | unchanged |
| **Protected projects** | Soco bathroom, 625 2nd St RENOVATION, Freemont H. R304, Sharon Bathroom — unchanged |

### Rollout track summary

| Track | Status |
|-------|--------|
| C14-E3 Supervisor Pilot rollout | COMPLETE / PASS |
| C14-E4 Seller Pilot rollout | COMPLETE / PASS |
| C14-E4-H1 backend hard-deny | COMPLETE / PASS |
| C14-E4-H1-D production smoke | PASS |

### Known future optional work

- **E4-H2 optional cleanup** — remove unreachable seller send branches in `send-quote-zapier.js`
- **Optional future hardening** — seller quote approval queue; owner review step before Firmar in production; accepted quote unlink/cleanup tooling; seller activity log panel

### Approval gate (active)

Do **not** start without a fresh reconnect report and explicit approval:

- E4-H2 dead-code cleanup in `send-quote-zapier.js`
- Seller send/email/PDF production approval (remains blocked)
- Supervisor device field writes re-enablement (deferred per Supervisor Pilot policy)

---

## Step 3E-C14-D — Supervisor Device Field Writes + Owner Assignment UI

**Status:** CLOSED — PRODUCTION PASS / FULL DEVICE UI WRITE SMOKE COMPLETE / TEMP DEVICES REVOKED  
**Recorded:** 2026-06-10 (C14-D2E checkpoint close)

### Final production state

| Item | Value |
|------|--------|
| **Production commit** | `ca8d077` |
| **Production URL** | https://marginguardsystem.netlify.app |
| **Last deploy ID** | `6a2a3eadce5511b141d7327f` |
| **GitHub origin/main** | Matches local HEAD at close |
| **Working tree** | Clean |

### Implementation chain

1. **C14-D1** — owner assignment UI on `/supervisor` (owner-only panel; device mode hidden).
2. **C14-D2B** — backend dual-auth write guards on report/expense/day-progress save + report/expense read refresh.
3. **C14-D2C** — supervisor device portal allowlist + field control unblock (`supervisor-device-portal.js` only).
4. **C14-D2D** — full supervisor device UI write smoke on Project Test A (temp device revoked).

### Commits and deploys

| Hash | Message | Deploy ID |
|------|---------|-----------|
| `cbfde63` | Step 3E-C14-D1 add owner supervisor assignment UI | `6a2a3555e261f0f4b65df6a7` (D1A) |
| `a42a62a` | Step 3E-C14-D2B add supervisor device write backend guards | `6a2a3b449f76f2fadbbea711` (D2B1) |
| `ca8d077` | Step 3E-C14-D2C allow supervisor device field controls | `6a2a3eadce5511b141d7327f` (D2D) |

### C14-D1 — Owner assignment UI (D1A smoke)

| Item | Result |
|------|--------|
| **Status** | PASS — owner UI visible / device hidden / no-mutation smoke |
| **Panel** | “Assign Project to Supervisor” on `/supervisor` |
| **Project dropdown** | Safe labels only |
| **Supervisor dropdown** | Safe labels only |
| **Confirmation** | Required before POST |
| **Valid assign POST during D1A** | None |
| **Existing “Assign to me”** | Unchanged |
| **Device mode** | Assignment panel hidden; owner-assign script no-ops |

### C14-D2B — Backend write dual-auth (D2B1 deploy)

| Item | Result |
|------|--------|
| **Status** | PASS — backend deployed / API-only device smoke passed |
| **Endpoints** | `save-project-report`, `save-project-expense`, `save-project-day-progress`, `get-project-reports`, `get-project-expenses` |
| **Helpers** | `supervisor-device-field-dto.js`, `tenant-device-guard.js` (`assertAssignedSupervisorProject`, `loadTenantProjectForSupervisorAction`) |
| **Device path** | Supervisor device only; assigned projects only; assignment guard before write/read; sanitized DTOs |
| **Owner path** | Preserved unchanged |

### C14-D2B1 — API-only device write smoke

| Check | Result |
|-------|--------|
| Temp C7B device | Created → paired → revoked |
| Scope | Project Test A only |
| Device report save | 200 / `ok true` / DTO safe |
| Device reports read | 200 / DTO safe |
| Device expense save | 200 / `ok true` / DTO safe |
| Device expenses read | 200 / DTO safe |
| Device day-progress save | 200 / `ok true` / DTO safe (day 99) |
| Protected project write guard (Soco bathroom) | 403 `supervisor_not_assigned` |
| Protected project read guard | 403 `supervisor_not_assigned` |
| Forbidden routes blocked | `get-project-financial-detail`, `send-quote-zapier`, `upsert-tenant-project`, `publish-public-quote`, `assign-project-to-supervisor`, `assign-supervisor-project`, `delete-project-report`, `delete-project-expense` — all 401/403 |
| Active temp devices remaining | 0 |

### C14-D2C — Portal allowlist (deployed with D2D)

| Item | Detail |
|------|--------|
| **File** | `public/js/supervisor-device-portal.js` only |
| **Allowed device routes** | `get-supervisor-projects`, `get-supervisor-operational-snapshot`, `save-project-report`, `save-project-expense`, `save-project-day-progress`, `get-project-reports`, `get-project-expenses` |
| **Still blocked** | `get-project-day-progress`, `get-project-financial-detail`, `recalc-project-profit`, all `delete-project-*`, `assign-project-to-supervisor`, `assign-supervisor-project`, `list-tenant-memberships`, send/publish/upsert, invoice/payment/financial/quote/public-token patterns |
| **Controls unblocked** | Labor/report, expense, day-progress, view expenses |
| **Controls still blocked** | Print expense summary, delete buttons, assignment buttons, financial/admin/send/publish/upsert |

### C14-D2D — Full device UI write smoke

| Check | Result |
|-------|--------|
| Temp C7B device | Created → paired → revoked |
| `/supervisor` device mode | Loaded; device notice updated |
| Project Test A visible | Yes (1 project) |
| Protected production projects visible | No |
| Owner assignment panel | Hidden |
| Labor/report UI smoke | PASS |
| Expense UI smoke | PASS |
| Day-progress UI smoke | Deferred — all calendar days already completed (D2B1 day 99 + prior state); backend day-progress passed in D2B1 |
| Device read DTOs | Safe — reports, expenses, operational snapshot |
| Forbidden fields leaked | No API leaks |
| Protected project guard | PASS |
| Forbidden route guards | PASS |
| Post-revoke read/write | 401 blocked |
| Active temp devices remaining | 0 |

### C14-D3B — Smoke report/expense cleanup (2026-06-10)

| Item | Result |
|------|--------|
| **Status** | PASS — owner-approved report/expense cleanup (Option A) |
| **Method** | Owner session `delete-project-report` ×2, `delete-project-expense` ×2 |
| **SQL** | 0 |
| **Deploy** | None |
| **Code/files changed during cleanup** | 0 |
| **Devices created/paired** | 0 |
| **Assignments changed** | 0 |
| **Protected production projects** | Unchanged |

**Deleted (closed):** D2B smoke report, D2D UI smoke report, D2B smoke expense, D2D UI smoke expense on Project Test A (masked refs at delete: `5936…1341`, `da12…3265`, `f2ca…975c`, `d791…b5b4`).

**Kept:** day 99 completed progress (`9338…161e`, note `C14-D2B smoke day progress`); C7B membership; C7B Auth user; Project Test A → C7B assignment.

### Side effects and remaining smoke artifacts

| Item | Value |
|------|--------|
| Project Test A assignment | Remains assigned to C7B |
| C7B supervisor membership | Active |
| C7B Auth user | Exists (linked) |
| Project Test A report smoke rows | **Closed/deleted** (D3B) — 0 remaining |
| Project Test A expense smoke rows | **Closed/deleted** (D3B) — 0 remaining |
| Project Test A day 99 progress | **Open — keep** — sole remaining C14-D field artifact |
| Temp devices (C14-C6, D2B1, D2D) | Revoked; active temp devices: 0 |
| Protected production projects | Unchanged — Soco bathroom, 625 2nd St RENOVATION, Freemont H. R304, Sharon Bathroom |
| SQL | 0 |
| New quotes / projects / invoices | 0 |
| Successful send / upsert / publish | 0 |

See `MARGIN_GUARD_SMOKE_CLEANUP_POLICY.md` §11 for artifact register.

### Known notes

- Device portal allowlist is client-side guard only; backend D2B guards are authoritative.
- `get-project-day-progress` remains blocked in device portal; UI uses operational snapshot + `save-project-day-progress`.
- `recalc-project-profit` remains blocked in device mode; saves succeed (non-fatal in `app.js`).
- Expense UI stores concept + note as combined note field (e.g. `smoke` + D2D note).

### Recommended next phase

Do **not** start without a fresh reconnect report and explicit approval:

- **Optional day 99 reopen** — owner-approved `save-project-day-progress` reopen only (no delete endpoint; not required)
- **C14-E** — production-ready supervisor onboarding / assignment polish
- **C14-D hardening** — unassign endpoint / assignment history / UI refresh sync

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
- C14-D closed — supervisor device field writes + owner assignment UI are production-pass (see Step 3E-C14-D above).

### Approval gate (active)

Do **not** start without a fresh reconnect report and explicit approval:

- C14-D optional cleanup / C14-E polish / C14-D hardening (see Step 3E-C14-D recommended next phase)
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
