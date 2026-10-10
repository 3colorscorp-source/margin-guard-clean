/**
 * Seller Operational Plan area identity. The browser keeps area_ref until the
 * authenticated preview returns a canonical document. This file does not mint
 * UUIDs, price labor, or resolve refs.
 */
(function (root) {
  var UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function own(obj, key) {
    return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function documentHasAreas(doc) {
    return isObject(doc) && own(doc, "areas");
  }

  function containsAreaRef(value) {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        if (containsAreaRef(value[i])) return true;
      }
      return false;
    }
    if (!isObject(value)) return false;
    if (own(value, "area_ref")) return true;
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k += 1) {
      if (containsAreaRef(value[keys[k]])) return true;
    }
    return false;
  }

  function areaIds(doc) {
    var areas = documentHasAreas(doc) && Array.isArray(doc.areas) ? doc.areas : [];
    return areas.map(function (area) {
      return String(area && area.id == null ? "" : area.id).trim();
    });
  }

  function sameIdentity(left, right) {
    var a = areaIds(left);
    var b = areaIds(right);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (!a[i] || a[i] !== b[i]) return false;
    }
    return true;
  }

  function isCanonicalAreaDocument(doc) {
    if (!documentHasAreas(doc) || !Array.isArray(doc.areas) || !doc.areas.length) return false;
    if (containsAreaRef(doc)) return false;
    var seen = {};
    for (var i = 0; i < doc.areas.length; i += 1) {
      var id = String(doc.areas[i] && doc.areas[i].id == null ? "" : doc.areas[i].id).trim();
      if (!UUID_RE.test(id) || seen[id]) return false;
      seen[id] = true;
    }
    var days = Array.isArray(doc.days) ? doc.days : [];
    for (var d = 0; d < days.length; d += 1) {
      var dayId = String(days[d] && days[d].area_id == null ? "" : days[d].area_id).trim();
      if (!seen[dayId]) return false;
    }
    return true;
  }

  function cloneDraft(draft) {
    return {
      draftId: String(draft && draft.draftId || ""),
      quoteId: String(draft && draft.quoteId || ""),
      document: draft && draft.document ? draft.document : null,
    };
  }

  function applyCanonicalDocument(confirmedDraft, serverDocument) {
    var confirmed = cloneDraft(confirmedDraft);
    if (!isCanonicalAreaDocument(serverDocument)) {
      return { ok: false, draft: confirmed, published: false, priced: false };
    }
    return {
      ok: true,
      published: false,
      priced: false,
      draft: {
        draftId: confirmed.draftId,
        quoteId: confirmed.quoteId,
        document: serverDocument,
      },
    };
  }

  function applyPreviewResult(confirmedDraft, response) {
    var confirmed = cloneDraft(confirmedDraft);
    if (!response || response.ok !== true || !response.document) {
      return { ok: false, draft: confirmed, published: false, priced: false };
    }
    return applyCanonicalDocument(confirmed, response.document);
  }

  function bindDraftToQuote(draft, quoteId) {
    var next = cloneDraft(draft);
    next.quoteId = String(quoteId || "").trim();
    return next;
  }

  function activeAreaIds(doc) {
    var ids = {};
    var days = Array.isArray(doc && doc.days) ? doc.days : [];
    days.forEach(function (day) {
      var id = String(day && day.area_id == null ? "" : day.area_id).trim();
      if (id) ids[id] = true;
    });
    return ids;
  }

  function validatePublishBundle(bundle) {
    var doc = bundle && bundle.document;
    if (!documentHasAreas(doc)) return { ok: true, active: false };
    if (!isCanonicalAreaDocument(doc)) {
      return { ok: false, code: "unresolved_area_ref", error: "Publish requires the canonical preview document." };
    }
    var active = activeAreaIds(doc);
    var labor = Array.isArray(bundle.laborAreas) ? bundle.laborAreas : [];
    var laborIds = {};
    for (var i = 0; i < labor.length; i += 1) {
      var laborId = String(labor[i] && labor[i].id == null ? "" : labor[i].id).trim();
      if (!active[laborId] || laborIds[laborId]) {
        return { ok: false, code: "labor_area_mismatch", error: "Labor areas must use the active plan UUIDs." };
      }
      laborIds[laborId] = true;
    }
    var activeKeys = Object.keys(active);
    for (var a = 0; a < activeKeys.length; a += 1) {
      if (!laborIds[activeKeys[a]]) {
        return { ok: false, code: "labor_area_mismatch", error: "Every area with a day must be in the labor payload." };
      }
    }
    var workers = Array.isArray(bundle.workers) ? bundle.workers : [];
    for (var w = 0; w < workers.length; w += 1) {
      var workerId = String(workers[w] && workers[w].area_id == null ? "" : workers[w].area_id).trim();
      if (!active[workerId]) {
        return { ok: false, code: "orphan_worker_area", error: "A worker points outside the active plan." };
      }
    }
    return { ok: true, active: true };
  }

  function decideHydration(input) {
    var current = input || {};
    if (current.generation !== current.latestGeneration || current.requestQuoteId !== current.currentQuoteId) {
      return { action: "ignore", reason: "stale" };
    }
    var status = Number(current.status);
    if (status === 401 || status === 403 || status === 404) {
      return { action: "reject", reason: "unauthorized_or_foreign" };
    }
    if (status === 200 && isObject(current.serverDocument)) {
      if (current.serverQuoteId && current.serverQuoteId !== current.currentQuoteId) {
        return { action: "ignore", reason: "quote_mismatch" };
      }
      return { action: "apply-server", document: current.serverDocument };
    }
    if (status === 200 && current.serverDocument == null) {
      var local = current.localDraft;
      if (
        local &&
        local.document &&
        current.currentQuoteId &&
        String(local.quoteId || "") === String(current.currentQuoteId)
      ) {
        return { action: "apply-local", document: local.document };
      }
      return {
        action: "legacy",
        plan: Array.isArray(current.legacyPlan) ? current.legacyPlan : [],
      };
    }
    return { action: "ignore", reason: "unavailable" };
  }

  /**
   * Applies a hydration decision to a sales-state object.
   * Only the internal document, and the area draft when that document has areas,
   * can change. Workers, scope, dates, manual areas, and price stay as they were.
   * Ignore, reject, and unavailable decisions return the same state.
   */
  function applyHydrationResult(state, decision) {
    var current = isObject(state) ? state : {};
    if (!decision || (decision.action !== "apply-server" && decision.action !== "apply-local")) {
      return { applied: false, state: current };
    }
    if (documentHasAreas(decision.document) && !isCanonicalAreaDocument(decision.document)) {
      return { applied: false, state: current };
    }
    var next = {};
    var keys = Object.keys(current);
    for (var i = 0; i < keys.length; i += 1) next[keys[i]] = current[keys[i]];
    next.internal_operational_plan = decision.document;
    if (documentHasAreas(decision.document)) {
      next.seller_plan_area_draft = bindDraftToQuote(
        {
          draftId: current._sellerDraftId || "",
          quoteId: current.quoteId || "",
          document: decision.document,
        },
        current.quoteId || ""
      );
    }
    return { applied: true, state: next };
  }

  var MONEY_KEYS = {
    sell_subtotal: true,
    sell_cents: true,
    subtotal: true,
    price: true,
    total: true,
    cost: true,
    rate: true,
    margin: true,
    overhead: true,
    profit: true,
    reserve: true,
    commission: true,
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
  }

  function round2(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  function blankDocument() {
    return { schema_version: 1, source: "keyboard", areas: [], days: [] };
  }

  function workingDocument(state) {
    var internal = state && state.internal_operational_plan;
    if (documentHasAreas(internal)) return clone(internal);
    var draft = state && state.seller_plan_area_draft;
    if (draft && documentHasAreas(draft.document)) return clone(draft.document);
    return blankDocument();
  }

  function detectMode(state) {
    var current = isObject(state) ? state : {};
    var doc = current.internal_operational_plan;
    if (!documentHasAreas(doc) && current.seller_plan_area_draft) {
      doc = current.seller_plan_area_draft.document;
    }
    var manual =
      !current.labor_from_work_areas &&
      Array.isArray(current.laborAreas) &&
      current.laborAreas.length > 0;
    if (manual && !documentHasAreas(doc)) return "manual-legacy";
    if (documentHasAreas(doc) || current.work_areas_ui === "active") return "work-areas";
    return "global";
  }

  function areaRefOf(area) {
    return String(area && area.area_ref == null ? "" : area.area_ref).trim();
  }

  function areaIdOf(area) {
    return String(area && area.id == null ? "" : area.id).trim();
  }

  function sameArea(area, key) {
    var token = String(key || "").trim();
    if (!token || !area) return false;
    return areaRefOf(area) === token || areaIdOf(area) === token;
  }

  function dayLink(day) {
    var ref = String(day && day.area_ref == null ? "" : day.area_ref).trim();
    if (ref) return ref;
    return String(day && day.area_id == null ? "" : day.area_id).trim();
  }

  function dayMatchesArea(day, area) {
    var link = dayLink(day);
    if (!link) return false;
    return link === areaRefOf(area) || link === areaIdOf(area);
  }

  function nextAreaRef(doc) {
    var max = 0;
    function scan(value) {
      var ref = String(value || "").trim();
      var match = /^area_([1-9][0-9]*)$/.exec(ref);
      if (match) max = Math.max(max, Number(match[1]));
    }
    (doc && Array.isArray(doc.areas) ? doc.areas : []).forEach(function (area) {
      scan(areaRefOf(area));
    });
    (doc && Array.isArray(doc.days) ? doc.days : []).forEach(function (day) {
      scan(day && day.area_ref);
    });
    return "area_" + String(max + 1);
  }

  function idFactory(doc) {
    var max = { day: 0, task: 0, asg: 0 };
    JSON.stringify(doc || {}).replace(/(day|task|asg)_(\d+)/g, function (_all, prefix, n) {
      max[prefix] = Math.max(max[prefix] || 0, Number(n));
      return _all;
    });
    return function next(prefix) {
      max[prefix] = (max[prefix] || 0) + 1;
      return prefix + "_" + String(max[prefix]);
    };
  }

  function withAreas(doc) {
    var next = clone(doc || blankDocument());
    if (!isObject(next)) next = blankDocument();
    if (!Array.isArray(next.areas)) next.areas = [];
    if (!Array.isArray(next.days)) next.days = [];
    next.schema_version = next.schema_version || 1;
    next.source = next.source || "keyboard";
    return next;
  }

  function rewriteSort(doc) {
    doc.areas.forEach(function (area, index) {
      area.sort_order = index;
    });
  }

  function findArea(doc, key) {
    var areas = doc && Array.isArray(doc.areas) ? doc.areas : [];
    for (var i = 0; i < areas.length; i += 1) {
      if (sameArea(areas[i], key)) return i;
    }
    return -1;
  }

  function daysForArea(doc, area) {
    return (doc.days || []).filter(function (day) {
      return dayMatchesArea(day, area);
    });
  }

  function linkDayToArea(day, area) {
    var next = clone(day);
    delete next.area_ref;
    delete next.area_id;
    if (areaRefOf(area)) next.area_ref = areaRefOf(area);
    else if (areaIdOf(area)) next.area_id = areaIdOf(area);
    return next;
  }

  function addArea(doc, input) {
    var name = String(input && input.name == null ? "" : input.name).trim();
    if (!name) {
      return { ok: false, code: "name_required", error: "A work area needs a name.", document: withAreas(doc), minted: false };
    }
    var next = withAreas(doc);
    var ref = nextAreaRef(next);
    next.areas.push({
      area_ref: ref,
      name: name.slice(0, 80),
      scope: String(input && input.scope == null ? "" : input.scope).trim().slice(0, 4000),
      sort_order: next.areas.length,
    });
    return { ok: true, document: next, area_ref: ref, minted: false, invalidatesMoney: false };
  }

  function renameArea(doc, key, name) {
    var next = withAreas(doc);
    var index = findArea(next, key);
    var clean = String(name == null ? "" : name).trim();
    if (index < 0 || !clean) return { ok: false, code: "name_required", document: next, invalidatesMoney: false };
    var before = areaRefOf(next.areas[index]) + "|" + areaIdOf(next.areas[index]);
    next.areas[index].name = clean.slice(0, 80);
    var after = areaRefOf(next.areas[index]) + "|" + areaIdOf(next.areas[index]);
    return { ok: true, document: next, invalidatesMoney: false, identity: before === after };
  }

  function editScope(doc, key, scope) {
    var next = withAreas(doc);
    var index = findArea(next, key);
    if (index < 0) return { ok: false, code: "missing_area", document: next, invalidatesMoney: false };
    var before = areaRefOf(next.areas[index]) + "|" + areaIdOf(next.areas[index]);
    next.areas[index].scope = String(scope == null ? "" : scope).trim().slice(0, 4000);
    var after = areaRefOf(next.areas[index]) + "|" + areaIdOf(next.areas[index]);
    return { ok: true, document: next, invalidatesMoney: false, identity: before === after };
  }

  function reorderArea(doc, key, direction) {
    var next = withAreas(doc);
    var index = findArea(next, key);
    if (index < 0) return { ok: false, code: "missing_area", document: next, invalidatesMoney: false };
    var target = index + (direction < 0 ? -1 : 1);
    if (target < 0 || target >= next.areas.length) {
      return { ok: true, document: next, invalidatesMoney: false, identity: true };
    }
    var row = next.areas[index];
    next.areas.splice(index, 1);
    next.areas.splice(target, 0, row);
    rewriteSort(next);
    return { ok: true, document: next, invalidatesMoney: false, identity: true };
  }

  function renumberDays(doc) {
    doc.days.forEach(function (day, index) {
      day.day_number = index + 1;
    });
  }

  function addDay(doc, key, input) {
    var next = withAreas(doc);
    var index = findArea(next, key);
    if (index < 0) return { ok: false, code: "missing_area", document: next, invalidatesMoney: false };
    var seed = isObject(input) ? input : {};
    var ids = idFactory(next);
    var day = {
      day_id: ids("day"),
      day_number: next.days.length + 1,
      client_scope: String(seed.client_scope || "").slice(0, 2000),
      internal_tasks: Array.isArray(seed.internal_tasks)
        ? clone(seed.internal_tasks)
        : [{ task_id: ids("task"), label: "" }],
      worker_assignments: Array.isArray(seed.worker_assignments) ? clone(seed.worker_assignments) : [],
    };
    next.days.push(linkDayToArea(day, next.areas[index]));
    renumberDays(next);
    return { ok: true, document: next, invalidatesMoney: true };
  }

  function moveDay(doc, dayId, targetKey) {
    var next = withAreas(doc);
    var areaIndex = findArea(next, targetKey);
    var dayIndex = next.days.findIndex(function (day) {
      return day && day.day_id === dayId;
    });
    if (areaIndex < 0 || dayIndex < 0) return { ok: false, code: "missing_day", document: next, invalidatesMoney: false };
    var current = next.days[dayIndex];
    var moved = linkDayToArea(current, next.areas[areaIndex]);
    moved.day_id = current.day_id;
    next.days[dayIndex] = moved;
    return { ok: true, document: next, invalidatesMoney: true, day_id: current.day_id };
  }

  function copyDay(doc, dayId) {
    var next = withAreas(doc);
    var dayIndex = next.days.findIndex(function (day) {
      return day && day.day_id === dayId;
    });
    if (dayIndex < 0) return { ok: false, code: "missing_day", document: next, invalidatesMoney: false };
    var ids = idFactory(next);
    var copy = clone(next.days[dayIndex]);
    copy.day_id = ids("day");
    copy.internal_tasks = (copy.internal_tasks || []).map(function (task) {
      var row = clone(task);
      row.task_id = ids("task");
      return row;
    });
    copy.worker_assignments = (copy.worker_assignments || []).map(function (asg) {
      var row = clone(asg);
      row.assignment_id = ids("asg");
      return row;
    });
    next.days.splice(dayIndex + 1, 0, copy);
    renumberDays(next);
    return { ok: true, document: next, invalidatesMoney: true, day_id: copy.day_id };
  }

  function updateDay(doc, dayId, patch) {
    var next = withAreas(doc);
    var dayIndex = next.days.findIndex(function (day) {
      return day && day.day_id === dayId;
    });
    if (dayIndex < 0) return { ok: false, code: "missing_day", document: next, invalidatesMoney: false };
    var day = next.days[dayIndex];
    var input = patch || {};
    var invalidates = false;
    if (Object.prototype.hasOwnProperty.call(input, "client_scope")) day.client_scope = String(input.client_scope || "").slice(0, 2000);
    if (Object.prototype.hasOwnProperty.call(input, "task")) {
      if (!Array.isArray(day.internal_tasks) || !day.internal_tasks.length) {
        day.internal_tasks = [{ task_id: idFactory(next)("task"), label: "" }];
      }
      day.internal_tasks[0].label = String(input.task || "").slice(0, 500);
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "worker_type") ||
      Object.prototype.hasOwnProperty.call(input, "worker_count") ||
      Object.prototype.hasOwnProperty.call(input, "hours_per_worker")
    ) {
      invalidates = true;
      var current = (day.worker_assignments && day.worker_assignments[0]) || {};
      var type = Object.prototype.hasOwnProperty.call(input, "worker_type") ? input.worker_type : current.worker_type;
      if (!type) {
        day.worker_assignments = [];
      } else {
        day.worker_assignments = [
          {
            assignment_id: current.assignment_id || idFactory(next)("asg"),
            worker_role: type === "helper" ? "Assistant" : "Installer",
            worker_type: type === "helper" ? "helper" : "pro",
            worker_count: Object.prototype.hasOwnProperty.call(input, "worker_count") ? input.worker_count : current.worker_count,
            hours_per_worker: Object.prototype.hasOwnProperty.call(input, "hours_per_worker")
              ? input.hours_per_worker
              : current.hours_per_worker,
          },
        ];
      }
    }
    return { ok: true, document: next, invalidatesMoney: invalidates };
  }

  function replaceDayAssignments(doc, dayId, assignments) {
    var next = withAreas(doc);
    var dayIndex = next.days.findIndex(function (day) {
      return day && day.day_id === dayId;
    });
    if (dayIndex < 0) return { ok: false, code: "missing_day", document: next, invalidatesMoney: false };
    var ids = idFactory(next);
    next.days[dayIndex].worker_assignments = (Array.isArray(assignments) ? assignments : [])
      .map(function (asg) {
        var type = String(asg && asg.worker_type || "");
        if (type !== "helper" && type !== "pro" && type !== "installer") return null;
        return {
          assignment_id: String(asg.assignment_id || "").trim() || ids("asg"),
          worker_role: type === "helper" ? "Assistant" : "Installer",
          worker_type: type === "helper" ? "helper" : "pro",
          worker_count: Number(asg.worker_count),
          hours_per_worker: Number(asg.hours_per_worker),
        };
      })
      .filter(Boolean);
    return { ok: true, document: next, invalidatesMoney: true };
  }

  function addDayAssignment(doc, dayId) {
    var next = withAreas(doc);
    var dayIndex = next.days.findIndex(function (day) {
      return day && day.day_id === dayId;
    });
    if (dayIndex < 0) return { ok: false, code: "missing_day", document: next, invalidatesMoney: false };
    var list = Array.isArray(next.days[dayIndex].worker_assignments) ? next.days[dayIndex].worker_assignments : [];
    list.push({ assignment_id: idFactory(next)("asg"), worker_role: "", worker_type: "", worker_count: "", hours_per_worker: "" });
    next.days[dayIndex].worker_assignments = list;
    return { ok: true, document: next, invalidatesMoney: true };
  }

  function deleteDayAssignment(doc, dayId, assignmentId) {
    var next = withAreas(doc);
    var dayIndex = next.days.findIndex(function (day) {
      return day && day.day_id === dayId;
    });
    if (dayIndex < 0) return { ok: false, code: "missing_day", document: next, invalidatesMoney: false };
    next.days[dayIndex].worker_assignments = (next.days[dayIndex].worker_assignments || []).filter(function (asg) {
      return String(asg && asg.assignment_id || "") !== String(assignmentId || "");
    });
    return { ok: true, document: next, invalidatesMoney: true };
  }

  function deleteDay(doc, dayId) {
    var next = withAreas(doc);
    var before = next.areas.length;
    next.days = next.days.filter(function (day) {
      return day && day.day_id !== dayId;
    });
    renumberDays(next);
    return { ok: true, document: next, invalidatesMoney: true, areas: next.areas.length === before };
  }

  function deleteArea(doc, key, options) {
    var next = withAreas(doc);
    var index = findArea(next, key);
    if (index < 0) return { ok: false, code: "missing_area", document: next, invalidatesMoney: false };
    var linked = daysForArea(next, next.areas[index]);
    if (linked.length) {
      return {
        ok: false,
        code: "area_has_days",
        error: "Move or delete the days in this area first. They will not be reassigned.",
        document: next,
        invalidatesMoney: false,
      };
    }
    if (!options || options.confirm !== true) {
      return { ok: false, code: "confirm_required", error: "Confirm before deleting this empty area.", document: next, invalidatesMoney: false };
    }
    next.areas.splice(index, 1);
    rewriteSort(next);
    return { ok: true, document: next, invalidatesMoney: false };
  }

  function removeAllAreas(doc, state, options) {
    var next = withAreas(doc);
    if (!options || options.confirm !== true) {
      return { ok: false, code: "confirm_required", error: "Confirm before removing all work areas.", document: next };
    }
    var days = next.days.map(function (day) {
      var row = clone(day);
      delete row.area_ref;
      delete row.area_id;
      return row;
    });
    delete next.areas;
    next.days = days;
    var manual = !!(state && state.labor_manual_override);
    return {
      ok: true,
      document: next,
      work_areas_ui: "global",
      labor_auto_sync_from_plan: manual ? false : state && state.labor_auto_sync_from_plan !== false,
      labor_manual_override: manual,
      invalidatesMoney: true,
    };
  }

  function assignmentValid(asg) {
    if (!isObject(asg)) return false;
    var count = Number(asg.worker_count);
    var hours = Number(asg.hours_per_worker);
    var type = String(asg.worker_type || "");
    return (type === "pro" || type === "helper" || type === "installer") && count >= 1 && Math.floor(count) === count && hours > 0;
  }

  function personHours(asg) {
    if (!assignmentValid(asg)) return 0;
    return round2(Number(asg.worker_count) * Number(asg.hours_per_worker));
  }

  function dayCrewValid(day) {
    var list = day && Array.isArray(day.worker_assignments) ? day.worker_assignments : [];
    if (!list.length) return false;
    for (var i = 0; i < list.length; i += 1) {
      if (!assignmentValid(list[i])) return false;
    }
    return true;
  }

  function areaStatus(doc, area) {
    var days = daysForArea(doc, area);
    if (!days.length) return "Empty area";
    for (var i = 0; i < days.length; i += 1) {
      if (!dayCrewValid(days[i])) return "Needs crew";
    }
    return "Ready";
  }

  function areaPersonHours(doc, area) {
    var total = 0;
    daysForArea(doc, area).forEach(function (day) {
      (day.worker_assignments || []).forEach(function (asg) {
        total += personHours(asg);
      });
    });
    return round2(total);
  }

  function inspectDocument(doc, state) {
    var issues = [];
    var current = withAreas(doc);
    if (
      state &&
      !state.labor_from_work_areas &&
      Array.isArray(state.laborAreas) &&
      state.laborAreas.length > 0 &&
      documentHasAreas(current)
    ) {
      issues.push({ code: "hybrid_manual", message: "Manual areas and Work Areas cannot be combined." });
    }
    current.areas.forEach(function (area) {
      if (areaRefOf(area) && areaIdOf(area)) {
        issues.push({ code: "ref_id_conflict", message: area.name + " cannot carry both a temporary ref and a canonical id." });
      }
    });
    current.days.forEach(function (day) {
      var ref = String(day && day.area_ref == null ? "" : day.area_ref).trim();
      var id = String(day && day.area_id == null ? "" : day.area_id).trim();
      if (ref && id) {
        issues.push({ code: "ref_id_conflict", message: "Day " + day.day_number + " cannot carry both area_ref and area_id." });
      }
      var link = dayLink(day);
      var area = null;
      current.areas.forEach(function (item) {
        if (dayMatchesArea(day, item)) area = item;
      });
      if (!link || !area) {
        issues.push({ code: "day_without_area", message: "Day " + (day.day_number || "") + " is not linked to a work area." });
        return;
      }
      if (!dayCrewValid(day)) {
        issues.push({
          code: "needs_crew",
          message: area.name + " day " + day.day_number + " needs crew. Add a worker count and hours. No crew was invented.",
        });
      }
    });
    return issues;
  }

  function workerTypeKey(asg) {
    var type = String(asg && asg.worker_type || "");
    if (type === "helper") return "helper";
    return "pro";
  }

  function projectLabor(doc, settings) {
    var current = withAreas(doc);
    var hpd = Number(settings && settings.hoursPerDay);
    if (!Number.isFinite(hpd) || hpd < 1) hpd = 8;
    var mode = String(settings && settings.pricingMode || "hour").toLowerCase() === "day" ? "day" : "hour";
    var rows = [];
    var areas = [];
    current.areas.forEach(function (area) {
      var days = daysForArea(current, area);
      if (!days.length) return;
      var bucket = { pro: 0, helper: 0 };
      days.forEach(function (day) {
        (day.worker_assignments || []).forEach(function (asg) {
          bucket[workerTypeKey(asg)] += personHours(asg);
        });
      });
      var active = false;
      ["pro", "helper"].forEach(function (type) {
        var hours = round2(bucket[type]);
        if (!(hours > 0)) return;
        active = true;
        var workerDays = round2(hours / hpd);
        rows.push({
          name: area.name,
          type: type === "helper" ? "helper" : "installer",
          area_id: areaIdOf(area),
          area_ref: areaRefOf(area),
          hours: hours,
          days: workerDays,
          display_units: mode === "hour" ? hours : workerDays,
          display_unit: mode === "hour" ? "hours" : "days",
          rate: "",
        });
      });
      if (active) {
        var laborArea = {
          name: area.name,
          scope: deriveAreaScope(area, days),
          sort_order: area.sort_order,
        };
        if (UUID_RE.test(areaIdOf(area))) laborArea.id = areaIdOf(area);
        else laborArea.area_ref = areaRefOf(area);
        areas.push(laborArea);
      }
    });
    return { workers: rows, laborAreas: areas, mode: mode, hoursPerDay: hpd };
  }

  function deriveAreaScope(area, days) {
    var lines = [];
    function push(text) {
      var clean = String(text || "").trim();
      if (!clean || lines.indexOf(clean) >= 0) return;
      lines.push(clean);
    }
    push(area && area.scope);
    (days || []).forEach(function (day) {
      push(day && day.client_scope);
    });
    return lines.join("\n").slice(0, 4000);
  }

  function publicScopeText(doc) {
    var current = withAreas(doc);
    var blocks = [];
    current.areas.forEach(function (area) {
      var days = daysForArea(current, area);
      if (!days.length) return;
      var lines = [area.name];
      days.forEach(function (day) {
        var text = String(day.client_scope || "").trim();
        if (text) lines.push("- Day " + day.day_number + ": " + text);
      });
      blocks.push(lines.join("\n"));
    });
    return blocks.join("\n\n");
  }

  function internalReviewText(doc) {
    var current = withAreas(doc);
    var lines = [];
    current.areas.forEach(function (area) {
      lines.push(area.name + " · " + areaStatus(current, area));
      daysForArea(current, area).forEach(function (day) {
        lines.push("Day " + day.day_number);
        (day.internal_tasks || []).forEach(function (task) {
          if (task && task.label) lines.push("Task: " + task.label);
        });
        (day.worker_assignments || []).forEach(function (asg) {
          lines.push(
            "Crew: " +
              asg.worker_count +
              " " +
              (asg.worker_role || asg.worker_type) +
              " × " +
              asg.hours_per_worker +
              "h = " +
              personHours(asg) +
              " person-hours"
          );
        });
        if (!dayCrewValid(day)) lines.push("Needs crew");
      });
    });
    return lines.join("\n");
  }

  function laborFingerprint(doc) {
    var current = withAreas(doc);
    var parts = [];
    current.days.forEach(function (day) {
      parts.push(["day", day.day_id, dayLink(day)].join(":"));
      (day.worker_assignments || []).forEach(function (asg) {
        parts.push([asg.worker_type, asg.worker_count, asg.hours_per_worker].join(":"));
      });
    });
    current.areas.forEach(function (area) {
      if (daysForArea(current, area).length) parts.push("area:" + (areaIdOf(area) || areaRefOf(area)));
    });
    return parts.join("|");
  }

  function applyConfirmedWorkAreas(input) {
    var current = input || {};
    var snapshot = clone(current.state || {});
    var document = current.document;
    if (!isCanonicalAreaDocument(document)) {
      return { ok: false, published: false, priced: false, state: snapshot };
    }
    var next = clone(snapshot);
    var stored = clone(document);
    stored.areas.forEach(function (area) {
      area.scope = deriveAreaScope(area, daysForArea(stored, area));
    });
    var previousFp = String(snapshot._work_area_labor_fp || "");
    var nextFp = laborFingerprint(stored);
    var projected = projectLabor(stored, current.settings || {});
    next.internal_operational_plan = stored;
    next.work_areas_ui = "active";
    next.labor_from_work_areas = true;
    next.workers = projected.workers;
    next.laborAreas = projected.laborAreas;
    next.operational_plan = legacyPlanFromDocument(document);
    next.messageToClient = publicScopeText(document);
    next._work_area_labor_fp = nextFp;
    if (previousFp !== nextFp) next.laborAreaPublic = [];
    next.seller_plan_area_draft = bindDraftToQuote(
      {
        draftId: snapshot._sellerDraftId || "",
        quoteId: snapshot.quoteId || "",
        document: stored,
      },
      snapshot.quoteId || ""
    );
    return { ok: true, published: false, priced: false, state: next, snapshot: snapshot };
  }

  function legacyPlanFromDocument(doc) {
    var out = [];
    (doc && Array.isArray(doc.days) ? doc.days : []).forEach(function (day) {
      var workers = [];
      (day.worker_assignments || []).forEach(function (asg) {
        if (!assignmentValid(asg)) return;
        var count = Math.floor(Number(asg.worker_count));
        for (var i = 0; i < count; i += 1) {
          workers.push({
            role: asg.worker_role || (workerTypeKey(asg) === "helper" ? "Assistant" : "Installer"),
            worker_type: workerTypeKey(asg) === "helper" ? "helper" : "pro",
            estimated_hours: round2(asg.hours_per_worker),
          });
        }
      });
      if (!workers.length) return;
      out.push({
        day_number: day.day_number,
        phase: String(day.client_scope || "Day " + day.day_number).slice(0, 240),
        workers: workers,
      });
    });
    return out;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderWorkAreas(state) {
    var mode = detectMode(state);
    if (mode === "manual-legacy") {
      return (
        '<section class="mg-work-areas mg-work-areas--legacy" aria-label="Manual areas — legacy mode">' +
        '<p class="mg-work-areas__badge">Manual areas — legacy mode</p>' +
        "<p>These areas stay in the current labor form. Work Areas does not convert or replace them.</p>" +
        "</section>"
      );
    }
    if (mode === "global") {
      return (
        '<section class="mg-work-areas mg-work-areas--global" aria-label="Work Areas">' +
        '<button type="button" class="btn primary mg-work-areas__add" data-wa-action="activate">+ Add work area</button>' +
        "</section>"
      );
    }
    var doc = workingDocument(state);
    var cards = (doc.areas || [])
      .map(function (area, index) {
        var key = areaRefOf(area) || areaIdOf(area);
        var days = daysForArea(doc, area);
        var status = areaStatus(doc, area);
        var dayHtml = days
          .map(function (day) {
            var crews = day.worker_assignments && day.worker_assignments.length ? day.worker_assignments : [{
              assignment_id: "",
              worker_type: "",
              worker_role: "",
              worker_count: "",
              hours_per_worker: "",
            }];
            var options = (doc.areas || [])
              .map(function (item) {
                var itemKey = areaRefOf(item) || areaIdOf(item);
                var selected = itemKey === key ? " selected" : "";
                return '<option value="' + escapeHtml(itemKey) + '"' + selected + ">" + escapeHtml(item.name) + "</option>";
              })
              .join("");
            var needs = dayCrewValid(day) ? "" : '<p class="mg-work-day__needs">Needs crew</p>';
            var crewHtml = crews.map(function (crew, crewIndex) {
              return (
                '<div class="mg-work-assignment" data-assignment-id="' + escapeHtml(crew.assignment_id || "") + '">' +
                '<label>Crew<select data-wa-field="worker_type">' +
                '<option value="">Choose crew</option>' +
                '<option value="pro"' + (crew.worker_type === "pro" ? " selected" : "") + '>Installer</option>' +
                '<option value="helper"' + (crew.worker_type === "helper" ? " selected" : "") + '>Assistant</option></select></label>' +
                '<label>Worker count<input data-wa-field="worker_count" type="number" min="1" step="1" inputmode="numeric" value="' +
                escapeHtml(crew.worker_count) + '" /></label>' +
                '<label>Hours per worker<input data-wa-field="hours_per_worker" type="number" min="0.25" step="0.25" inputmode="decimal" value="' +
                escapeHtml(crew.hours_per_worker) + '" /></label>' +
                (crew.assignment_id ? '<button type="button" class="btn danger" data-wa-action="delete-worker" data-assignment-id="' +
                  escapeHtml(crew.assignment_id) + '">Remove crew</button>' : '') +
                '</div>'
              );
            }).join("");
            return (
              '<article class="mg-work-day" data-day-id="' +
              escapeHtml(day.day_id) +
              '">' +
              "<h4>Day " +
              escapeHtml(day.day_number) +
              "</h4>" +
              needs +
              '<label>Public description<input data-wa-field="client_scope" value="' +
              escapeHtml(day.client_scope || "") +
              '" /></label>' +
              '<label>Internal task<input data-wa-field="task" value="' +
              escapeHtml((day.internal_tasks && day.internal_tasks[0] && day.internal_tasks[0].label) || "") +
              '" /></label>' +
              crewHtml +
              '<button type="button" class="btn" data-wa-action="add-worker" data-day-id="' + escapeHtml(day.day_id) + '">Add crew</button>' +
              '<label class="mg-work-day__move">Move day to<select data-wa-field="move_area">' +
              options +
              "</select></label>" +
              '<div class="mg-work-day__actions">' +
              '<button type="button" class="btn" data-wa-action="copy-day" data-day-id="' +
              escapeHtml(day.day_id) +
              '">Copy day</button>' +
              '<button type="button" class="btn danger mg-work-area__danger" data-wa-action="delete-day" data-day-id="' +
              escapeHtml(day.day_id) +
              '">Delete day</button>' +
              "</div></article>"
            );
          })
          .join("");
        return (
          '<article class="mg-work-area" data-area-key="' +
          escapeHtml(key) +
          '">' +
          '<div class="mg-work-area__summary"><div class="mg-work-area__summary-copy">' +
          '<h4>' + escapeHtml(area.name) + '</h4>' +
          '<p>' + days.length + ' days · ' + areaPersonHours(doc, area) + ' person-hours · ' + escapeHtml(status) + '</p>' +
          '</div><div class="mg-work-area__actions">' +
          '<button type="button" class="btn primary" data-wa-action="edit-area">Open area</button>' +
          '<button type="button" class="btn" data-wa-action="move-up"' +
          (index === 0 ? " disabled" : "") +
          ">Move up</button>" +
          '<button type="button" class="btn" data-wa-action="move-down"' +
          (index === doc.areas.length - 1 ? " disabled" : "") +
          ">Move down</button>" +
          '<button type="button" class="btn danger mg-work-area__danger" data-wa-action="delete-area" aria-label="Delete ' +
          escapeHtml(area.name) +
          '">Delete</button>' +
          '</div></div>' +
          '<div class="mg-work-area-editor" data-wa-editor aria-hidden="true" role="dialog" aria-modal="true" aria-label="Edit ' +
          escapeHtml(area.name) + '">' +
          '<div class="mg-work-area-editor__card"><div class="mg-work-area-editor__header">' +
          '<h3>' + escapeHtml(area.name) + '</h3>' +
          '<button type="button" class="icon-btn" data-wa-action="close-area" aria-label="Close area">X</button>' +
          '</div><div class="mg-work-area-editor__body">' +
          '<label>Name<input data-wa-field="name" maxlength="80" value="' + escapeHtml(area.name) + '" /></label>' +
          '<label>Scope of Work<textarea data-wa-field="scope" maxlength="4000" rows="7">' + escapeHtml(area.scope || "") + '</textarea></label>' +
          '<p class="mg-work-area__status">' + escapeHtml(status) +
          (status === "Empty area" ? ". This area stays in the plan and will not be quoted." : "") + '</p>' +
          '<div class="mg-work-area__actions"><button type="button" class="btn primary" data-wa-action="add-day">Add day</button></div>' +
          dayHtml +
          '</div><div class="mg-work-area-editor__footer">' +
          '<button type="button" class="btn mg-work-area-editor__add-next" data-wa-action="open-add-area">+ Add New Area</button>' +
          '<button type="button" class="btn primary" data-wa-action="save-area">Save Area</button>' +
          '</div></div></div></article>'
        );
      })
      .join("");
    return (
      '<section class="mg-work-areas" aria-label="Work Areas">' +
      '<div class="mg-work-area__summary"><h3>Multi-Area Quote</h3>' +
      '<button type="button" class="btn primary mg-work-areas__add" data-wa-action="open-add-area">+ Add New Area</button></div>' +
      (cards || '<p class="mg-work-areas__empty">No areas yet. Add the first area to build this quote.</p>') +
      '<div class="mg-work-area-editor mg-new-area-modal" data-wa-new-modal aria-hidden="true" role="dialog" aria-modal="true" aria-label="Add new area">' +
      '<div class="mg-work-area-editor__card"><div class="mg-work-area-editor__header"><h3>Add New Area</h3>' +
      '<button type="button" class="icon-btn" data-wa-action="close-add-area" aria-label="Close">X</button></div>' +
      '<div class="mg-work-area-editor__body"><form class="mg-work-areas__create" data-wa-action="add-form">' +
      '<label>Area name<input id="waNewAreaName" maxlength="80" placeholder="Kitchen Backsplash" /></label>' +
      '<label>Scope of Work<textarea id="waNewAreaScope" maxlength="4000" rows="7" placeholder="Describe the complete client-facing scope for this area."></textarea></label>' +
      '</form></div><div class="mg-work-area-editor__footer">' +
      '<button type="button" class="btn" data-wa-action="close-add-area">Cancel</button>' +
      '<button type="button" class="btn primary mg-work-areas__add" data-wa-action="add-area">Save Area</button>' +
      '</div></div></div>' +
      '<button type="button" class="btn danger mg-work-area__danger mg-work-areas__remove" data-wa-action="remove-all">Remove all areas</button>' +
      '<p class="mg-work-areas__note" data-wa-note></p>' +
      "</section>"
    );
  }

  function createActionLock() {
    var busy = false;
    return function run(fn) {
      if (busy) return { ok: false, code: "duplicate_click" };
      busy = true;
      try {
        return fn();
      } finally {
        busy = false;
      }
    };
  }

  function createAsyncLock() {
    var busy = false;
    return function run(fn) {
      if (busy) return Promise.resolve({ ok: false, code: "duplicate_click" });
      busy = true;
      var result;
      try {
        result = fn();
      } catch (err) {
        busy = false;
        return Promise.reject(err);
      }
      return Promise.resolve(result).then(
        function (value) {
          busy = false;
          return value;
        },
        function (err) {
          busy = false;
          throw err;
        }
      );
    };
  }

  root.MgSellerOperationalPlanAreas = {
    documentHasAreas: documentHasAreas,
    containsAreaRef: containsAreaRef,
    isCanonicalAreaDocument: isCanonicalAreaDocument,
    sameIdentity: sameIdentity,
    applyCanonicalDocument: applyCanonicalDocument,
    applyPreviewResult: applyPreviewResult,
    bindDraftToQuote: bindDraftToQuote,
    validatePublishBundle: validatePublishBundle,
    decideHydration: decideHydration,
    applyHydrationResult: applyHydrationResult,
    detectMode: detectMode,
    workingDocument: workingDocument,
    addArea: addArea,
    renameArea: renameArea,
    editScope: editScope,
    reorderArea: reorderArea,
    addDay: addDay,
    updateDay: updateDay,
    replaceDayAssignments: replaceDayAssignments,
    addDayAssignment: addDayAssignment,
    deleteDayAssignment: deleteDayAssignment,
    moveDay: moveDay,
    copyDay: copyDay,
    deleteDay: deleteDay,
    deleteArea: deleteArea,
    removeAllAreas: removeAllAreas,
    areaStatus: areaStatus,
    areaPersonHours: areaPersonHours,
    personHours: personHours,
    inspectDocument: inspectDocument,
    projectLabor: projectLabor,
    publicScopeText: publicScopeText,
    internalReviewText: internalReviewText,
    laborFingerprint: laborFingerprint,
    applyConfirmedWorkAreas: applyConfirmedWorkAreas,
    legacyPlanFromDocument: legacyPlanFromDocument,
    renderWorkAreas: renderWorkAreas,
    createActionLock: createActionLock,
    createAsyncLock: createAsyncLock,
    deriveAreaScope: deriveAreaScope,
  };
})(typeof window !== "undefined" ? window : globalThis);
if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof globalThis !== "undefined" ? globalThis : window).MgSellerOperationalPlanAreas;
}
