# MG-200B — Project Intelligence Read API

**Version:** `mg-200b-v1`  
**Endpoint:** `GET /.netlify/functions/project-intelligence?project_id=<uuid>`  
**Auth:** Session cookie → tenant from session → active **owner or admin** membership only.  
Client must **not** send `tenant_id` (rejected `400 tenant_id_forbidden`).  
Seller / supervisor roles are intentionally excluded in V1 (`role_policy: owner_admin_only_v1`).

## Guarantees

- **Zero writes:** handler performs GET-style Supabase reads only — no INSERT / UPDATE / DELETE / UPSERT / write RPC / payment / invoice / project mutation
- Tenant resolved exclusively from authenticated session
- Project lookup requires `id` **and** authenticated `tenant_id` (same `404` for missing and cross-tenant)
- Facts are `TRUE` | `FALSE` | `UNKNOWN`
- Exactly one advisory `next_action` (never executed)
- OPTIONS/CORS: not implemented (same convention as `get-project-financial-detail`; non-GET → `405`)

## Response shape

```json
{
  "ok": true,
  "version": "mg-200b-v1",
  "project_id": "...",
  "tenant_id": "...",
  "generated_at": "...",
  "lifecycle": {
    "stage": "Project Opened",
    "state": "TRUE|FALSE|UNKNOWN",
    "confidence": "high|medium|low",
    "reason": "..."
  },
  "facts": {
    "DepositCollected": {
      "state": "UNKNOWN",
      "confidence": "low",
      "reason": "...",
      "source": "...",
      "timestamp": null
    }
  },
  "conflicts": [],
  "blockers": [],
  "next_action": {
    "code": "...",
    "label": "...",
    "module": "...",
    "deep_link": "/estimates-invoices"
  },
  "snapshots": { "commercial": {}, "contract": {}, "deposit": {}, "schedule": {}, "field": {}, "billing": {}, "warranty": {} },
  "sources": { "errors": [], "read_only": true, "role_policy": "owner_admin_only_v1" }
}
```

`tenant_id` is included for client debugging/audit alignment with other MG read APIs; a future UI may omit it from display without changing the contract.

Each fact includes: `state`, `confidence`, `reason`, `source`, `timestamp` (`null` when no durable event time).

## Policy freeze (Owner-approved)

- Deposit mandatory for production projects
- **`DepositWaived` V1:** always `FALSE` by policy — V1 has **no durable waiver mechanism**. Reason must not imply a table was searched and empty. Source: `policy:mg-200b-v1`
- `DepositSatisfied = DepositCollected OR DepositWaived`
- `DepositCollected` is **ledger-aligned** (`tenant_project_payments.payment_type=deposit` and amount > 0)
- Flags without ledger → `UNKNOWN` + conflict `deposit_flags_without_ledger` (next action: confirm recording in Invoice Hub — not “Collect”)
- Ledger without flags → `TRUE` + warning conflict
- Warranty starts at Substantial Completion (not Final Settled)
- Closed blocked if open balance > $0.01
- `ProjectScheduled` requires ScheduleDatesConfirmed ∧ CapacityReserved ∧ ContractReady ∧ DepositSatisfied
- Quote/project dates alone ≠ Scheduled

## Known V1 UNKNOWN limitations

| Fact | Why UNKNOWN |
|------|-------------|
| `ScheduleDatesConfirmed` | No durable schedule-confirmation flag |
| `CapacityReserved` | No durable per-project capacity reservation |
| `SubstantialCompletionReached` | No durable SC milestone; day-count heuristic is not authoritative |
| `WarrantyActivated` | Usually UNKNOWN until SC is durable |
| `ProjectScheduled` | Cascades from dates/capacity UNKNOWN |

## Money

- Contract total authority (first available): `schedule.contract_total` → `quote.total` → `project.sale_price` → `project.project_total`
- Open balance = max(0, contract − Σ ledger amounts) using **millicent** arithmetic
- FinalSettled TRUE iff open balance ≤ **$0.01**; **$0.011 is not settled**
- Missing contract total or ledger failure → FinalSettled / ProjectOpenBalance **UNKNOWN** (not a false zero)
- Material-cost invoices do not alter contract total
- Invoice payment_status flags cannot override ledger DepositCollected
- Schema limitation: payments have no `voided_at`; net amounts (including negative adjustments) are summed; voided/refunded rows are excluded only if amount/type signals them

## ContractReady

TRUE only when all TRUE:

- ContractPropertyReady
- ContractWarrantyReady
- ContractLegalNoticesReady
- PaymentPlanConfigured (confirmed + sum matches contract total)

## Three-state helpers

**AND:** any FALSE → FALSE; all TRUE → TRUE; else UNKNOWN  
**OR:** any TRUE → TRUE; all FALSE → FALSE; else UNKNOWN

## Lifecycle precedence (furthest proven)

Closed → Warranty Active → Final Settled → Substantial Completion → In Progress → Scheduled → Contract Ready → Deposit Collected → Project Opened → Quote Approved → Quote Sent → Quote Draft → Lead

- Does not skip a mandatory UNKNOWN gate (lifecycle `state` becomes UNKNOWN when the next gate is UNKNOWN)
- Progress billing is parallel and does not replace In Progress
- `completed` status alone ≠ Closed; FinalSettled alone ≠ Warranty Active; quote dates alone ≠ Scheduled

## Next action priority

1. Financial/deposit conflict (confirm Hub recording when UNKNOWN)
2. Contract readiness (complete vs review when UNKNOWN)
3. Schedule/capacity confirmation
4. Supervisor assignment
5. Field execution
6. Billing/collection
7. Substantial completion
8. Final settlement / closure

Deep links are internal routes only (`/contract-builder.html`, `/estimates-invoices`, `/project-control`, `/sales`, `/supervisor`).

## Reads per call (sequential)

1. `tenant_projects` (id + tenant_id)
2. `quotes` (optional if quote_id)
3. `project_contract_setups`
4. `project_contract_payment_schedules` (+ items if schedule exists)
5. `tenant_contract_legal_notices`
6. `invoices` (project_id; fallback quote_id)
7. `tenant_project_payments` (project_id; optional quote_id; optional invoice_id chunks of 40)
8. `tenant_project_day_progress`

Optional source failures mark `sources.errors` and yield UNKNOWN facts — response remains stable.

## Files

- `netlify/functions/project-intelligence.js`
- `netlify/functions/_lib/project-intelligence.js`
- `scripts/qa-mg200b-project-intelligence.js`
- `docs/MG-200B-PROJECT-INTELLIGENCE.md`

## Tests

```bash
node --check netlify/functions/project-intelligence.js
node --check netlify/functions/_lib/project-intelligence.js
node scripts/qa-mg200b-project-intelligence.js
```

No live Netlify HTTP smoke is claimed by the unit suite.
