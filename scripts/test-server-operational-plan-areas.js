/**
 * Dormant server-side area persistence. No database, no network, no browser.
 * node scripts/test-server-operational-plan-areas.js
 *
 * Seller and Owner shields run this through scripts/test-voice-operational-plan-phase1.js.
 */

const assert = require("assert");
const voice = require("../netlify/functions/_lib/voice-operational-plan");
const { handleQuoteInternalOperationalPlan } = require("../netlify/functions/quote-internal-operational-plan")._test;

const EXPECTED = 37;
const KITCHEN = "8f3c2a10-6b1e-4d77-9a2c-1c0e5b7a4d11";
const MASTER = "b71e90aa-2c44-4f18-8d55-66a0c9e13f20";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUOTE_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const QUOTE_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const SETTINGS = { workdaysEnabled: true, hoursPerDay: 8, baseInstaller: 75, baseHelper: 45 };

const FROZEN_LEGACY_DOCUMENT = {
  schema_version: 1,
  source: "keyboard",
  hours_per_day_used: 8,
  start_date: "2026-09-08",
  due_date: "2026-09-08",
  estimated_days: 1,
  estimated_hours: 8,
  days: [
    {
      day_id: "day_fixed",
      day_number: 1,
      date: "2026-09-08",
      client_scope: "Prep",
      internal_tasks: [{ task_id: "task_fixed", label: "Cut", sort: 0 }],
      worker_assignments: [
        {
          assignment_id: "asg_fixed",
          worker_role: "Installer",
          worker_type: "pro",
          worker_count: 1,
          hours_per_worker: 8,
        },
      ],
      materials_or_tools: [],
      dependencies: [],
      gc_client_responsibilities: [],
      risks: [],
      internal_notes: "",
    },
  ],
};

function legacyInput() {
  return {
    schema_version: 1,
    source: "keyboard",
    start_date: "2026-09-08",
    days: [
      {
        day_id: "day_fixed",
        day_number: 1,
        client_scope: "Prep",
        internal_tasks: [{ task_id: "task_fixed", label: "Cut" }],
        worker_assignments: [
          {
            assignment_id: "asg_fixed",
            worker_role: "Installer",
            worker_type: "pro",
            worker_count: 1,
            hours_per_worker: 8,
          },
        ],
        area_ref: "area_1",
      },
    ],
  };
}

function options(createId) {
  const out = { settings: SETTINGS, hoursPerDay: 8, startDate: "2026-09-08" };
  if (createId) out.createId = createId;
  return out;
}

function assignment(id) {
  return {
    assignment_id: id || "asg_fixed",
    worker_role: "Installer",
    worker_type: "pro",
    worker_count: 1,
    hours_per_worker: 8,
  };
}

function day(extra) {
  return Object.assign(
    {
      day_id: "day_fixed",
      day_number: 1,
      client_scope: "Set the tile.",
      internal_tasks: [],
      worker_assignments: [assignment()],
    },
    extra || {}
  );
}

function area(extra) {
  return Object.assign({ name: "Kitchen Backsplash", scope: "Tile the backsplash.", sort_order: 0 }, extra || {});
}

function temporaryDoc(areas, days) {
  return {
    schema_version: 1,
    source: "keyboard",
    start_date: "2026-09-08",
    areas: areas,
    days: days,
  };
}

function idsInOrder(list) {
  let index = 0;
  return function createId() {
    const id = list[index];
    index += 1;
    return id;
  };
}

function normalize(doc, createId) {
  return voice.normalizeDocument(doc, options(createId));
}

function codes(fn) {
  try {
    fn();
  } catch (err) {
    return err && err.isAreaContractError ? err.code : "thrown";
  }
  return "";
}

function noAreaRef(value) {
  return !JSON.stringify(value).includes("area_ref");
}

