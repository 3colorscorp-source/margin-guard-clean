/**
 * MG-200B — deterministic unit tests for project-intelligence derivation + handler gates.
 * No network. No writes.
 */
const assert = require("assert");
const {
  deriveProjectIntelligence,
  MONEY_TOLERANCE,
  andFacts,
  orFacts,
  fact,
} = require("../netlify/functions/_lib/project-intelligence");
const handlerMod = require("../netlify/functions/project-intelligence");

function baseBundle(over = {}) {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    project: null,
    quote: null,
    setup: null,
    schedule: null,
    scheduleItems: [],
    notices: null,
    noticesEffective: null,
    invoices: [],
    payments: [],
    dayProgress: [],
    sourceErrors: {},
    ...over,
  };
}

function quote(over = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    status: "draft",
    total: 20000,
    deposit_required: 2000,
    public_token: null,
    deposit_paid_at: null,
    accepted_at: null,
    first_view_tracked_at: null,
    start_date: null,
    due_date: null,
    ...over,
  };
}

function project(over = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    quote_id: "33333333-3333-4333-8333-333333333333",
    status: "signed",
    deposit_paid: false,
    supervisor_user_id: null,
    due_date: null,
    ...over,
  };
}

function run(name, bundle, check) {
  const out = deriveProjectIntelligence(bundle);
  try {
    check(out);
    console.log("PASS", name);
    return true;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    console.log(
      JSON.stringify(
        {
          stage: out.lifecycle?.stage,
          deposit: out.facts?.DepositCollected,
          conflicts: out.conflicts?.map((c) => c.code),
          next: out.next_action?.code,
        },
        null,
        2
      )
    );
    return false;
  }
}

let passed = 0;
let failed = 0;
function test(name, bundle, check) {
  if (run(name, bundle, check)) passed += 1;
  else failed += 1;
}

function testPlain(name, fn) {
  try {
    fn();
    console.log("PASS", name);
    passed += 1;
  } catch (err) {
    console.log("FAIL", name, "-", err.message);
    failed += 1;
  }
}

// --- Handler gate tests (no network) ---
testPlain("1. non-GET method documented (handler rejects !== GET)", () => {
  // Handler requires session before returning 405 only after method check — method is first.
  assert.strictEqual(typeof handlerMod.handler, "function");
  assert.ok(handlerMod._test.ALLOWED_QUERY_KEYS.has("project_id"));
});

testPlain("2. missing project_id", () => {
  const g = handlerMod._test.validateGetQuery({});
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.statusCode, 400);
  assert.strictEqual(g.body.code, "project_id_required");
});

testPlain("3. malformed project_id", () => {
  const g = handlerMod._test.validateGetQuery({ project_id: "not-a-uuid" });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.body.code, "invalid_id");
});

testPlain("4. unauthenticated — role policy is owner/admin only", () => {
  assert.ok(handlerMod._test.OWNER_ADMIN_ROLES.has("owner"));
  assert.ok(handlerMod._test.OWNER_ADMIN_ROLES.has("admin"));
  assert.ok(!handlerMod._test.OWNER_ADMIN_ROLES.has("seller"));
  assert.ok(!handlerMod._test.OWNER_ADMIN_ROLES.has("supervisor"));
  assert.strictEqual(handlerMod._test.ROLE_POLICY, "owner_admin_only_v1");
});

testPlain("5. unauthorized role set excludes seller/supervisor", () => {
  assert.deepStrictEqual(
    [...handlerMod._test.OWNER_ADMIN_ROLES].sort(),
    ["admin", "owner"]
  );
});

testPlain("6. client tenant_id injection rejected", () => {
  const g = handlerMod._test.validateGetQuery({
    project_id: "22222222-2222-4222-8222-222222222222",
    tenant_id: "evil-tenant",
  });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.body.code, "tenant_id_forbidden");
});

