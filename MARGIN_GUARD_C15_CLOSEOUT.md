# Margin Guard™ Step 3E-C15-F — Internal Operational Readiness Closeout

Authoritative C15 internal readiness record before public beta planning.

**Recorded:** 2026-06-10  
**Production URL:** https://marginguardsystem.netlify.app  
**Latest C15 commit at closeout:** `6d7662f` (C15-D-FIX8)

---

## C15 track status

| Track | Status |
|-------|--------|
| C15-C Owner internal production | COMPLETE / APPROVED WITH GAPS |
| C15-D Seller internal production | COMPLETE / APPROVED |
| C15-E Supervisor re-verification | COMPLETE / APPROVED WITH GAPS (code audit; manual production sign-off recommended) |
| C15-F Operational readiness closeout | IN PROGRESS — this document |

---

## Supervisor financial / reporting boundary (approved policy)

This clarifies the Supervisor role boundary for internal pilots and public beta planning. It replaces ambiguous wording such as “read-only” vs “field writes deferred” with an explicit **field-execution vs owner-financial** split.

### Supervisor MAY see (field execution only)

Information required to manage the project in the field:

- reported days
- reported labor / progress
- completed / pending schedule days
- field reports
- indirect / unexpected project expenses submitted from the field

### Supervisor MUST NOT see (owner financials)

- contract total
- total revenue
- owner profit
- margin %
- business overhead allocation
- seller commission
- reserve
- invoice / payment controls
- balance due
- recommended / minimum selling price
- full owner financial detail

### Field controls — allowed scope

Labor, expense, and **View expenses** controls are acceptable **only** when they stay inside the field-reporting boundary:

| Control | Allowed meaning |
|---------|-----------------|
| **Labor** | Reported labor / days / progress only |
| **Expense** | Indirect / unexpected field expenses only |
| **View expenses** | Supervisor-visible field expenses only |

Supervisor can report field progress and indirect project expenses.  
Supervisor cannot see or manage owner financial performance.

### Pre-beta product decision (open)

Before public beta, decide whether labor / expense / view-expenses controls remain **active**, are **disabled**, or show **“coming soon.”** The boundary above is fixed regardless of that UX choice.

Implementation references (current production):

- Device project DTO: `mapRowToDeviceProject` in `get-supervisor-projects.js` — strips owner pricing and quote linkage
- Operational snapshot allowlist: `pickAllowlistedOperational` in `project-operational-snapshot.js` — field metrics only
- Device portal fetch guard: `public/js/supervisor-device-portal.js` — blocks financial-detail, invoice, payment, upsert, send, publish, and owner assignment APIs
- Assignment scope: `filterRowsAssignedToSupervisor` + `assertAssignedSupervisorProject` — assigned projects only

---

## Remaining C15 gaps before public beta

### Owner (C15-C)

- **GAP-01** — Manage Plan Stripe customer error
- **UI GAP-02** — Public estimate layout needs better horizontal organization
- **UI GAP-03** — Owner quote UI polish

### Seller (C15-D)

- **UI GAP-01** — Seller right summary panel repeats / duplicates on long scroll (if still present after FIX8 retest)

### Beta readiness (not started)

- Landing page
- Request beta access
- Manual approval workflow
- One contractor per USA state
- 14-day trial policy
- State tracking
- Onboarding checklist
- Support contact
- Terms / Privacy / Beta disclaimer
- Manual tenant creation
- Trial status active / suspended policy

---

## Approval gate

Do **not** open public beta without:

1. Librado manual sign-off on C15-E Supervisor production spot-check
2. Pre-beta decision on Supervisor field-control UX (active / disabled / coming soon)
3. Resolution or documented deferral of C15-C GAP-01 (Manage Plan Stripe)

---

*End of MARGIN_GUARD_C15_CLOSEOUT.md*
