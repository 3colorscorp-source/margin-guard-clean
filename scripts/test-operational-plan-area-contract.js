/**
 * Area identity contract. No database, no network, no git, no publish.
 * node scripts/test-operational-plan-area-contract.js
 *
 * Seller Shield runs this through scripts/test-labor-area-breakdown.js,
 * which scripts/test-voice-operational-plan-phase1.js calls once.
 */

const assert = require("assert");
const {
  resolveTemporaryAreaRefs,
  applyAuthorizedAreaCatalog,
} = require("../netlify/functions/_lib/operational-plan-area-contract");
const {
  normalizeOperationalPlan,
  normalizeOperationalPlanWithAreaCatalog,
} = require("../netlify/functions/_lib/operational-plan");
const voice = require("../netlify/functions/_lib/voice-operational-plan");

const FROZEN_CREW_DAY = {
  day_number: 1,
  phase: "Prep",
  workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }],
};

function frozenCrewDay(dayNumber) {
  return {
    day_number: dayNumber,
    phase: "Prep",
    workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }],
  };
}

function runOperationalPlanAreaContractTests() {
  let passed = 0;
  function test(name, fn) {
    fn();
    passed += 1;
    console.log("ok " + name);
  }
  console.log("scripts/test-operational-plan-area-contract.js");

const KITCHEN = "8f3c2a10-6b1e-4d77-9a2c-1c0e5b7a4d11";
const MASTER = "b71e90aa-2c44-4f18-8d55-66a0c9e13f20";

function idsInOrder(ids) {
  const queue = ids.slice();
  return function createId() {
    const next = queue.shift();
    if (!next) throw new Error("unexpected id mint");
    return next;
  };
}

function crewDay(dayNumber, extra) {
  return Object.assign(
    {
      day_number: dayNumber,
      phase: "Prep",
      workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }],
    },
    extra || {}
  );
}

test("temporary refs remap atomically and keep an existing uuid", () => {
  const resolved = resolveTemporaryAreaRefs(
    {
      areas: [
        { area_ref: "area_1", area_id: KITCHEN, name: "Kitchen Backsplash", scope: "Prep.", sort_order: 0 },
        { area_ref: "area_2", name: "Master Bathroom", scope: "Tile.", sort_order: 1 },
      ],
      days: [
        { day_number: 1, area_ref: "area_1", client_scope: "Prep." },
        { day_number: 2, area_ref: "area_2", client_scope: "Waterproofing." },
        { day_number: 3, area_ref: "area_2", client_scope: "Install." },
      ],
    },
    { createId: idsInOrder([MASTER]) }
  );
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.areas[0].id, KITCHEN);
  assert.strictEqual(resolved.areas[1].id, MASTER);
  assert.strictEqual(resolved.days[1].area_id, MASTER);
  assert.strictEqual(resolved.days[2].area_id, MASTER);
  assert.ok(!JSON.stringify(resolved).includes("area_ref"));
  assert.ok(!JSON.stringify(resolved).includes("area_1"));
});

test("same area name is allowed when the refs differ", () => {
  const resolved = resolveTemporaryAreaRefs(
    {
      areas: [
        { area_ref: "area_1", name: "Bathroom", scope: "Master", sort_order: 0 },
        { area_ref: "area_2", name: "Bathroom", scope: "Kids", sort_order: 1 },
      ],
      days: [
        { day_number: 1, area_ref: "area_1" },
        { day_number: 2, area_ref: "area_2" },
      ],
    },
    { createId: idsInOrder([KITCHEN, MASTER]) }
  );
  assert.strictEqual(resolved.ok, true);
  assert.notStrictEqual(resolved.areas[0].id, resolved.areas[1].id);
  assert.notStrictEqual(resolved.days[0].area_id, resolved.days[1].area_id);
});

test("a broken ref fails the whole contract", () => {
  const resolved = resolveTemporaryAreaRefs({
    areas: [
      { area_ref: "area_1", area_id: KITCHEN, name: "Kitchen Backsplash", scope: "Prep.", sort_order: 0 },
    ],
    days: [
      { day_number: 1, area_ref: "area_1" },
      { day_number: 2, area_ref: "area_9" },
    ],
  });
  assert.strictEqual(resolved.ok, false);
  assert.strictEqual(resolved.code, "orphan_day_area");
  assert.strictEqual(resolved.areas, undefined);
  assert.strictEqual(resolved.days, undefined);
});

