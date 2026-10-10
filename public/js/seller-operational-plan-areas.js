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
  };
})(typeof window !== "undefined" ? window : globalThis);
