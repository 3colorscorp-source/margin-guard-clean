/**
 * Optional "Create quote draft from email" on Owner and Seller Project Quote.
 * Paste-only. Applies into the current local Draft. Never sends or stores the email.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MarginGuardQuoteDraftFromEmail = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ENDPOINT = "/.netlify/functions/quote-draft-from-email";
  var STYLE_ID = "mg-quote-email-draft-style";
  var MODAL_ID = "mgQuoteEmailDraftModal";
  var OWNER_STORE = "mg_owner_v2";
  var SALES_STORE = "mg_sales_v2";
  var OVERWRITE_MESSAGE =
    "Apply this email draft to the current Project Quote? Existing draft fields will be replaced. The quote stays Draft until you save or send.";

  function str(value, max) {
    return String(value == null ? "" : value).trim().slice(0, max || 2000);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value == null ? {} : value));
  }

  function parseStore(raw) {
    try {
      var parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_err) {
      return {};
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function composeQuoteNotes(fields) {
    var src = fields || {};
    var lines = [];
    if (src.scope_of_work) lines.push(src.scope_of_work);
    if (src.areas && src.areas.length) lines.push("Areas: " + src.areas.join(", "));
    if (src.requirements) lines.push("Requirements: " + src.requirements);
    if (src.materials) lines.push("Materials: " + src.materials);
    if (src.exclusions) lines.push("Exclusions: " + src.exclusions);
    if (src.important_dates) lines.push("Dates: " + src.important_dates);
    return lines.join("\n").slice(0, 2000);
  }

  function deriveOperationalPlan(document) {
    var days = Array.isArray(document && document.days) ? document.days : [];
    var out = [];
    days.forEach(function (day) {
      if (!day) return;
      var workers = [];
      (Array.isArray(day.worker_assignments) ? day.worker_assignments : []).forEach(function (asg) {
        if (!asg) return;
        var hours = Number(asg.hours_per_worker);
        if (!Number.isFinite(hours) || hours <= 0) return;
        var count = Math.max(1, Math.min(12, Math.floor(Number(asg.worker_count) || 1)));
        var type = String(asg.worker_type || "").toLowerCase() === "helper" ? "helper" : "pro";
        var role = str(asg.worker_role, 80) || (type === "helper" ? "Assistant" : "Installer");
        var i;
        for (i = 0; i < count; i += 1) {
          workers.push({ role: role, worker_type: type, estimated_hours: Math.round(hours * 100) / 100 });
        }
      });
      if (!workers.length) return;
      var taskLabels = [];
      (Array.isArray(day.internal_tasks) ? day.internal_tasks : []).forEach(function (task) {
        var label = str(task && task.label, 240);
        if (label) taskLabels.push(label);
      });
      out.push({
        day_number: Math.max(1, Math.floor(Number(day.day_number) || out.length + 1)),
        phase: (taskLabels.join("; ") || str(day.client_scope, 240) || "Day " + (day.day_number || out.length + 1)).slice(0, 240),
        workers: workers
      });
    });
    return out;
  }

  function detectWorkspace(doc) {
    var d = doc || (typeof document !== "undefined" ? document : null);
    if (d && d.getElementById && d.getElementById("salesProjectName")) return "sales";
    if (d && d.body && d.body.getAttribute && d.body.getAttribute("data-role") === "owner") return "owner";
    return "owner";
  }

  function storeKeyFor(workspace) {
    return workspace === "sales" ? SALES_STORE : OWNER_STORE;
  }

  function lockedStatus(status) {
    var s = String(status || "draft").toLowerCase();
    return s === "sent" || s === "signed";
  }

  function draftHasContent(state) {
    if (!state || typeof state !== "object") return false;
    if (str(state.projectName) || str(state.clientName) || str(state.clientEmail) || str(state.customerEmail)) return true;
    if (Array.isArray(state.operational_plan) && state.operational_plan.length) return true;
    return false;
  }

  function fillLocationParts(doc, location, prefix) {
    var api = typeof window !== "undefined" ? window.MarginGuardProjectLocation : null;
    var parts = { street: location, city: "", state: "", zip: "" };
    if (api && typeof api.partsFromLocation === "function") {
      try {
        parts = api.partsFromLocation(location) || parts;
      } catch (_err) {}
    }
    setInput(doc, prefix ? "salesLocationStreet" : "locationStreet", parts.street || "");
    setInput(doc, prefix ? "salesLocationCity" : "locationCity", parts.city || "");
    setInput(doc, prefix ? "salesLocationState" : "locationState", parts.state || "");
    setInput(doc, prefix ? "salesLocationZip" : "locationZip", parts.zip || "");
  }

  function setInput(doc, id, value) {
    if (!doc || typeof doc.getElementById !== "function") return;
    var el = doc.getElementById(id);
    if (!el) return;
    el.value = value == null ? "" : String(value);
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_inputErr) {}
    try {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_changeErr) {}
  }

  function applyToDraft(proposal, options) {
    var opts = options || {};
    var doc = opts.document || (typeof document !== "undefined" ? document : null);
    var win = opts.window || (typeof window !== "undefined" ? window : null);
    var workspace = opts.workspace || detectWorkspace(doc);
    var storage = (win && win.localStorage) || opts.localStorage;
    if (!storage || typeof storage.getItem !== "function") {
      throw new Error("Quote draft storage is unavailable.");
    }
    var key = storeKeyFor(workspace);
    var state = parseStore(storage.getItem(key));
    if (lockedStatus(state.estimateStatus)) {
      throw new Error("This quote is already sent. Start a New Quote before applying an email draft.");
    }
    var fields = (proposal && proposal.quote_fields) || {};
    var notes = str(proposal && proposal.quote_notes) || composeQuoteNotes(fields);
    var plan = Array.isArray(proposal && proposal.operational_plan)
      ? cloneJson(proposal.operational_plan)
      : deriveOperationalPlan(proposal && proposal.proposed_document);
    var documentPlan = proposal && proposal.proposed_document && typeof proposal.proposed_document === "object"
      ? cloneJson(proposal.proposed_document)
      : { days: [] };
    var startDate = str((documentPlan && documentPlan.start_date) || "", 10);
    var dueDate = str((documentPlan && documentPlan.due_date) || "", 10);

    state.projectName = str(fields.project_name, 60);
    state.clientName = str(fields.client_name, 60);
    state.location = str(fields.project_address, 255);
    state.quoteNotes = notes;
    state.messageToClient = notes;
    state.operational_plan = plan;
    state.internal_operational_plan = documentPlan;
    state.operational_estimated_days_override = "";
    state.operational_estimated_hours_override = "";
    state.labor_auto_sync_from_plan = true;
    state.labor_manual_override = false;
    state.estimateStatus = "draft";
    if (startDate) {
      state.startDate = startDate;
    }
    if (dueDate) {
      state.dueDate = dueDate;
      state.targetFinishDate = dueDate;
    }
    if (!plan.length) {
      state.workers = [];
    }
    if (workspace === "sales") {
      state.customerEmail = str(fields.client_email, 80);
      state.customerPhone = str(fields.client_phone, 40);
    } else {
      state.clientEmail = str(fields.client_email, 80);
      state.clientPhone = str(fields.client_phone, 40);
    }
    delete state.email_body;
    delete state.source_email;
    delete state.emailBody;
    storage.setItem(key, JSON.stringify(state));

    if (workspace === "sales") {
      setInput(doc, "salesProjectName", state.projectName);
      setInput(doc, "salesClientName", state.clientName);
      setInput(doc, "salesCustomerEmail", state.customerEmail);
      setInput(doc, "salesCustomerPhone", state.customerPhone);
      setInput(doc, "salesLocation", state.location);
      setInput(doc, "salesMessageToClient", notes);
      setInput(doc, "salesStartDate", state.startDate || "");
      setInput(doc, "salesTargetFinishDate", state.targetFinishDate || "");
      fillLocationParts(doc, state.location, true);
      setInput(doc, "salesOperationalHoursOverride", "");
      if (win && typeof win.refreshSellerFromStandalone === "function") {
        try {
          win.refreshSellerFromStandalone();
        } catch (_refreshErr) {}
      }
    } else {
      setInput(doc, "projectName", state.projectName);
      setInput(doc, "clientName", state.clientName);
      setInput(doc, "clientEmail", state.clientEmail);
      setInput(doc, "clientPhone", state.clientPhone);
      setInput(doc, "location", state.location);
      setInput(doc, "quoteNotes", notes);
      setInput(doc, "startDate", state.startDate || "");
      setInput(doc, "targetFinishDate", state.targetFinishDate || "");
      fillLocationParts(doc, state.location, false);
      setInput(doc, "ownerOperationalHoursOverride", "");
    }
    return {
      estimateStatus: "draft",
      persistedEmail: false,
      operational_plan: plan,
      sent: false
    };
  }

  function injectStyle(doc) {
    if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".mg-email-draft-btn{margin-left:.5rem;}" +
      ".mg-email-draft-modal{position:fixed;inset:0;z-index:80;display:none;align-items:flex-start;justify-content:center;padding:1.25rem;background:rgba(8,12,22,.72);overflow:auto;}" +
      ".mg-email-draft-modal.is-open{display:flex;}" +
      ".mg-email-draft-dialog{width:min(920px,100%);margin:1.5rem auto;background:#152036;color:#e8eefc;border:1px solid rgba(226,232,240,.16);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.35);}" +
      ".mg-email-draft-dialog header,.mg-email-draft-dialog footer{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem 1.15rem;}" +
      ".mg-email-draft-dialog h3{margin:0;font-size:1.05rem;}" +
      ".mg-email-draft-dialog .sub{margin:.25rem 0 0;color:rgba(232,238,252,.72);font-size:.86rem;}" +
      ".mg-email-draft-badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;background:#b45309;color:#fff7ed;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}" +
      ".mg-email-draft-body{padding:0 1.15rem 1rem;display:grid;gap:1rem;}" +
      ".mg-email-draft-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;}" +
      ".mg-email-draft-grid textarea,.mg-email-draft-grid input,.mg-email-draft-field textarea{width:100%;min-height:2.4rem;border-radius:10px;border:1px solid rgba(226,232,240,.28);background:#1a2438;color:#e8eefc;padding:.55rem .7rem;}" +
      ".mg-email-draft-grid textarea{min-height:9rem;resize:vertical;}" +
      ".mg-email-draft-field label{display:block;margin:0 0 .3rem;font-size:.78rem;color:rgba(232,238,252,.78);}" +
      ".mg-email-draft-review{margin:0;padding-left:1.1rem;color:#fde68a;}" +
      ".mg-email-draft-days{margin:0;padding-left:1.1rem;}" +
      ".mg-email-draft-status{min-height:1.2rem;color:#fda4af;font-size:.86rem;}" +
      ".mg-email-draft-actions{display:flex;gap:.6rem;flex-wrap:wrap;}" +
      "@media (max-width:800px){.mg-email-draft-grid{grid-template-columns:1fr;}}";
    doc.head.appendChild(style);
  }

  function injectButton(doc) {
    if (!doc || typeof doc.getElementById !== "function") return null;
    if (doc.getElementById("btnQuoteDraftFromEmail")) return doc.getElementById("btnQuoteDraftFromEmail");
    var header = doc.querySelector(".owner-quote-header") || doc.querySelector(".sales-quote-header");
    if (!header) return null;
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.id = "btnQuoteDraftFromEmail";
    btn.className = "btn mg-email-draft-btn";
    btn.textContent = "Create quote draft from email";
    header.appendChild(btn);
    return btn;
  }

  function injectModal(doc) {
    if (!doc || !doc.body) return null;
    if (doc.getElementById(MODAL_ID)) return doc.getElementById(MODAL_ID);
    var wrap = doc.createElement("div");
    wrap.id = MODAL_ID;
    wrap.className = "mg-email-draft-modal";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "mgQuoteEmailDraftTitle");
    wrap.innerHTML =
      '<div class="mg-email-draft-dialog">' +
      "<header>" +
      "<div><span class=\"mg-email-draft-badge\">Draft proposal</span>" +
      "<h3 id=\"mgQuoteEmailDraftTitle\">Create quote draft from email</h3>" +
      "<p class=\"sub\">Paste a client email. Margin Guard prepares an editable Project Quote draft. It does not send, save, or connect to a mailbox.</p></div>" +
      "<button type=\"button\" class=\"btn\" data-email-draft-close>Close</button>" +
      "</header>" +
      '<div class="mg-email-draft-body">' +
      '<div class="mg-email-draft-grid">' +
      '<div class="mg-email-draft-field"><label for="mgQuoteEmailDraftSource">Client email</label>' +
      '<textarea id="mgQuoteEmailDraftSource" maxlength="12000" placeholder="Paste the client email here"></textarea></div>' +
      '<div class="mg-email-draft-field"><label>Proposed fields</label>' +
      '<div id="mgQuoteEmailDraftFields"></div></div>' +
      "</div>" +
      '<p class="mg-email-draft-status" id="mgQuoteEmailDraftStatus"></p>' +
      '<div class="mg-email-draft-actions">' +
      '<button type="button" class="btn" id="mgQuoteEmailDraftGenerate">Generate proposal</button>' +
      '<button type="button" class="btn" id="mgQuoteEmailDraftApply" disabled>Apply to Project Quote draft</button>' +
      "</div></div></div>";
    doc.body.appendChild(wrap);
    return wrap;
  }

  function fieldInput(id, label, value, multiline) {
    var safe = escapeHtml(value);
    if (multiline) {
      return (
        '<div class="mg-email-draft-field"><label for="' +
        id +
        '">' +
        escapeHtml(label) +
        "</label><textarea id=\"" +
        id +
        '">' +
        safe +
        "</textarea></div>"
      );
    }
    return (
      '<div class="mg-email-draft-field"><label for="' +
      id +
      '">' +
      escapeHtml(label) +
      '</label><input id="' +
      id +
      '" value="' +
      safe +
      '" /></div>'
    );
  }

  function renderProposal(doc, proposal, emailBody) {
    var host = doc.getElementById("mgQuoteEmailDraftFields");
    if (!host) return;
    var fields = (proposal && proposal.quote_fields) || {};
    var review = Array.isArray(proposal && proposal.needs_review) ? proposal.needs_review : [];
    var days = proposal && proposal.proposed_document && Array.isArray(proposal.proposed_document.days)
      ? proposal.proposed_document.days
      : [];
    var reviewHtml = review.length
      ? "<p class=\"sub\">Needs review</p><ul class=\"mg-email-draft-review\">" +
        review.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") +
        "</ul>"
      : "<p class=\"sub\">No missing-field warnings.</p>";
    var daysHtml = days.length
      ? "<p class=\"sub\">Proposed work days (edit days and workers in the current Operational Plan after you apply)</p><ul class=\"mg-email-draft-days\">" +
        days.map(function (day) {
          var crew = (day.worker_assignments || []).map(function (asg) {
            return (asg.worker_count || 1) + " " + (asg.worker_role || asg.worker_type) + " × " + (asg.hours_per_worker || "?") + "h";
          }).join("; ");
          return (
            "<li><strong>Day " +
            escapeHtml(String(day.day_number || "")) +
            ":</strong> " +
            escapeHtml(day.client_scope || "Needs review") +
            (crew ? " — " + escapeHtml(crew) : " — Needs review: crew") +
            "</li>"
          );
        }).join("") +
        "</ul>"
      : "<p class=\"sub\">No schedule was found in the email. Add days with the current Operational Plan after you apply.</p>";
    host.innerHTML =
      fieldInput("mgEmailFieldProject", "Project name", fields.project_name || "") +
      fieldInput("mgEmailFieldClient", "Client name", fields.client_name || "") +
      fieldInput("mgEmailFieldEmail", "Email", fields.client_email || "") +
      fieldInput("mgEmailFieldPhone", "Phone", fields.client_phone || "") +
      fieldInput("mgEmailFieldAddress", "Project address", fields.project_address || "") +
      fieldInput("mgEmailFieldAreas", "Areas", (fields.areas || []).join(", ")) +
      fieldInput("mgEmailFieldScope", "Scope of work", fields.scope_of_work || "", true) +
      fieldInput("mgEmailFieldReq", "Requirements", fields.requirements || "", true) +
      fieldInput("mgEmailFieldMat", "Materials", fields.materials || "", true) +
      fieldInput("mgEmailFieldExcl", "Exclusions", fields.exclusions || "", true) +
      fieldInput("mgEmailFieldDates", "Important dates", fields.important_dates || "") +
      reviewHtml +
      daysHtml +
      '<div class="mg-email-draft-field"><label>Original email</label><textarea readonly>' +
      escapeHtml(emailBody || "") +
      "</textarea></div>";
  }

  function readEditedFields(doc) {
    function val(id) {
      var el = doc.getElementById(id);
      return el ? str(el.value) : "";
    }
    var areas = val("mgEmailFieldAreas")
      .split(",")
      .map(function (item) { return str(item, 80); })
      .filter(Boolean);
    return {
      project_name: val("mgEmailFieldProject").slice(0, 60),
      client_name: val("mgEmailFieldClient").slice(0, 60),
      client_email: val("mgEmailFieldEmail").slice(0, 80),
      client_phone: val("mgEmailFieldPhone").slice(0, 40),
      project_address: val("mgEmailFieldAddress").slice(0, 255),
      areas: areas,
      scope_of_work: val("mgEmailFieldScope"),
      requirements: val("mgEmailFieldReq"),
      materials: val("mgEmailFieldMat"),
      exclusions: val("mgEmailFieldExcl"),
      important_dates: val("mgEmailFieldDates")
    };
  }

  function setStatus(doc, message, isError) {
    var el = doc.getElementById("mgQuoteEmailDraftStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = isError ? "#fda4af" : "#86efac";
  }

  function mount(options) {
    var opts = options || {};
    var doc = opts.document || (typeof document !== "undefined" ? document : null);
    var win = opts.window || (typeof window !== "undefined" ? window : null);
    var fetchFn = opts.fetch || (win && win.fetch && win.fetch.bind(win));
    if (!doc) return null;
    injectStyle(doc);
    var btn = injectButton(doc);
    var modal = injectModal(doc);
    if (!btn || !modal) return null;
    var pending = null;
    var sourceEmail = "";

    function openModal() {
      modal.classList.add("is-open");
      var ta = doc.getElementById("mgQuoteEmailDraftSource");
      if (ta) ta.focus();
    }
    function closeModal() {
      modal.classList.remove("is-open");
      sourceEmail = "";
      pending = null;
      var ta = doc.getElementById("mgQuoteEmailDraftSource");
      if (ta) ta.value = "";
      var fields = doc.getElementById("mgQuoteEmailDraftFields");
      if (fields) fields.innerHTML = "";
      var applyBtn = doc.getElementById("mgQuoteEmailDraftApply");
      if (applyBtn) applyBtn.disabled = true;
      setStatus(doc, "");
    }

    btn.addEventListener("click", function () {
      openModal();
    });
    modal.addEventListener("click", function (ev) {
      var target = ev.target;
      if (target === modal || (target && target.getAttribute && target.getAttribute("data-email-draft-close") != null)) {
        closeModal();
      }
    });

    var generateBtn = doc.getElementById("mgQuoteEmailDraftGenerate");
    if (generateBtn) {
      generateBtn.addEventListener("click", function () {
        var ta = doc.getElementById("mgQuoteEmailDraftSource");
        var emailBody = ta ? str(ta.value, 12000) : "";
        if (emailBody.length < 20) {
          setStatus(doc, "Paste at least 20 characters from the client email.", true);
          return;
        }
        if (!fetchFn) {
          setStatus(doc, "Email interpretation is unavailable.", true);
          return;
        }
        generateBtn.disabled = true;
        setStatus(doc, "Generating proposal…");
        fetchFn(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email_body: emailBody })
        })
          .then(function (res) {
            return res.json().then(function (data) {
              return { res: res, data: data };
            });
          })
          .then(function (pack) {
            generateBtn.disabled = false;
            if (!pack.res.ok || !pack.data || pack.data.ok !== true) {
              setStatus(doc, (pack.data && pack.data.error) || "Could not generate a proposal.", true);
              return;
            }
            sourceEmail = emailBody;
            pending = pack.data;
            renderProposal(doc, pending, sourceEmail);
            var applyBtn = doc.getElementById("mgQuoteEmailDraftApply");
            if (applyBtn) applyBtn.disabled = false;
            setStatus(doc, "Draft proposal ready. Review, edit, then apply. It will not be sent.");
          })
          .catch(function () {
            generateBtn.disabled = false;
            setStatus(doc, "Could not generate a proposal.", true);
          });
      });
    }

    var applyBtn = doc.getElementById("mgQuoteEmailDraftApply");
    if (applyBtn) {
      applyBtn.addEventListener("click", function () {
        if (!pending) return;
        var edited = readEditedFields(doc);
        pending.quote_fields = edited;
        pending.quote_notes = composeQuoteNotes(edited);
        var workspace = detectWorkspace(doc);
        var storage = win && win.localStorage;
        var current = parseStore(storage && storage.getItem(storeKeyFor(workspace)));
        if (draftHasContent(current)) {
          var okConfirm = win && typeof win.confirm === "function" ? win.confirm(OVERWRITE_MESSAGE) : true;
          if (!okConfirm) return;
        }
        try {
          applyToDraft(pending, { document: doc, window: win, workspace: workspace });
        } catch (err) {
          setStatus(doc, (err && err.message) || "Could not apply the draft.", true);
          return;
        }
        sourceEmail = "";
        pending = null;
        closeModal();
      });
    }

    return {
      open: openModal,
      close: closeModal
    };
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        mount({});
      });
    } else {
      mount({});
    }
  }

  return {
    ENDPOINT: ENDPOINT,
    composeQuoteNotes: composeQuoteNotes,
    deriveOperationalPlan: deriveOperationalPlan,
    applyToDraft: applyToDraft,
    mount: mount
  };
});