test("duplicate ref, invalid uuid, and money keys fail closed", () => {
  const duplicate = resolveTemporaryAreaRefs({
    areas: [
      { area_ref: "area_1", name: "Kitchen", scope: "", sort_order: 0 },
      { area_ref: "area_1", name: "Master", scope: "", sort_order: 1 },
    ],
    days: [],
  });
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.code, "duplicate_area_ref");

  const badId = resolveTemporaryAreaRefs({
    areas: [{ area_ref: "area_1", area_id: "not-a-uuid", name: "Kitchen", scope: "", sort_order: 0 }],
    days: [{ day_number: 1, area_ref: "area_1" }],
  });
  assert.strictEqual(badId.ok, false);
  assert.strictEqual(badId.code, "invalid_area_id");

  const money = resolveTemporaryAreaRefs({
    areas: [{ area_ref: "area_1", name: "Kitchen", scope: "", sort_order: 0, sell_cents: 100 }],
    days: [{ day_number: 1, area_ref: "area_1" }],
  });
  assert.strictEqual(money.ok, false);
  assert.strictEqual(money.code, "invalid_area_contract");
});

test("default operational plan strips a smuggled area_id", () => {
  const plan = normalizeOperationalPlan({
    areas: [{ id: KITCHEN, name: "Kitchen Backsplash" }],
    days: [crewDay(1, { area_id: KITCHEN, area_ref: "area_1" })],
  });
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plan[0], "area_id"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plan[0], "area_ref"), false);
  assert.deepStrictEqual(Object.keys(plan[0]).sort(), ["day_number", "phase", "workers"]);
});

test("authorized catalog keeps only its own uuid", () => {
  const result = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_id: KITCHEN }), crewDay(2, { area_id: MASTER }), crewDay(3, { area_id: MASTER })],
    [
      { id: KITCHEN, name: "Kitchen Backsplash" },
      { id: MASTER, name: "Master Bathroom" },
    ]
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.plan[0].area_id, KITCHEN);
  assert.strictEqual(result.plan[1].area_id, MASTER);
  assert.strictEqual(result.plan[2].area_id, MASTER);
});

test("catalog rejects an unknown uuid and an unresolved ref", () => {
  const unknown = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_id: KITCHEN })],
    [{ id: MASTER }]
  );
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.code, "area_not_in_catalog");
  assert.strictEqual(unknown.plan, undefined);

  const unresolved = applyAuthorizedAreaCatalog(
    [crewDay(1, { area_ref: "area_1", area_id: KITCHEN })],
    [{ id: KITCHEN }]
  );
  assert.strictEqual(unresolved.ok, false);
  assert.strictEqual(unresolved.code, "unresolved_area_ref");
});

test("an area may exist before any day uses it", () => {
  const resolved = resolveTemporaryAreaRefs(
    {
      areas: [{ area_ref: "area_1", area_id: KITCHEN, name: "Kitchen Backsplash", scope: "", sort_order: 0 }],
      days: [],
    }
  );
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.areas[0].id, KITCHEN);
  assert.deepStrictEqual(resolved.days, []);
});

test("a day without a ref fails when the catalog is not empty", () => {
  const resolved = resolveTemporaryAreaRefs({
    areas: [{ area_ref: "area_1", area_id: KITCHEN, name: "Kitchen Backsplash", scope: "", sort_order: 0 }],
    days: [{ day_number: 1 }, { day_number: 2, area_ref: "area_1" }],
  });
  assert.strictEqual(resolved.ok, false);
  assert.strictEqual(resolved.code, "orphan_day_area");
  assert.strictEqual(resolved.days, undefined);
});

test("empty catalog does not invent area ids", () => {
  const result = normalizeOperationalPlanWithAreaCatalog([crewDay(1)], []);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.plan[0], "area_id"), false);
});

test("a smuggled catalog is not authorization", () => {
  const smuggled = normalizeOperationalPlanWithAreaCatalog({
    areas: [{ id: KITCHEN, name: "Kitchen Backsplash" }],
    days: [crewDay(1, { area_id: KITCHEN })],
  });
  assert.strictEqual(smuggled.ok, false);
  assert.strictEqual(smuggled.code, "area_catalog_required");
  assert.strictEqual(smuggled.plan, undefined);

  const empty = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_id: KITCHEN })],
    []
  );
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.code, "area_not_in_catalog");
  assert.strictEqual(empty.plan, undefined);
});