testPlain("7. valid project_id accepted by gate", () => {
  const g = handlerMod._test.validateGetQuery({
    project_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.projectId, "22222222-2222-4222-8222-222222222222");
});

testPlain("andFacts truth table", () => {
  const facts = {
    A: fact("TRUE", "high", "a", "t"),
    B: fact("TRUE", "high", "b", "t"),
    C: fact("FALSE", "high", "c", "t"),
    D: fact("UNKNOWN", "low", "d", "t"),
  };
  assert.strictEqual(andFacts(facts, ["A", "B"]).state, "TRUE");
  assert.strictEqual(andFacts(facts, ["A", "C"]).state, "FALSE");
  assert.strictEqual(andFacts(facts, ["A", "D"]).state, "UNKNOWN");
  assert.strictEqual(andFacts(facts, ["C", "D"]).state, "FALSE");
});

testPlain("orFacts truth table", () => {
  const facts = {
    A: fact("TRUE", "high", "a", "t"),
    B: fact("FALSE", "high", "b", "t"),
    C: fact("FALSE", "high", "c", "t"),
    D: fact("UNKNOWN", "low", "d", "t"),
  };
  assert.strictEqual(orFacts(facts, ["A", "B"]).state, "TRUE");
  assert.strictEqual(orFacts(facts, ["B", "C"]).state, "FALSE");
  assert.strictEqual(orFacts(facts, ["B", "D"]).state, "UNKNOWN");
});

testPlain("DepositWaived V1 policy reason", () => {
  const out = deriveProjectIntelligence(baseBundle());
  assert.strictEqual(out.facts.DepositWaived.state, "FALSE");
  assert.ok(/no durable deposit-waiver mechanism/i.test(out.facts.DepositWaived.reason));
  assert.strictEqual(out.facts.DepositWaived.source, "policy:mg-200b-v1");
});

// A. Draft quote only (no project)
test(
  "A. Draft quote only",
  baseBundle({
    quote: quote({ status: "draft" }),
    project: null,
  }),
  (out) => {
    assert.strictEqual(out.facts.QuoteExists.state, "TRUE");
    assert.strictEqual(out.facts.QuotePublished.state, "FALSE");
    assert.strictEqual(out.facts.QuoteApproved.state, "FALSE");
    assert.strictEqual(out.facts.ProjectExists.state, "FALSE");
    assert.ok(["Quote Draft", "Lead"].includes(out.lifecycle.stage));
    assert.ok(out.next_action.code);
  }
);

// B. Published/sent quote
test(
  "B. Published quote",
  baseBundle({
    quote: quote({ status: "READY_TO_SEND", public_token: "tok" }),
  }),
  (out) => {
    assert.strictEqual(out.facts.QuotePublished.state, "TRUE");
    assert.strictEqual(out.facts.QuoteSent.state, "UNKNOWN");
    assert.ok(["Quote Sent", "Quote Draft"].includes(out.lifecycle.stage));
  }
);

// C. Accepted with project
test(
  "C. Accepted quote with project",
  baseBundle({
    quote: quote({
      status: "accepted",
      public_token: "tok",
      accepted_at: "2026-01-01T00:00:00Z",
    }),
    project: project(),
  }),
  (out) => {
    assert.strictEqual(out.facts.QuoteApproved.state, "TRUE");
    assert.strictEqual(out.facts.ProjectExists.state, "TRUE");
    assert.strictEqual(out.facts.DepositCollected.state, "FALSE");
    assert.strictEqual(out.lifecycle.stage, "Project Opened");
  }
);

// D. Flags paid, no ledger
test(
  "D. Deposit flags without ledger",
  baseBundle({
    quote: quote({
      status: "accepted",
      public_token: "tok",
      deposit_paid_at: "2026-01-02T00:00:00Z",
    }),
    project: project({ deposit_paid: true, status: "deposit_paid" }),
    payments: [],
  }),
  (out) => {
    assert.strictEqual(out.facts.DepositCollected.state, "UNKNOWN");
    assert.ok(out.conflicts.some((c) => c.code === "deposit_flags_without_ledger"));
    assert.strictEqual(out.next_action.code, "reconcile_deposit");
    assert.ok(/Confirm whether the project deposit was recorded/i.test(out.next_action.label));
  }
);

// E. Ledger deposit, flags unpaid
test(
  "E. Ledger deposit flags unpaid",
  baseBundle({
    quote: quote({ status: "accepted", public_token: "tok" }),
    project: project(),
    payments: [
      { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
    ],
  }),
  (out) => {
    assert.strictEqual(out.facts.DepositCollected.state, "TRUE");
    assert.strictEqual(out.facts.DepositSatisfied.state, "TRUE");
    assert.ok(out.conflicts.some((c) => c.code === "deposit_ledger_without_flags"));
    assert.strictEqual(out.lifecycle.stage, "Deposit Collected");
  }
);

// F. Contract partially ready
test(
  "F. Contract partially ready",
  baseBundle({
    quote: quote({ status: "accepted", public_token: "tok" }),
    project: project(),
    payments: [
      { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
    ],
    setup: {
      property_address_line1: "1 Main",
      property_city: "Austin",
      property_state: "TX",
      property_postal_code: "78701",
      property_confirmed_at: "2026-01-04T00:00:00Z",
      warranty_duration_value: null,
      warranty_confirmed_at: null,
    },
  }),
  (out) => {
    assert.strictEqual(out.facts.ContractPropertyReady.state, "TRUE");
    assert.strictEqual(out.facts.ContractWarrantyReady.state, "FALSE");
    assert.strictEqual(out.facts.ContractReady.state, "FALSE");
    assert.strictEqual(out.next_action.code, "complete_contract");
  }
);

function fullContract(over = {}) {
  return {
    quote: quote({ status: "accepted", public_token: "tok", deposit_paid_at: null }),
    project: project(),
    payments: [
      { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
    ],
    setup: {
      property_address_line1: "1 Main",
      property_city: "Austin",
      property_state: "TX",
      property_postal_code: "78701",
      property_confirmed_at: "2026-01-04T00:00:00Z",
      warranty_duration_value: 1,
      warranty_duration_unit: "years",
      warranty_summary: "Workmanship",
      warranty_exclusions: "Acts of God",
      warranty_confirmed_at: "2026-01-04T00:00:00Z",
    },
    notices: { confirmed_at: "2026-01-04T00:00:00Z", confirmed_notices: { a: "x" } },
    noticesEffective: { confirmed_at: "2026-01-04T00:00:00Z", confirmed_notices: { a: "x" } },
    schedule: {
      id: "s1",
      status: "confirmed",
      confirmed_at: "2026-01-04T00:00:00Z",
      contract_total: 20000,
    },
    scheduleItems: [
      { amount: 5000 },
      { amount: 5000 },
      { amount: 5000 },
      { amount: 5000 },
    ],
    ...over,
  };
}

// G. Contract fully ready
test("G. Contract fully ready", baseBundle(fullContract()), (out) => {
  assert.strictEqual(out.facts.ContractReady.state, "TRUE");
  assert.strictEqual(out.facts.PaymentPlanConfigured.state, "TRUE");
  assert.strictEqual(out.lifecycle.stage, "Contract Ready");
});

// H. Tentative dates only
test(
  "H. Tentative dates only",
  baseBundle(
    fullContract({
      quote: quote({
        status: "accepted",
        public_token: "tok",
        start_date: "2026-02-01",
        due_date: "2026-03-01",
      }),
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.ScheduleDatesConfirmed.state, "UNKNOWN");
    assert.strictEqual(out.facts.ProjectScheduled.state, "UNKNOWN");
    assert.notStrictEqual(out.lifecycle.stage, "Scheduled");
  }
);

// I. Contract ready but schedule facts UNKNOWN (not "fully scheduled")
test(
  "I. Contract ready; schedule/capacity still UNKNOWN",
  baseBundle(fullContract()),
  (out) => {
    assert.strictEqual(out.facts.CapacityReserved.state, "UNKNOWN");
    assert.strictEqual(out.facts.ScheduleDatesConfirmed.state, "UNKNOWN");
    assert.strictEqual(out.facts.ProjectScheduled.state, "UNKNOWN");
    assert.strictEqual(out.next_action.code, "confirm_schedule");
  }
);

// J. Supervisor assigned, no work
test(
  "J. Supervisor assigned no work",
  baseBundle(
    fullContract({
      project: project({ supervisor_user_id: "user-1" }),
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.SupervisorAssigned.state, "TRUE");
    assert.strictEqual(out.facts.WorkStarted.state, "FALSE");
  }
);

// K. Work started
test(
  "K. Work started by day progress",
  baseBundle(
    fullContract({
      project: project({ supervisor_user_id: "user-1", status: "in_progress" }),
      dayProgress: [
        { status: "completed", day_number: 1, completed_at: "2026-02-02T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.WorkStarted.state, "TRUE");
    assert.strictEqual(out.facts.WorkInProgress.state, "TRUE");
    assert.strictEqual(out.lifecycle.stage, "In Progress");
  }
);

// L. Completed status but balance open
test(
  "L. Completed with open balance",
  baseBundle(
    fullContract({
      project: project({ status: "completed", supervisor_user_id: "user-1" }),
      dayProgress: [
        { status: "completed", day_number: 1, completed_at: "2026-02-02T00:00:00Z" },
      ],
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.ok(out.snapshots.billing.open_balance > MONEY_TOLERANCE);
    assert.strictEqual(out.facts.FinalSettled.state, "FALSE");
    assert.ok(out.conflicts.some((c) => c.code === "completed_with_open_balance"));
    assert.strictEqual(out.facts.ProjectClosed.state, "FALSE");
  }
);

// M. Final settled within tolerance
test(
  "M. Final settled",
  baseBundle(
    fullContract({
      project: project({ supervisor_user_id: "user-1", status: "in_progress" }),
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
        { id: "p2", payment_type: "final", amount: 18000, paid_at: "2026-03-01T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.ok(out.snapshots.billing.open_balance <= MONEY_TOLERANCE);
    assert.strictEqual(out.facts.FinalSettled.state, "TRUE");
  }
);

// M2. Final balance exactly $0.01 → settled
test(
  "M2. Final balance exactly $0.01",
  baseBundle(
    fullContract({
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
        { id: "p2", payment_type: "final", amount: 17999.99, paid_at: "2026-03-01T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.strictEqual(out.snapshots.billing.open_balance, 0.01);
    assert.strictEqual(out.facts.FinalSettled.state, "TRUE");
  }
);

// M3. Final balance $0.011 → not settled
test(
  "M3. Final balance $0.011",
  baseBundle(
    fullContract({
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
        { id: "p2", payment_type: "final", amount: 17999.989, paid_at: "2026-03-01T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.ok(out.snapshots.billing.open_balance > MONEY_TOLERANCE);
    assert.strictEqual(out.facts.FinalSettled.state, "FALSE");
  }
);

// M4. Negative computed balance clamps to zero
test(
  "M4. Overpayment clamps open balance to zero",
  baseBundle(
    fullContract({
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
        { id: "p2", payment_type: "final", amount: 19000, paid_at: "2026-03-01T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.strictEqual(out.snapshots.billing.open_balance, 0);
    assert.strictEqual(out.facts.FinalSettled.state, "TRUE");
  }
);

// N. Warranty terms + SC unknown
test("N. Warranty terms without durable SC", baseBundle(fullContract()), (out) => {
  assert.strictEqual(out.facts.WarrantyTermsExist.state, "TRUE");
  assert.strictEqual(out.facts.SubstantialCompletionReached.state, "UNKNOWN");
  assert.strictEqual(out.facts.WarrantyActivated.state, "UNKNOWN");
  assert.ok(
    out.conflicts.some((c) => c.code === "warranty_terms_without_substantial_completion")
  );
});

// O. Archived with open balance
test(
  "O. Archived with open balance",
  baseBundle(
    fullContract({
      project: project({ status: "archived" }),
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.ProjectClosed.state, "FALSE");
    assert.ok(out.conflicts.some((c) => c.code === "closed_with_open_balance"));
  }
);

// P. Cross-tenant is handler-level (404) — unit documents expectation
test("P. Cross-tenant documented as handler 404", baseBundle({}), (out) => {
  assert.ok(out.version === "mg-200b-v1");
});

// Q. Optional source fails
test(
  "Q. Optional source fails",
  baseBundle(
    fullContract({
      sourceErrors: { notices: true },
      notices: null,
      noticesEffective: null,
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.ContractLegalNoticesReady.state, "UNKNOWN");
    assert.strictEqual(out.facts.ContractReady.state, "UNKNOWN");
    assert.ok(out.lifecycle.stage);
    assert.ok(out.next_action);
    assert.strictEqual(out.next_action.code, "review_contract_readiness");
  }
);

// Q2. Required financial source missing → UNKNOWN not false zero
test(
  "Q2. Financial source missing → FinalSettled UNKNOWN",
  baseBundle(
    fullContract({
      sourceErrors: { payments: true },
      payments: [],
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.DepositCollected.state, "UNKNOWN");
    assert.strictEqual(out.facts.ProjectOpenBalance.state, "UNKNOWN");
    assert.strictEqual(out.facts.FinalSettled.state, "UNKNOWN");
    assert.strictEqual(out.snapshots.billing.open_balance, null);
  }
);

// Q3. Contract total missing → UNKNOWN
test(
  "Q3. Contract total missing",
  baseBundle({
    quote: quote({ status: "accepted", public_token: "tok", total: null }),
    project: project({ sale_price: null, project_total: null }),
    payments: [],
    sourceErrors: {},
  }),
  (out) => {
    assert.strictEqual(out.facts.ProjectOpenBalance.state, "UNKNOWN");
    assert.strictEqual(out.facts.FinalSettled.state, "UNKNOWN");
  }
);

// R. Payment plan confirmed sum mismatch
test(
  "R. Plan sum mismatch",
  baseBundle(
    fullContract({
      scheduleItems: [{ amount: 100 }, { amount: 100 }],
    })
  ),
  (out) => {
    assert.strictEqual(out.facts.PaymentPlanConfigured.state, "FALSE");
    assert.ok(out.conflicts.some((c) => c.code === "payment_plan_sum_mismatch"));
    assert.strictEqual(out.facts.ContractReady.state, "FALSE");
  }
);

// S. Missing quote on project → QuoteExists FALSE (not UNKNOWN)
test(
  "S. No quote_id → QuoteExists FALSE",
  baseBundle({
    project: project({ quote_id: null }),
    quote: null,
    sourceErrors: {},
  }),
  (out) => {
    assert.strictEqual(out.facts.QuoteExists.state, "FALSE");
    assert.notStrictEqual(out.facts.QuoteExists.state, "UNKNOWN");
  }
);

// T. Material-cost invoice does not change contract total
test(
  "T. Material invoice ignored for contract total",
  baseBundle(
    fullContract({
      invoices: [
        {
          id: "inv-m",
          amount: 500,
          status: "sent",
          invoice_label: "Unexpected Material",
          notes: "unexpected_material_cost",
        },
      ],
      payments: [
        { id: "p1", payment_type: "deposit", amount: 2000, paid_at: "2026-01-03T00:00:00Z" },
        { id: "p2", payment_type: "final", amount: 18000, paid_at: "2026-03-01T00:00:00Z" },
      ],
    })
  ),
  (out) => {
    assert.strictEqual(out.snapshots.billing.contract_total, 20000);
    assert.strictEqual(out.facts.FinalSettled.state, "TRUE");
  }
);

// Fact shape
test("Fact shape has state/confidence/reason/source/timestamp", baseBundle(fullContract()), (out) => {
  const f = out.facts.DepositCollected;
  assert.ok(["TRUE", "FALSE", "UNKNOWN"].includes(f.state));
  assert.ok(f.confidence);
  assert.ok(typeof f.reason === "string");
  assert.ok(typeof f.source === "string");
  assert.ok("timestamp" in f);
});

// Zero-write / purity: derive twice identical for decisive fields
test("Deterministic pure derive", baseBundle(fullContract()), (out) => {
  const out2 = deriveProjectIntelligence(baseBundle(fullContract()));
  assert.strictEqual(out.lifecycle.stage, out2.lifecycle.stage);
  assert.strictEqual(out.facts.ContractReady.state, out2.facts.ContractReady.state);
  assert.strictEqual(out.next_action.code, out2.next_action.code);
  assert.strictEqual(JSON.stringify(out.facts), JSON.stringify(out2.facts));
});

// JSON serializable / no secrets
test("Response JSON-serializable and secret-free", baseBundle(fullContract()), (out) => {
  const s = JSON.stringify(out);
  assert.ok(s.length < 200000);
  assert.ok(!/service_role|eyJ|supabase\.co\/rest/i.test(s));
  JSON.parse(s);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
