# Margin Guard™ — Smoke Artifact Cleanup Policy & Register

**Status:** Policy document only — not a cleanup execution script  
**Created:** Step 3E-C13-B (2026-06-10)  
**Source:** Step 3E-C13-A read-only preflight

---

## 1. Purpose

This document governs **smoke and E2E test artifact cleanup policy** for the Margin Guard™ owner tenant. It defines:

- What artifacts exist and their cleanup status
- What may never be bulk-cleaned or deleted
- How future smokes should be run to stay cleanup-friendly
- What execution paths are available **when owner explicitly approves** cleanup

**This file does not execute cleanup.** No archive, unlink, delete, or SQL is implied by reading or committing this document. Cleanup requires a separate approved step (C13-C endpoint or C13-D owner SQL).

---

## 2. Current tenant snapshot (C13-A baseline)

Read-only inventory at preflight time:

| Metric | Count |
|--------|------:|
| Total quotes | 237 |
| Test `@marginguard.test` seller quotes | 4 |
| Device-origin quotes | 4 |
| Linked to project | 69 |
| Linked but not in Project Control | 62 |
| Archived quotes | 23 |
| Accepted/approved quotes | 64 |
| Ready-to-send orphan quotes | 146 |
| UTC June 2026 created (KPI month) | 13 |
| Test approvals | 0 |
| Test memberships (all `removed`) | 13 |
| Test devices (all `revoked`) | 12 |

---

## 3. Artifact register

Safe identifiers only — no full UUIDs, no `public_token`.

| Estimate | Project name | Status | Linked? | PCC visible? | Seller (test email) | Invoice | Cleanup status | Block reason |
|----------|--------------|--------|---------|--------------|---------------------|---------|----------------|--------------|
| 2026-0096 | C9C5 OWNER TEST QUOTE - DELETE | archived | no | no | — | none | **Closed** | already archived |
| 2026-0097 | C9C5 TEST QUOTE - DELETE | archived | no | no | mg-c9c5-seller-publish-001@marginguard.test | none | **Closed** | already archived |
| 2026-0098 | C9C9 TEST PUBLISH ONLY - DELETE | archived | no | no | mg-c9c9-seller-publish-001@marginguard.test | none | **Closed** | already archived |
| 2026-0099 | C10B2 TEST FIRMAR ONLY - DELETE | accepted | yes | no | mg-c10b2-seller-firmar-001@marginguard.test | none | **Pending** | `quote_accepted`, `quote_has_project` |
| 2026-0100 | C10D TEST FIRMAR E2E - DELETE | accepted | yes | no | mg-c10d-seller-firmar-001@marginguard.test | none | **Pending** | `quote_accepted`, `quote_has_project` |

**Notes on register columns:**

- **Linked?** — quote has a `tenant_projects` row referencing it (`has_tenant_project`).
- **PCC visible?** — appears in Project Control active list (`get-project-control-projects`). Archived/excluded projects are not visible.
- **Invoice** — none on pending Firmar smokes; production linked quotes may have draft/archived invoices and must not be touched under this policy.

---

## 4. Closed artifacts

These smoke artifacts are **complete**. No further cleanup action required.

| Estimate | Project | Outcome |
|----------|---------|---------|
| **2026-0096** | C9C5 OWNER TEST QUOTE - DELETE | Archived, unlinked — owner publish-only smoke (C9-C5) |
| **2026-0097** | C9C5 TEST QUOTE - DELETE | Archived, unlinked — seller publish smoke (C9-C5) |
| **2026-0098** | C9C9 TEST PUBLISH ONLY - DELETE | Archived, unlinked — seller publish-only smoke (C9-C9) |

---

## 5. Pending artifacts

These are the **only** quotes designated as targeted cleanup candidates.

### 2026-0099 — C10B2 TEST FIRMAR ONLY - DELETE

| Field | Value |
|-------|--------|
| Status | accepted |
| Linked | yes (to archived project — not in PCC) |
| Seller | mg-c10b2-seller-firmar-001@marginguard.test |
| Device-origin | yes |
| Invoices | none |
| Block | `archive-tenant-quote` rejects: `quote_accepted`, `quote_has_project` |
| Origin | Step 3E-C10-B2 Firmar backend smoke |

### 2026-0100 — C10D TEST FIRMAR E2E - DELETE

| Field | Value |
|-------|--------|
| Status | accepted |
| Linked | yes (to archived project — not in PCC) |
| Seller | mg-c10d-seller-firmar-001@marginguard.test |
| Device-origin | yes |
| Invoices | none |
| Block | `archive-tenant-quote` rejects: `quote_accepted`, `quote_has_project` |
| Origin | Step 3E-C10-D Firmar seller E2E smoke |

