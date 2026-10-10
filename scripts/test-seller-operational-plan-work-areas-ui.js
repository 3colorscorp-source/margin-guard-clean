#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const helper = require("../public/js/seller-operational-plan-areas.js");
const ROOT = path.resolve(__dirname, "..");
const KITCHEN = "8f3c2a10-6b1e-4d77-9a2c-1c0e5b7a4d11";
const MASTER = "b71e90aa-2c44-4f18-8d55-66a0c9e13f20";
const EXPECTED = 12;

function crew(type, count, hours) {
  return {
    assignment_id: "asg_seed",
    worker_role: type === "helper" ? "Assistant" : "Installer",
    worker_type: type,
    worker_count: count,
    hours_per_worker: hours,
  };
}

function canonical() {
  return {
    schema_version: 1,
    source: "keyboard",
    areas: [
      { id: KITCHEN, name: "Kitchen Backsplash", scope: "Tile.", sort_order: 0 },
      { id: MASTER, name: "Master Bathroom", scope: "Bath.", sort_order: 1 },
    ],
    days: [
      {
        day_id: "day_1",
        day_number: 1,
        area_id: KITCHEN,
        client_scope: "Protect and prepare.",
        internal_tasks: [{ task_id: "task_1", label: "Mask cabinets" }],
        worker_assignments: [crew("pro", 2, 8)],
      },
      {
        day_id: "day_2",
        day_number: 2,
        area_id: KITCHEN,
        client_scope: "Install backsplash tile.",
        internal_tasks: [{ task_id: "task_2", label: "Set tile" }],
        worker_assignments: [crew("pro", 1, 6)],
      },
      {
        day_id: "day_3",
        day_number: 3,
        area_id: MASTER,
        client_scope: "Waterproof shower.",
        internal_tasks: [{ task_id: "task_3", label: "Membrane" }],
        worker_assignments: [crew("helper", 1, 4)],
      },
      {
        day_id: "day_4",
        day_number: 4,
        area_id: MASTER,
        client_scope: "Install wall tile.",
        internal_tasks: [{ task_id: "task_4", label: "Wall tile" }],
        worker_assignments: [crew("pro", 1, 8)],
      },
    ],
  };
}

