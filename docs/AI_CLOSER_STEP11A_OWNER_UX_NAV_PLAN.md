# AI Closer Step 11A — Owner Navigation & UX Integration Plan

**Status:** Planning / documentation only. **No UI, navigation, sidebar, dashboard, backend, or schema changes.**

Related: [AI_CLOSER_STEP10H_PRELOAD_CONVERSION_STATUS_VERIFIED.md](./AI_CLOSER_STEP10H_PRELOAD_CONVERSION_STATUS_VERIFIED.md), [AI_CLOSER_STEP10G_PRELOAD_CONVERSION_STATUS.md](./AI_CLOSER_STEP10G_PRELOAD_CONVERSION_STATUS.md)

---

## 1. Purpose

Step 11A plans **where AI Closer should live inside the Margin Guard Owner experience** without changing production navigation yet.

- Planning only — no UI/nav/sidebar/dashboard changes.
- Goal: decide the **safest placement** for AI Closer inside the owner workflow.
- Existing standalone lab links remain unchanged for now.

---

## 2. Current verified AI Closer status

| Capability | Status |
|------------|--------|
| Client prequote submission | **Works** |
| Owner inbox | **Works** |
| Status actions | **Works** |
| Detail view | **Works** |
| Copy actions (email / summary) | **Works** |
| Draft quote backend creation | **Works** |
| Duplicate guard (idempotency) | **Works** |
| Guarded create UI | **Works** |
| Current-month date picker | **Works** |
| Preload conversion status | **Works** |
| Already-converted leads | Show `DRAFT CREATED`, block create controls early |

---

## 3. Current routes

| Flow | Route |
|------|-------|
| Client flow | `/ai-closer-client.html?tenant=three-colors-corp` |
| Lab settings | `/ai-closer-settings.html` |
| Owner inbox | `/ai-closer-owner.html` |

These remain reachable via existing lab links; no route is removed or renamed in Step 11A.

---

## 4. Recommended owner placement

Safest UX target (future implementation, not now):

| Element | Plan |
|---------|------|
| **Owner dashboard tile** | Card labeled **AI Closer Leads** |
| **Access** | Owner/admin only |
| **Link target** | `/ai-closer-owner.html` |
| **Seller / Supervisor** | **Not** exposed |
| **Public client flow** | **Not** placed there |
| **Sales page** | **Not** merged yet |
| **Official quote flow** | **Not** altered |

A dashboard card is preferred as the first navigation touchpoint because it is additive and low-risk versus editing shared sidebar/nav components.

---

## 5. Navigation safety options (phased)

| Option | Description | Risk | Recommendation |
|--------|-------------|------|----------------|
| **A** | Keep standalone lab links for now | Lowest | Current state |
| **B** | Add owner **dashboard card** later | Low — additive tile | **Recommended next nav step** |
| **C** | Add owner **sidebar item** later | Medium — shared nav component | After B is validated |
| **D** | Add **Business Settings** link for AI Closer settings | Low–medium | Optional, alongside B/C |

**Recommended safest next implementation:** Option **B** (dashboard/card link) before any sidebar changes.

---

## 6. Owner workflow (intended)

1. Client submits a starter prequote via AI Closer client flow.
2. Owner reviews the **AI Closer Inbox**.
3. Owner marks status (reviewed / good lead / needs site visit / bad budget / archived).
4. Owner reviews **details** for the lead.
5. Owner creates a **DRAFT quote only** after manual approvals (final price + checklist + confirmation).
6. Owner later decides whether to **edit / publish / send** through the existing official workflow (separate, unchanged).

---

## 7. Access rules

- **Owner/admin only**
- **Tenant-scoped** (membership tenant resolves all reads/writes)
- **Seller / Supervisor excluded**
- **Public client** can only submit prequotes
- **No internal pricing exposure** (cost, margin, overhead, labor rate)

---

## 8. Must-not-do list

- Do **not** auto-send quote
- Do **not** auto-publish
- Do **not** create invoice
- Do **not** request payment
- Do **not** email client
- Do **not** create `quote_items` / `quote_labor` automatically
- Do **not** bypass owner final price approval
- Do **not** touch existing working Owner/Sales workflows without explicit approval

---

## 9. Recommended next steps

| Step | Description |
|------|-------------|
| **11B** | Fresh unconverted prequote happy-path UI test |
| **11C** | Document happy-path verification |
| **11D** | Optional owner dashboard card plan |
| **11E** | Dashboard card implementation — only after owner approval |

---

## 10. Final recommendation

Do **Step 11B** (fresh unconverted lead happy-path UI test) **before** any navigation implementation.

A clean unconverted lead should verify the full owner UI create path (price + checklist + confirmation → `200` DRAFT create) before AI Closer is placed in main navigation. This confirms the happy path end-to-end, not just the duplicate-guard path already verified in Steps 10C/10H.

---

## Step 11A sign-off

- [x] Owner UX / navigation placement documented
- [x] Phased navigation options with recommendation (Option B first)
- [x] Access rules and must-not-do list captured
- [x] No production/nav/sidebar/dashboard code changes in Step 11A
- [ ] Step 11B happy-path UI test (recommended next)