**Existing API gap:** `archive-tenant-project` soft-archives projects but does not clear `quote_id`. No unlink endpoint exists today.

---

## 6. Cleanup policy

### Always forbidden

- **Never bulk-clean** the 146 ready-to-send orphan quotes — they are not smoke-labeled; most are owner/legacy drafts.
- **Never delete** rows with active or paid invoices, or production payment ledger history.
- **Never delete** production `tenant_projects` with real labor/consumption history.
- **Never run bulk SQL** — one artifact at a time only, with owner approval per artifact.
- **Never** cleanup without verifying invoice and payment impact first.

### Default: leave in place

- Production and legacy quotes/projects unless explicitly smoke-labeled (`DELETE`, `[SMOKE]`, `@marginguard.test` seller) **and** owner-approved.
- Removed test memberships (13) and revoked test devices (12) — **keep as audit trail** unless owner explicitly purges audit data later.
- Accepted quotes linked to production projects (kitchen/bath/etc.) with draft or archived invoices.

### Allowed targeted candidates

- **Only 2026-0099 and 2026-0100** are approved cleanup **candidates** (not yet executed).
- Cleanup must be **one artifact at a time**, with before/after verification.
- Prefer **dry_run** (if C13-C endpoint) or **backup snapshot** (if C13-D SQL) before any mutation.

### Existing API capabilities (reference)

| API | Can do today | Cannot do |
|-----|--------------|-----------|
| `archive-tenant-quote` | Archive orphan non-accepted quotes | Accepted, linked, or invoiced quotes |
| `archive-tenant-project` | Soft-archive active projects | Unlink `quote_id`, archive accepted quote |

---

## 7. Future smoke hygiene checklist

Before starting any smoke/E2E:

- [ ] Use project name prefix `[SMOKE]` or suffix ` - DELETE`
- [ ] Use seller email under `@marginguard.test` with step-specific prefix (e.g. `mg-c10d-...`)
- [ ] Record estimate number in checkpoint doc **immediately** after publish
- [ ] Prefer **publish-only** tests when Firmar is not required
- [ ] If Firmar is required: plan **project archive + quote cleanup path** in the same step plan
- [ ] Avoid creating **accepted** quotes unless acceptance is what is being tested
- [ ] Revoke device and remove membership in the **same run** (C6–C9 pattern)
- [ ] Add artifact row to this register with status Open → Closed
- [ ] Note cleanup block reason if artifact cannot be closed in-run

---

## 8. Cleanup execution options (documented only — not implemented)

Owner must choose one path before any cleanup runs.

### Option A — Leave as historical artifacts (default / lowest risk)

- Keep **2026-0099** and **2026-0100** as accepted smoke records.
- No mutation; Sales Admin shows them in pipeline/seller performance.
- Proceed to next roadmap item (e.g. Supervisor shell preflight) when owner accepts noise.

### Option B — Future owner-only cleanup endpoint (C13-C)

Smallest safe endpoint behavior (to be implemented only with explicit approval):

| Requirement | Detail |
|-------------|--------|
| Auth | Owner-only (`requireOwnerMembership`) |
| Lookup | `quote_number_display` + `project_name` — no `public_token` |
| `dry_run: true` | Return planned actions only; no writes |
| Scope | One artifact per request — **no bulk** |
| Guards | Project status archived/cancelled; quote seller `@marginguard.test` OR project name contains `DELETE`; **no active invoices/payments** |
| Mutations | Unlink `quote_id` from archived project only; then archive quote or mark cleanup-safe |
| Forbidden | Row deletes, bulk operations, public_token, bypass invoice guard |
| Response | Safe summary only (estimate, project name, status, actions taken) |

**Likely files if approved:** `netlify/functions/unlink-smoke-artifact.js` (new); optional owner UI hook.

### Option C — Owner-approved one-off SQL (C13-D)

| Requirement | Detail |
|-------------|--------|
| Approval | **Separate explicit owner approval** per artifact — not covered by this policy doc alone |
| SQL | **Not written in C13-B** — owner DBA drafts with backup plan |
| Backup | Snapshot quote + project row fields before change |
| Scope | One artifact at a time — **no bulk SQL** |
| Verification | Re-fetch via `list-tenant-quotes`; confirm unlinked + archived |
| Order | Verify archived project → unlink → reset accepted fields if needed → archive quote |

---

## 9. Impact notes (if 2026-0099 and 2026-0100 are cleaned)