async function runSellerOperationalPlanWorkAreasUiTests() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log("ok " + name);
  }

  await test("add area keeps a temporary ref and allows duplicate names", async () => {
    const first = helper.addArea(null, { name: "Kitchen", scope: "A" });
    const second = helper.addArea(first.document, { name: "Kitchen", scope: "B" });
    assert.strictEqual(first.area_ref, "area_1");
    assert.strictEqual(second.area_ref, "area_2");
    assert.strictEqual(second.minted, false);
    assert.strictEqual(second.document.areas[0].name, second.document.areas[1].name);
    assert.notStrictEqual(second.document.areas[0].area_ref, second.document.areas[1].area_ref);
    assert.strictEqual(helper.addArea(second.document, { name: "  " }).ok, false);
  });

  await test("rename, scope, and reorder keep identity and local money", async () => {
    const added = helper.addArea(null, { name: "Kitchen", scope: "A" });
    const extra = helper.addArea(added.document, { name: "Bath", scope: "B" });
    const renamed = helper.renameArea(extra.document, "area_1", "Kitchen Backsplash");
    const scoped = helper.editScope(renamed.document, "area_1", "New scope");
    const moved = helper.reorderArea(scoped.document, "area_1", 1);
    assert.strictEqual(renamed.invalidatesMoney, false);
    assert.strictEqual(scoped.invalidatesMoney, false);
    assert.strictEqual(moved.invalidatesMoney, false);
    assert.strictEqual(moved.document.areas[1].area_ref, "area_1");
    assert.strictEqual(moved.document.areas[1].sort_order, 1);
    assert.strictEqual(moved.document.areas[1].name, "Kitchen Backsplash");
  });

  await test("day operations stay on the chosen area", async () => {
    let doc = helper.addArea(null, { name: "Kitchen" }).document;
    doc = helper.addArea(doc, { name: "Bath" }).document;
    doc = helper.addDay(doc, "area_1", { client_scope: "Prep" }).document;
    const dayId = doc.days[0].day_id;
    const moved = helper.moveDay(doc, dayId, "area_2");
    assert.strictEqual(moved.document.days[0].day_id, dayId);
    assert.strictEqual(moved.document.days[0].area_ref, "area_2");
    assert.strictEqual(moved.invalidatesMoney, true);
    const copied = helper.copyDay(moved.document, dayId);
    assert.notStrictEqual(copied.document.days[1].day_id, dayId);
    assert.notStrictEqual(copied.document.days[1].internal_tasks[0].task_id, moved.document.days[0].internal_tasks[0].task_id);
    assert.strictEqual(copied.document.days[1].area_ref, "area_2");
    const removed = helper.deleteDay(copied.document, copied.document.days[1].day_id);
    assert.strictEqual(removed.document.areas.length, 2);
    assert.strictEqual(removed.document.days.length, 1);
  });

  await test("delete blocks an area that still has days", async () => {
    let doc = helper.addArea(null, { name: "Kitchen" }).document;
    doc = helper.addDay(doc, "area_1").document;
    const blocked = helper.deleteArea(doc, "area_1", { confirm: true });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, "area_has_days");
    assert.strictEqual(blocked.document.areas.length, 1);
    const emptied = helper.deleteDay(doc, doc.days[0].day_id).document;
    assert.strictEqual(helper.deleteArea(emptied, "area_1", { confirm: false }).code, "confirm_required");
    assert.strictEqual(helper.deleteArea(emptied, "area_1", { confirm: true }).document.areas.length, 0);
  });

  await test("remove all areas keeps days and a manual override", async () => {
    let doc = helper.addArea(null, { name: "Kitchen" }).document;
    doc = helper.addDay(doc, "area_1", {
      client_scope: "Prep",
      worker_assignments: [crew("pro", 1, 8)],
    }).document;
    const removed = helper.removeAllAreas(doc, { labor_manual_override: true, labor_auto_sync_from_plan: false }, { confirm: true });
    assert.strictEqual(removed.work_areas_ui, "global");
    assert.strictEqual(removed.labor_auto_sync_from_plan, false);
    assert.strictEqual(removed.labor_manual_override, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(removed.document, "areas"), false);
    assert.strictEqual(removed.document.days[0].client_scope, "Prep");
    assert.strictEqual(removed.document.days[0].area_ref, undefined);
    assert.strictEqual(removed.document.days[0].worker_assignments[0].worker_count, 1);
  });

  await test("crew is required and person-hours keep worker_count", async () => {
    const doc = canonical();
    assert.strictEqual(helper.areaStatus(doc, doc.areas[0]), "Ready");
    const open = helper.addArea(doc, { name: "Empty" });
    assert.strictEqual(helper.areaStatus(open.document, open.document.areas[2]), "Empty area");
    const bare = helper.addDay(open.document, "area_1");
    assert.strictEqual(helper.areaStatus(bare.document, bare.document.areas[2]), "Needs crew");
    const issues = helper.inspectDocument(bare.document, { labor_from_work_areas: true, laborAreas: [] });
    assert.ok(issues.some((issue) => issue.code === "needs_crew" && issue.message.includes("Empty") && issue.message.includes("day")));
    const labor = helper.projectLabor(doc, { pricingMode: "hour", hoursPerDay: 8 });
    const kitchenPro = labor.workers.find((row) => row.area_id === KITCHEN && row.type === "installer");
    assert.strictEqual(kitchenPro.hours, 22);
    assert.strictEqual(kitchenPro.display_units, 22);
    assert.strictEqual(kitchenPro.days, 2.75);
    assert.strictEqual(kitchenPro.rate, "");
    const dayMode = helper.projectLabor(doc, { pricingMode: "day", hoursPerDay: 8 });
    assert.strictEqual(dayMode.workers.find((row) => row.area_id === KITCHEN).display_units, 2.75);
    const pros = labor.workers.filter((row) => row.type === "installer");
    assert.strictEqual(pros.length, 2);
    assert.notStrictEqual(pros[0].area_id, pros[1].area_id);
    assert.strictEqual(labor.laborAreas.some((area) => area.name === "Empty"), false);
    assert.strictEqual(labor.workers.some((row) => !row.area_id), false);
  });

  await test("review groups scope and hides internal money from the client", async () => {
    const text = helper.publicScopeText(canonical());
    assert.strictEqual(
      text,
      [
        "Kitchen Backsplash",
        "- Day 1: Protect and prepare.",
        "- Day 2: Install backsplash tile.",
        "",
        "Master Bathroom",
        "- Day 3: Waterproof shower.",
        "- Day 4: Install wall tile.",
      ].join("\n")
    );
    assert.strictEqual(/crew|person-hours|rate|overhead|reserve|profit|8f3c2a10/.test(text), false);
    const internal = helper.internalReviewText(canonical());
    assert.strictEqual(internal.includes("Mask cabinets"), true);
    assert.strictEqual(internal.includes("16 person-hours"), true);
    assert.strictEqual(internal.includes("Master Bathroom"), true);
  });

  await test("confirm applies the canonical document and does not publish", async () => {
    const before = {
      quoteId: "",
      price: "810",
      laborAreaPublic: [{ sell_subtotal: 810 }],
      _work_area_labor_fp: "",
      workers: [{ name: "Old", type: "installer", days: 9, rate: "40" }],
      laborAreas: [],
    };
    const applied = helper.applyConfirmedWorkAreas({
      state: before,
      document: canonical(),
      settings: { pricingMode: "hour", hoursPerDay: 8 },
    });
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.published, false);
    assert.strictEqual(applied.priced, false);
    assert.strictEqual(applied.state.price, "810");
    assert.deepStrictEqual(applied.state.laborAreaPublic, []);
    assert.strictEqual(applied.state.internal_operational_plan.areas[0].id, KITCHEN);
    assert.strictEqual(applied.state.workers.find((row) => row.area_id === KITCHEN).hours, 22);
    assert.strictEqual(applied.state.operational_plan[0].workers.length, 2);
    const kept = helper.applyConfirmedWorkAreas({
      state: Object.assign({}, applied.state, { laborAreaPublic: [{ sell_subtotal: 100 }] }),
      document: canonical(),
      settings: { pricingMode: "hour", hoursPerDay: 8 },
    });
    assert.deepStrictEqual(kept.state.laborAreaPublic, [{ sell_subtotal: 100 }]);
  });

  await test("mixed catalog mints only through the returned document path", async () => {
    const mixed = helper.addArea(
      {
        areas: [{ id: KITCHEN, name: "Kitchen", scope: "", sort_order: 0 }],
        days: [{ day_id: "day_1", day_number: 1, area_id: KITCHEN, client_scope: "Keep", worker_assignments: [crew("pro", 1, 8)] }],
      },
      { name: "Bath" }
    );
    assert.strictEqual(mixed.document.areas[0].id, KITCHEN);
    assert.strictEqual(mixed.document.areas[1].area_ref, "area_1");
    assert.strictEqual(mixed.document.areas[1].id, undefined);
    const day = helper.addDay(mixed.document, "area_1");
    assert.strictEqual(day.document.days[1].area_ref, "area_1");
    assert.strictEqual(day.document.days[0].area_id, KITCHEN);
  });

  await test("manual legacy stays separate and new quotes start clean", async () => {
    assert.strictEqual(
      helper.detectMode({ laborAreas: [{ id: KITCHEN, name: "Kitchen" }], internal_operational_plan: null }),
      "manual-legacy"
    );
    assert.strictEqual(helper.renderWorkAreas({ laborAreas: [{ id: KITCHEN, name: "Kitchen" }] }).includes("Manual areas — legacy mode"), true);
    assert.strictEqual(helper.renderWorkAreas({ laborAreas: [{ id: KITCHEN, name: "Kitchen" }] }).includes("+ Add work area"), false);
    assert.strictEqual(helper.detectMode({ quoteId: "", laborAreas: [], work_areas_ui: "active" }), "work-areas");
    assert.strictEqual(helper.detectMode({ quoteId: "quote-old", laborAreas: [], operational_plan: [{ day_number: 1 }] }), "global");
    const html = helper.renderWorkAreas({ work_areas_ui: "active", internal_operational_plan: { areas: [], days: [] } });
    assert.strictEqual(html.includes("Work Areas"), true);
    assert.strictEqual(html.includes("+ Add work area"), true);
  });

  await test("a second click is ignored while the first operation is open", async () => {
    const lock = helper.createAsyncLock();
    let release;
    const first = lock(function () {
      return new Promise(function (resolve) {
        release = resolve;
      });
    });
    const second = await lock(function () {
      return { ok: true };
    });
    assert.strictEqual(second.code, "duplicate_click");
    release({ ok: true });
    assert.strictEqual((await first).ok, true);
  });

  await test("sales work areas do not mint browser uuids or call the network", async () => {
    const source = fs.readFileSync(path.join(ROOT, "public/js/seller-operational-plan-areas.js"), "utf8");
    const sales = fs.readFileSync(path.join(ROOT, "public/sales.html"), "utf8");
    assert.strictEqual(source.includes("randomUUID"), false);
    assert.strictEqual(source.includes("fetch("), false);
    assert.strictEqual(source.includes("Manual areas — legacy mode"), true);
    assert.strictEqual(sales.includes("min-height: 44px"), true);
    assert.strictEqual(sales.includes("font-size: 16px"), true);
    assert.strictEqual(sales.includes("previewSellerOperationalPlanAreas(doc, { commit: false })"), true);
    assert.strictEqual(sales.includes("saveSalesState(snapshot)"), true);
    assert.strictEqual(/publish-public-quote|calc-secure-pricing/.test(sales.slice(sales.indexOf("async function applyWorkAreasConfirm"), sales.indexOf("function openVoicePlanPreviewModal"))), false);
  });

  return passed;
}

module.exports = {
  runSellerOperationalPlanWorkAreasUiTests,
  EXPECTED,
};

if (require.main === module) {
  runSellerOperationalPlanWorkAreasUiTests()
    .then(function (passed) {
      if (passed !== EXPECTED) {
        console.error("expected " + EXPECTED + " got " + passed);
        process.exit(1);
      }
      console.log(passed + " passed");
    })
    .catch(function (err) {
      console.error(err);
      process.exit(1);
    });
}