function assertNoAreaRef(value) {
  const json = JSON.stringify(value);
  assert.strictEqual(json.includes("area_ref"), false);
  assert.strictEqual(json.includes('"area_id":null'), false);
}

function assertLegacyDocument(value) {
  assertNoAreaRef(value);
  assert.strictEqual(JSON.stringify(value).includes('"areas"'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(value, "areas"), false);
}

test("legacy normalize matches the frozen crew shape", () => {
  const clean = [frozenCrewDay(1), frozenCrewDay(2)];
  assert.deepStrictEqual(normalizeOperationalPlan([crewDay(1), crewDay(2)]), clean);
  const strippedSamples = [
    {
      days: [crewDay(1, { area_id: KITCHEN, area_ref: "area_1" })],
      areas: [{ id: KITCHEN, name: "Kitchen Backsplash" }],
    },
    {
      operational_plan: [crewDay(1, { area_id: null, price: 80, sell_cents: 1 })],
      areas: [],
    },
    {
      plan: [crewDay(1, { area_id: null })],
      areas: [],
    },
  ];
  for (const sample of strippedSamples) {
    const current = normalizeOperationalPlan(sample);
    assert.deepStrictEqual(current, [FROZEN_CREW_DAY]);
    assert.ok(Array.isArray(current));
    assertLegacyDocument(current);
    assert.deepStrictEqual(Object.keys(current[0]).sort(), ["day_number", "phase", "workers"]);
    assert.strictEqual(current[0].area_id, undefined);
  }
});

test("injected generator is the only new uuid and shared refs stay equal", () => {
  let calls = 0;
  const resolved = resolveTemporaryAreaRefs(
    {
      areas: [
        { area_ref: "area_1", area_id: KITCHEN, name: "Kitchen Backsplash", scope: "", sort_order: 0 },
        { area_ref: "area_2", name: "Master Bathroom", scope: "", sort_order: 1 },
      ],
      days: [
        { day_number: 2, area_ref: "area_2" },
        { day_number: 3, area_ref: "area_2" },
      ],
    },
    {
      createId: function createId() {
        calls += 1;
        return MASTER;
      },
    }
  );
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(calls, 1);
  assert.strictEqual(resolved.areas[0].id, KITCHEN);
  assert.strictEqual(resolved.areas[1].id, MASTER);
  assert.strictEqual(resolved.days[0].area_id, resolved.days[1].area_id);
  assert.strictEqual(resolved.days[0].area_id, MASTER);
  assertNoAreaRef(resolved);
});

test("a valid uuid is kept only when the catalog contains it", () => {
  const kept = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_id: KITCHEN })],
    [{ id: KITCHEN }]
  );
  assert.strictEqual(kept.ok, true);
  assert.strictEqual(kept.plan[0].area_id, KITCHEN);
  assertLegacyDocument(kept.plan);
  assert.strictEqual(typeof kept.plan[0].area_id, "string");

  const rejected = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_id: KITCHEN })],
    [{ id: MASTER }]
  );
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.plan, undefined);
  assert.strictEqual(rejected.days, undefined);
});

test("invalid, missing, and unresolved area identity fail with no plan", () => {
  const invalid = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_id: "not-a-uuid" })],
    [{ id: KITCHEN }]
  );
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.plan, undefined);

  const missing = normalizeOperationalPlanWithAreaCatalog([crewDay(1)], [{ id: KITCHEN }]);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, "area_not_in_catalog");
  assert.strictEqual(missing.plan, undefined);

  const unresolved = normalizeOperationalPlanWithAreaCatalog(
    [crewDay(1, { area_ref: "area_1", area_id: KITCHEN })],
    [{ id: KITCHEN }]
  );
  assert.strictEqual(unresolved.ok, false);
  assert.strictEqual(unresolved.code, "unresolved_area_ref");
  assert.strictEqual(unresolved.plan, undefined);
});

test("duplicate ref returns no partial areas or days", () => {
  const duplicate = resolveTemporaryAreaRefs({
    areas: [
      { area_ref: "area_1", name: "Kitchen", scope: "", sort_order: 0 },
      { area_ref: "area_1", name: "Master", scope: "", sort_order: 1 },
    ],
    days: [{ day_number: 1, area_ref: "area_1" }],
  });
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.areas, undefined);
  assert.strictEqual(duplicate.days, undefined);
});