| Surface | Expected change |
|---------|-----------------|
| **Published This Month KPI** | −2 only if both were created in current UTC month; otherwise unchanged |
| **Quote Pipeline** | −2 rows (accepted test rows removed or archived) |
| **Seller Performance** | Seller-attributed count 4 → ~2; test seller rows may retain archived-only history (0097/0098) |
| **Owner / legacy** | Slight increase if quotes reclassified as archived owner-visible |
| **Linked project count** | 69 → 67 |
| **Total quoted** | Small decrease (two quote totals) |
| **Project Control (active)** | **No impact** — linked projects already archived and excluded from PCC |
| **Supervisor** | **No active impact** — projects not in supervisor portfolio |
| **Invoices / payments** | **No impact** — no invoices on these quotes |

**Bulk-cleaning 146 ready-to-send quotes would severely distort all KPIs — forbidden.**

---

## 10. Decision gate

| Step | Status |
|------|--------|
| **C13-A** | Read-only preflight — complete |
| **C13-B** | This docs-only policy + register — complete upon commit |
| **Cleanup execution** | **Not executed** — no archive, unlink, SQL, or API mutations |
| **C13-C** | Owner-only cleanup endpoint — requires explicit approval |
| **C13-D** | Owner one-off SQL — requires explicit approval + backup per artifact |
| **Supervisor shell / seller send E2E** | Do **not** start until owner either **accepts** pending artifacts (Option A) or **approves** cleanup path (Option B or C) |

---

## 11. C14-C / C14-D supervisor smoke artifacts (C14-C7 + C14-D2E register)

Step 3E-C14-C6 device read smoke and Step 3E-C14-D2B1/D2D device write smokes completed with temp devices revoked. The following **intentional** artifacts remain — default policy: **leave in place** (Option A).

| Artifact | Label / name | Status | Cleanup status | Notes |
|----------|--------------|--------|----------------|-------|
| C7B test supervisor membership | `mg-c7b-supervisor-001@marginguard.test` | active | **Open — keep** | Auth link completed (C14-C5B); display name Test Supervisor C7B |
| C7B Supabase Auth user | same email | exists | **Open — keep** | Linked via C14-C4a-b2 bootstrap fallback |
| Project Test A | client `Test A` | assigned to C7B | **Open — keep** | Only C7B-assigned test project; protected production projects unchanged |
| C14-C6 temp supervisor device | `C14-C6 Temp Supervisor Device C7B` | revoked | **Closed** | Read smoke; revoked in same run |
| C14-D2B1 temp supervisor device | `C14-D2B Temp Supervisor Device C7B` | revoked | **Closed** | API write smoke; revoked in same run |
| C14-D2D temp supervisor device | `C14-D2D Temp Supervisor Device C7B` | revoked | **Closed** | Full UI write smoke; revoked in same run |
| Project Test A smoke report (D2B) | note `C14-D2B smoke report` | on server | **Open — keep** | Created via D2B1 API-only device smoke |
| Project Test A smoke expense (D2B) | note `C14-D2B smoke expense` | on server | **Open — keep** | Created via D2B1 API-only device smoke |
| Project Test A day progress (D2B) | day 99 completed | on server | **Open — keep** | Created via D2B1 API-only device smoke |
| Project Test A smoke report (D2D) | note `C14-D2D UI smoke report` | on server | **Open — keep** | Created via D2D UI device smoke |
| Project Test A smoke expense (D2D) | note includes `C14-D2D UI smoke expense` | on server | **Open — keep** | Created via D2D UI device smoke; concept + note combined |

**Active temp supervisor devices remaining:** 0 (all C14-C6 / D2B1 / D2D temp devices revoked).

**Optional C14-D cleanup:** Owner may approve a dedicated step to delete Project Test A smoke report/expense/day-progress rows via owner `delete-project-report` / `delete-project-expense` and day-progress reopen — not covered by this policy doc alone.

**Do not bulk-remove** C7B membership, Auth user, or Project Test A assignment without explicit owner approval and a dedicated cleanup step. Protected production projects (Soco bathroom, 625 2nd St RENOVATION, Freemont H. R304, Sharon Bathroom) must never be touched by C14 cleanup.

---

## Related checkpoints

- `MARGIN_GUARD_CHECKPOINTS.md` — Step 3E-C14-D, Step 3E-C14-C, Step 3E-C12, and prior closed steps
- Step 3E-C13-A preflight report (conversation record, 2026-06-10)
- Step 3E-C14-C7 checkpoint close (conversation record, 2026-06-10)
- Step 3E-C14-D2E checkpoint close (conversation record, 2026-06-10)