async function postConfirm(document, deps, extra) {
  const body = Object.assign(
    {
      action: "confirm",
      quote_id: QUOTE_A,
      start_date: "2026-09-08",
      document: document,
    },
    extra || {}
  );
  return handleQuoteInternalOperationalPlan(
    { httpMethod: "POST", body: JSON.stringify(body) },
    deps
  );
}

function planDeps(atomicCalls, createId, guard) {
  return {
    resolveOwnerOrSellerContext: async () => ({
      auth_mode: "owner",
      tenant: { id: TENANT_A },
      membership: { id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb", role: "owner" },
    }),
    supabaseRequest: async (reqPath) => {
      const path = String(reqPath || "");
      if (path.startsWith("tenant_snapshots")) {
        return [{ payload: { storage: { mg_settings_v2: SETTINGS } } }];
      }
      if (path.startsWith("quotes?")) {
        if (path.includes(QUOTE_B)) return [];
        return [
          {
            id: QUOTE_A,
            tenant_id: TENANT_A,
            seller_membership_id: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb",
            status: "READY_TO_SEND",
            start_date: "2026-09-08",
          },
        ];
      }
      return [];
    },
    evaluateQuoteEditGuard: async () =>
      guard || { ok: true, edit: { is_editable: true, locked: false, lock_reasons: [], warnings: [] } },
    confirmOperationalPlanAtomic: async (_req, args) => {
      atomicCalls.push(args);
      return { ok: true };
    },
    createId: createId,
  };
}

function runPureServerOperationalPlanAreaTests() {
  let passed = 0;
  function test(name, fn) {
    fn();
    passed += 1;
    console.log("ok " + name);
  }

  const legacy = normalize(legacyInput(), function createId() {
    throw new Error("legacy createId");
  });
  test("legacy document matches the frozen production shape", () => {
    assert.deepStrictEqual(legacy, FROZEN_LEGACY_DOCUMENT);
  });
  test("legacy projection stays a crew plan", () => {
    assert.deepStrictEqual(voice.deriveLegacyOperationalPlan(legacy), [
      {
        day_number: 1,
        phase: "Prep",
        workers: [{ role: "Installer", worker_type: "pro", estimated_hours: 8 }],
      },
    ]);
  });
  test("legacy output has no area fields", () => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacy, "areas"), false);
    assert.strictEqual(JSON.stringify(legacy).includes("area_ref"), false);
    assert.strictEqual(JSON.stringify(legacy).includes("area_id"), false);
  });
  test("legacy normalization does not call the uuid generator", () => {
    let calls = 0;
    normalize(legacyInput(), function createId() {
      calls += 1;
      return KITCHEN;
    });
    assert.strictEqual(calls, 0);
  });

  test("empty area catalog fails closed", () => {
    assert.strictEqual(codes(() => normalize(temporaryDoc([], [day()]))), "invalid_area_contract");
  });
  test("empty area catalog does not mint", () => {
    let calls = 0;
    codes(() =>
      normalize(temporaryDoc([], [day()]), function createId() {
        calls += 1;
        return KITCHEN;
      })
    );
    assert.strictEqual(calls, 0);
  });
  test("null area catalog fails closed", () => {
    assert.strictEqual(codes(() => normalize(temporaryDoc(null, [day()]))), "invalid_area_contract");
  });

  const shared = normalize(
    temporaryDoc(
      [area({ area_ref: "area_1" })],
      [day({ area_ref: "area_1" }), day({ day_id: "day_two", day_number: 2, area_ref: "area_1" })]
    ),
    idsInOrder([KITCHEN])
  );
  test("temporary ref becomes one uuid", () => {
    assert.strictEqual(shared.areas[0].id, KITCHEN);
  });
  test("two days with the same ref share that uuid", () => {
    assert.strictEqual(shared.days[0].area_id, KITCHEN);
    assert.strictEqual(shared.days[1].area_id, KITCHEN);
  });

  const named = normalize(
    temporaryDoc(
      [area({ area_ref: "area_1", name: "Bathroom" }), area({ area_ref: "area_2", name: "Bathroom", sort_order: 1 })],
      [day({ area_ref: "area_1" }), day({ day_id: "day_two", day_number: 2, area_ref: "area_2" })]
    ),
    idsInOrder([KITCHEN, MASTER])
  );
  test("same display name keeps distinct uuids", () => {
    assert.strictEqual(named.areas[0].id, KITCHEN);
    assert.strictEqual(named.areas[1].id, MASTER);
    assert.notStrictEqual(named.areas[0].id, named.areas[1].id);
  });

  const unused = normalize(
    temporaryDoc(
      [area({ area_ref: "area_1" }), area({ area_ref: "area_2", name: "Master Bathroom", sort_order: 1 })],
      [day({ area_ref: "area_1" })]
    ),
    idsInOrder([KITCHEN, MASTER])
  );
  test("an area with no days stays in the internal catalog", () => {
    assert.deepStrictEqual(
      unused.areas.map((item) => item.id),
      [KITCHEN, MASTER]
    );
    assert.strictEqual(unused.days.length, 1);
  });
  test("area_ref is absent from the normalized document", () => {
    assert.strictEqual(noAreaRef(shared) && noAreaRef(named) && noAreaRef(unused), true);
  });

  const canonicalInput = temporaryDoc(
    [area({ id: KITCHEN }), area({ id: MASTER, name: "Master Bathroom", sort_order: 1 })],
    [day({ area_id: KITCHEN })]
  );
  let canonicalMints = 0;
  const canonical = normalize(canonicalInput, function createId() {
    canonicalMints += 1;
    return "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  });
  test("canonical document keeps its uuid", () => {
    assert.strictEqual(canonical.areas[0].id, KITCHEN);
    assert.strictEqual(canonical.areas[1].id, MASTER);
    assert.strictEqual(canonical.days[0].area_id, KITCHEN);
  });
  const canonicalAgain = normalize(canonical, function createId() {
    canonicalMints += 1;
    return "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  });
  test("second normalization is identical", () => {
    assert.deepStrictEqual(canonicalAgain, canonical);
  });
  test("canonical normalization does not mint", () => {
    assert.strictEqual(canonicalMints, 0);
  });

  test("ref and id contradiction fails", () => {
    assert.strictEqual(
      codes(() =>
        normalize(
          temporaryDoc(
            [area({ area_ref: "area_1", area_id: KITCHEN })],
            [day({ area_ref: "area_1", area_id: MASTER })]
          )
        )
      ),
      "orphan_day_area"
    );
  });
  test("broken ref fails", () => {
    assert.strictEqual(
      codes(() => normalize(temporaryDoc([area({ area_ref: "area_1" })], [day({ area_ref: "area_2" })]))),
      "orphan_day_area"
    );
  });
  test("orphan uuid fails", () => {
    assert.strictEqual(
      codes(() => normalize(temporaryDoc([area({ id: KITCHEN })], [day({ area_id: MASTER })]))),
      "area_not_in_catalog"
    );
  });
  test("day without an area fails", () => {
    assert.strictEqual(
      codes(() => normalize(temporaryDoc([area({ area_ref: "area_1" })], [day()]))),
      "orphan_day_area"
    );
  });
  test("duplicate ref fails", () => {
    assert.strictEqual(
      codes(() =>
        normalize(
          temporaryDoc(
            [area({ area_ref: "area_1" }), area({ area_ref: "area_1", sort_order: 1 })],
            [day({ area_ref: "area_1" })]
          )
        )
      ),
      "duplicate_area_ref"
    );
  });
  test("duplicate uuid fails", () => {
    assert.strictEqual(
      codes(() =>
        normalize(
          temporaryDoc(
            [area({ id: KITCHEN }), area({ id: KITCHEN, sort_order: 1 })],
            [day({ area_id: KITCHEN })]
          )
        )
      ),
      "duplicate_area_id"
    );
  });
  test("money on an area fails", () => {
    assert.strictEqual(
      codes(() => normalize(temporaryDoc([area({ area_ref: "area_1", sell_cents: 100 })], [day({ area_ref: "area_1" })]))),
      "invalid_area_contract"
    );
  });
  test("money on a day fails", () => {
    assert.strictEqual(
      codes(() =>
        normalize(temporaryDoc([area({ area_ref: "area_1" })], [day({ area_ref: "area_1", subtotal: 10 })]))
      ),
      "invalid_area_contract"
    );
  });
  test("money on a worker fails", () => {
    const crew = assignment();
    crew.margin = 4;
    assert.strictEqual(
      codes(() =>
        normalize(
          temporaryDoc(
            [area({ area_ref: "area_1" })],
            [day({ area_ref: "area_1", worker_assignments: [crew] })]
          )
        )
      ),
      "invalid_area_contract"
    );
  });
  test("a generator that cannot mint fails", () => {
    assert.strictEqual(
      codes(() =>
        normalize(temporaryDoc([area({ area_ref: "area_1" })], [day({ area_ref: "area_1" })]), function createId() {
          return "not-a-uuid";
        })
      ),
      "invalid_area_id"
    );
  });
  test("a partial catalog fails without minting", () => {
    let calls = 0;
    const code = codes(() =>
      normalize(
        temporaryDoc(
          [area({ area_ref: "area_1" }), area({ id: MASTER, sort_order: 1 })],
          [day({ area_ref: "area_1" })]
        ),
        function createId() {
          calls += 1;
          return KITCHEN;
        }
      )
    );
    assert.strictEqual(code, "invalid_area_contract");
    assert.strictEqual(calls, 0);
  });

  return passed;
}

async function runServerOperationalPlanAreaHandlerTests(passed) {
  function test(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
        console.log("ok " + name);
        return passed;
      });
  }

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = function fetchBlocked() {
    fetchCalls += 1;
    throw new Error("network is not allowed");
  };
  try {
    const badCalls = [];
    const bad = await postConfirm(
      temporaryDoc([area({ area_ref: "area_1", rate: 80 })], [day({ area_ref: "area_1" })]),
      planDeps(badCalls, idsInOrder([KITCHEN]))
    );
    await test("invalid confirm does not call the rpc", async () => {
      assert.strictEqual(bad.statusCode, 400);
      assert.strictEqual(JSON.parse(bad.body).persisted, false);
      assert.strictEqual(JSON.parse(bad.body).code, "invalid_area_contract");
      assert.strictEqual(badCalls.length, 0);
    });

    const goodCalls = [];
    let mints = 0;
    const good = await postConfirm(
      temporaryDoc([area({ area_ref: "area_1" }), area({ area_ref: "area_2", name: "Master Bathroom", sort_order: 1 })], [
        day({ area_ref: "area_1" }),
      ]),
      planDeps(goodCalls, function createId() {
        mints += 1;
        return mints === 1 ? KITCHEN : MASTER;
      })
    );
    const goodBody = JSON.parse(good.body);
    await test("successful confirm sends the canonical document to the rpc", async () => {
      assert.strictEqual(good.statusCode, 200);
      assert.strictEqual(goodCalls.length, 1);
      assert.strictEqual(goodCalls[0].document.areas[0].id, KITCHEN);
      assert.strictEqual(goodCalls[0].document.areas[1].id, MASTER);
      assert.strictEqual(goodCalls[0].document.days[0].area_id, KITCHEN);
    });
    await test("successful response returns that canonical document", async () => {
      assert.deepStrictEqual(goodBody.document, goodCalls[0].document);
    });
    await test("quote patch and legacy plan contain no area_ref", async () => {
      assert.strictEqual(noAreaRef(goodCalls[0]), true);
      assert.strictEqual(JSON.stringify(goodCalls[0].quotePatch.operational_plan).includes("area_id"), false);
      assert.strictEqual(goodCalls[0].quotePatch.total, undefined);
      assert.strictEqual(goodCalls[0].quotePatch.labor_area_breakdown, undefined);
    });

    const legacyCalls = [];
    const legacyResponse = await postConfirm(
      { schema_version: 1, source: "keyboard", days: [day()] },
      planDeps(legacyCalls)
    );
    await test("legacy confirm omits areas", async () => {
      assert.strictEqual(legacyResponse.statusCode, 200);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(JSON.parse(legacyResponse.body).document, "areas"), false);
      assert.strictEqual(legacyCalls.length, 1);
    });

    const foreignCalls = [];
    const foreign = await postConfirm(
      temporaryDoc([area({ area_ref: "area_1" })], [day({ area_ref: "area_1" })]),
      planDeps(foreignCalls, idsInOrder([KITCHEN])),
      { quote_id: QUOTE_B }
    );
    await test("cross-tenant confirm does not call the rpc", async () => {
      assert.strictEqual(foreign.statusCode, 404);
      assert.strictEqual(foreignCalls.length, 0);
    });

    const sentGuard = {
      ok: true,
      edit: { is_editable: true, locked: false, lock_reasons: [], warnings: ["quote_viewed_or_sent"] },
    };
    const sentCalls = [];
    const sent = await postConfirm(
      temporaryDoc([area({ id: KITCHEN })], [day({ area_id: KITCHEN })]),
      planDeps(sentCalls, idsInOrder([MASTER]), sentGuard)
    );
    await test("sent quote still requires confirmation", async () => {
      assert.strictEqual(sent.statusCode, 409);
      assert.strictEqual(JSON.parse(sent.body).code, "sent_quote_confirmation_required");
      assert.strictEqual(sentCalls.length, 0);
    });
    const sentOkCalls = [];
    const sentOk = await postConfirm(
      temporaryDoc([area({ id: KITCHEN })], [day({ area_id: KITCHEN })]),
      planDeps(sentOkCalls, idsInOrder([MASTER]), sentGuard),
      { confirm_sent_update: true }
    );
    await test("sent confirm does not send price or labor_area_breakdown", async () => {
      assert.strictEqual(sentOk.statusCode, 200);
      assert.strictEqual(sentOkCalls.length, 1);
      const patch = sentOkCalls[0].quotePatch;
      assert.strictEqual(patch.total, undefined);
      assert.strictEqual(patch.labor_area_breakdown, undefined);
      assert.strictEqual(JSON.stringify(sentOkCalls[0]).includes("sell_cents"), false);
      assert.strictEqual(sentOkCalls[0].document.areas[0].id, KITCHEN);
    });

    const secondCalls = [];
    let secondMints = 0;
    const second = await postConfirm(
      goodBody.document,
      planDeps(secondCalls, function createId() {
        secondMints += 1;
        return MASTER;
      })
    );
    await test("a second confirm persists the same canonical document", async () => {
      assert.strictEqual(second.statusCode, 200);
      assert.deepStrictEqual(secondCalls[0].document, goodCalls[0].document);
      assert.deepStrictEqual(JSON.parse(second.body).document, goodBody.document);
    });
    await test("a second confirm does not mint", async () => {
      assert.strictEqual(secondMints, 0);
    });
    await test("handler tests do not call the network", async () => {
      assert.strictEqual(fetchCalls, 0);
    });
  } finally {
    global.fetch = originalFetch;
  }
  return passed;
}

async function runServerOperationalPlanAreaTests() {
  const passed = await runServerOperationalPlanAreaHandlerTests(runPureServerOperationalPlanAreaTests());
  if (passed !== EXPECTED) {
    throw new Error("Expected " + EXPECTED + " server area tests, got " + passed);
  }
  return passed;
}

module.exports = {
  EXPECTED,
  runServerOperationalPlanAreaTests,
};

if (require.main === module) {
  runServerOperationalPlanAreaTests()
    .then((count) => {
      console.log(count + " passed");
      if (count !== EXPECTED) process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