test("money fields from a browser or model are rejected", () => {
  const keys = ["sell_subtotal", "sell_cents", "subtotal", "price", "total", "cost", "rate", "margin"];
  for (const key of keys) {
    const area = { area_ref: "area_1", name: "Kitchen", scope: "", sort_order: 0 };
    area[key] = 100;
    const rejected = resolveTemporaryAreaRefs({
      areas: [area],
      days: [{ day_number: 1, area_ref: "area_1" }],
    });
    assert.strictEqual(rejected.ok, false, key);
    assert.strictEqual(rejected.areas, undefined);
    assert.strictEqual(rejected.days, undefined);
  }

  const dayMoney = resolveTemporaryAreaRefs({
    areas: [{ area_ref: "area_1", area_id: KITCHEN, name: "Kitchen", scope: "", sort_order: 0 }],
    days: [{ day_number: 1, area_ref: "area_1", price: 80 }],
  });
  assert.strictEqual(dayMoney.ok, false);
  assert.strictEqual(dayMoney.days, undefined);

  const workerMoney = resolveTemporaryAreaRefs({
    areas: [{ area_ref: "area_1", area_id: KITCHEN, name: "Kitchen", scope: "", sort_order: 0 }],
    days: [{ day_number: 1, area_ref: "area_1", workers: [{ role: "Installer", rate: 40 }] }],
  });
  assert.strictEqual(workerMoney.ok, false);
  assert.strictEqual(workerMoney.plan, undefined);
});

test("voice document and legacy projection drop area identity", () => {
  const doc = voice.normalizeDocument({
    schema_version: 1,
    source: "keyboard",
    days: [
      {
        day_number: 1,
        area_id: KITCHEN,
        area_ref: "area_1",
        client_scope: "Prep.",
        worker_assignments: [
          { worker_role: "Installer", worker_type: "pro", worker_count: 1, hours_per_worker: 8 },
        ],
      },
    ],
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(doc.days[0], "area_id"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(doc.days[0], "area_ref"), false);
  const legacy = voice.deriveLegacyOperationalPlan({
    days: [
      {
        day_number: 1,
        area_id: KITCHEN,
        client_scope: "Prep.",
        worker_assignments: [
          { worker_role: "Installer", worker_type: "pro", worker_count: 1, hours_per_worker: 8 },
        ],
      },
    ],
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(legacy[0], "area_id"), false);

  const cleanVoiceDay = {
    day_number: 1,
    client_scope: "Prep.",
    worker_assignments: [
      { worker_role: "Installer", worker_type: "pro", worker_count: 1, hours_per_worker: 8 },
    ],
  };
  const cleanDoc = voice.normalizeDocument({
    schema_version: 1,
    source: "keyboard",
    days: [cleanVoiceDay],
  });
  const dirtyDoc = voice.normalizeDocument({
    schema_version: 1,
    source: "keyboard",
    areas: [],
    days: [Object.assign({}, cleanVoiceDay, { area_id: null, area_ref: "area_1", price: 80 })],
  });
  function blankIds(doc) {
    const copy = JSON.parse(JSON.stringify(doc));
    copy.days.forEach((day) => {
      day.day_id = "";
      day.worker_assignments.forEach((row) => {
        row.assignment_id = "";
      });
    });
    return copy;
  }
  assert.deepStrictEqual(blankIds(dirtyDoc), blankIds(cleanDoc));
  assert.deepStrictEqual(Object.keys(dirtyDoc).sort(), Object.keys(cleanDoc).sort());
  assert.deepStrictEqual(Object.keys(dirtyDoc.days[0]).sort(), Object.keys(cleanDoc.days[0]).sort());
  assert.strictEqual(Object.prototype.hasOwnProperty.call(dirtyDoc, "areas"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(dirtyDoc.days[0], "area_id"), false);
  assertLegacyDocument(dirtyDoc);
  assertLegacyDocument(legacy);
});

  return passed;
}

if (require.main === module) {
  const total = runOperationalPlanAreaContractTests();
  console.log(total + " passed");
  if (total !== 18) {
    console.error("expected 18 area contract tests, got " + total);
    process.exit(1);
  }
}

module.exports = { runOperationalPlanAreaContractTests };
