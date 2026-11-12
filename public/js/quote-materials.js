/**
 * Permanent quote materials lines for Owner and Seller.
 * Contractor lines add to the quote total as pass-through (no labor burden).
 * Client-supplied lines stay on the quote at $0. Never invent unit costs.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MgQuoteMaterials = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_LINES = 24;
  var MAX_NAME = 80;
  var UNITS = ["ea", "sq ft", "box", "bag", "sheet", "gal", "lf"];

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function newId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function money(amount) {
    var n = Number(amount);
    return (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }

  function sanitizeMaterialLines(raw) {
    var src = Array.isArray(raw) ? raw : [];
    var out = [];
    var seen = {};
    src.forEach(function (row) {
      if (!row || typeof row !== "object") return;
      var id = trim(row.id);
      if (!id || seen[id]) id = newId();
      seen[id] = true;
      var provider = String(row.provider || "").toLowerCase() === "client" ? "client" : "contractor";
      var qty = Number(row.quantity);
      if (!Number.isFinite(qty) || qty < 0) qty = provider === "client" ? 0 : 1;
      var unitCost = Number(row.unit_cost);
      if (!Number.isFinite(unitCost) || unitCost < 0) unitCost = 0;
      var unit = trim(row.unit).toLowerCase();
      if (UNITS.indexOf(unit) < 0) unit = "ea";
      var name = trim(row.name).slice(0, MAX_NAME);
      out.push({
        id: id,
        name: name,
        provider: provider,
        quantity: round2(qty),
        unit: unit,
        unit_cost: round2(unitCost),
      });
    });
    return out.slice(0, MAX_LINES);
  }

  function lineTotal(row) {
    if (!row || row.provider === "client") return 0;
    return round2(Math.max(0, Number(row.quantity) || 0) * Math.max(0, Number(row.unit_cost) || 0));
  }

  function contractorSubtotal(raw) {
    return round2(
      sanitizeMaterialLines(raw).reduce(function (sum, row) {
        return sum + lineTotal(row);
      }, 0)
    );
  }

  function applyToLaborTotals(laborMetrics, materialCost) {
    var labor = laborMetrics && typeof laborMetrics === "object" ? laborMetrics : {};
    var add = round2(Math.max(0, Number(materialCost) || 0));
    var out = {};
    Object.keys(labor).forEach(function (key) {
      out[key] = labor[key];
    });
    out.materialCost = add;
    out.laborRecommended = round2(Number(labor.recommended) || 0);
    out.recommended = round2((Number(labor.recommended) || 0) + add);
    out.minimum = round2((Number(labor.minimum) || 0) + add);
    if (labor.negotiation != null) {
      out.negotiation = round2((Number(labor.negotiation) || 0) + add);
    }
    return out;
  }

  function looksClientProvided(text) {
    return /client(?:s)? (?:will )?provide|supplied by the client|tile and grout supplied by the client/i.test(
      String(text || "")
    );
  }

  function seedFromText(text) {
    var src = String(text || "");
    if (!src.trim()) return [];
    var chunks = src
      .split(/[;\n]+/)
      .map(function (part) {
        return part.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean);
    var names = [];
    var seen = {};
    function push(name, provider) {
      var key = String(name || "").toLowerCase();
      if (!key || seen[key]) return;
      seen[key] = true;
      names.push({
        id: newId(),
        name: String(name).slice(0, MAX_NAME),
        provider: provider === "client" ? "client" : "contractor",
        quantity: provider === "client" ? 0 : 1,
        unit: "ea",
        unit_cost: 0,
      });
    }
    if (looksClientProvided(src)) {
      push("Tile (client provided)", "client");
      push("Grout (client provided)", "client");
    }
    chunks.forEach(function (chunk) {
      if (/^client provides/i.test(chunk) || /supplied by the client/i.test(chunk)) return;
      if (/contractor provides all other materials/i.test(chunk)) return;
      var known = chunk.match(
        /LATICRETE\s+STRATA[_\s-]*MAT|Maverick Textured Slate Mosaic|thin-set mortar|stone\/grout sealer|ceramic tile|12\s*x\s*12\s*in\.?\s*sheets/i
      );
      if (known) {
        push(known[0].replace(/\s+/g, " "), "contractor");
        return;
      }
      if (
        chunk.length >= 4 &&
        chunk.length <= 80 &&
        !/needs review/i.test(chunk) &&
        /mat(?:erial)?|mortar|sealer|mosaic|underlay|thin-?set|tile|grout|membrane|plywood|backer|primer|schluter|ditra/i.test(
          chunk
        )
      ) {
        push(chunk, looksClientProvided(chunk) ? "client" : "contractor");
      }
    });
    return sanitizeMaterialLines(names);
  }

  function mergeSeed(existing, text) {
    var current = sanitizeMaterialLines(existing);
    var seeded = seedFromText(text);
    seeded.forEach(function (row) {
      var key = String(row.name || "").toLowerCase();
      var found = current.some(function (item) {
        return String(item.name || "").toLowerCase() === key;
      });
      if (!found) current.push(row);
    });
    return sanitizeMaterialLines(current);
  }

  function blankLine() {
    return {
      id: newId(),
      name: "",
      provider: "contractor",
      quantity: 1,
      unit: "ea",
      unit_cost: 0,
    };
  }

  function injectStyle(doc) {
    if (!doc || doc.getElementById("mg-quote-materials-style")) return;
    var style = doc.createElement("style");
    style.id = "mg-quote-materials-style";
    style.textContent =
      ".mg-quote-materials{margin:12px 0 0;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.14)}" +
      ".mg-quote-materials h2,.mg-quote-materials h3{margin:0 0 4px;font-size:16px;font-weight:800}" +
      ".mg-quote-materials p{margin:0 0 10px;font-size:12px;line-height:1.45;opacity:.88}" +
      ".mg-quote-materials table{width:100%;border-collapse:collapse}" +
      ".mg-quote-materials th,.mg-quote-materials td{padding:6px 4px;text-align:left;font-size:12px}" +
      ".mg-quote-materials input,.mg-quote-materials select{width:100%;min-height:36px;box-sizing:border-box}" +
      ".mg-quote-materials__total{display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-weight:700}" +
      ".mg-quote-materials__actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}";
    doc.head.appendChild(style);
  }

  function render(host, options) {
    var opts = options || {};
    var doc = (host && host.ownerDocument) || (typeof document !== "undefined" ? document : null);
    if (!host || !doc) return;
    injectStyle(doc);
    var lines = sanitizeMaterialLines(opts.lines);
    var total = contractorSubtotal(lines);
    host.innerHTML =
      '<div class="mg-quote-materials">' +
      "<header><h2" +
      (opts.headingId ? ' id="' + escapeHtml(opts.headingId) + '"' : "") +
      ">Materials</h2>" +
      "<p>Add contractor-supplied items with your cost. Client-provided tile or grout stays on the quote at $0 and does not change the recommended price. Materials do not get labor burden, overhead, or profit — enter the amount you want in the quote.</p></header>" +
      (lines.length
        ? '<div class="supervisor-table-wrap"><table class="table"><thead><tr>' +
          "<th>Item</th><th>Provided by</th><th>Qty</th><th>Unit</th><th>Unit cost</th><th>Line</th><th></th>" +
          "</tr></thead><tbody>" +
          lines
            .map(function (row, index) {
              var unitOpts = UNITS.map(function (unit) {
                return (
                  "<option value=\"" +
                  unit +
                  '"' +
                  (row.unit === unit ? " selected" : "") +
                  ">" +
                  unit +
                  "</option>"
                );
              }).join("");
              return (
                '<tr data-id="' +
                escapeHtml(row.id) +
                '">' +
                '<td><input data-key="name" value="' +
                escapeHtml(row.name) +
                '" maxlength="80" /></td>' +
                '<td><select data-key="provider"><option value="contractor"' +
                (row.provider === "contractor" ? " selected" : "") +
                '>Us</option><option value="client"' +
                (row.provider === "client" ? " selected" : "") +
                ">Client</option></select></td>" +
                '<td><input data-key="quantity" type="number" min="0" step="0.01" value="' +
                escapeHtml(String(row.quantity)) +
                '" /></td>' +
                "<td><select data-key=\"unit\">" +
                unitOpts +
                "</select></td>" +
                '<td><input data-key="unit_cost" type="number" min="0" step="0.01" value="' +
                escapeHtml(String(row.unit_cost)) +
                '" /></td>' +
                "<td>" +
                escapeHtml(money(lineTotal(row))) +
                "</td>" +
                '<td><button type="button" class="btn danger" data-remove="' +
                index +
                '">Remove</button></td></tr>'
              );
            })
            .join("") +
          "</tbody></table></div>"
        : '<p>No material lines yet. Add the items you will buy, or fill names from the quote notes.</p>') +
      '<div class="mg-quote-materials__total"><span>Materials in quote</span><strong>' +
      escapeHtml(money(total)) +
      "</strong></div>" +
      '<div class="mg-quote-materials__actions">' +
      '<button type="button" class="btn primary" data-add>Add material</button>' +
      '<button type="button" class="btn" data-seed>Fill names from notes</button>' +
      "</div></div>";

    function emit(next) {
      if (typeof opts.onChange === "function") opts.onChange(sanitizeMaterialLines(next));
    }

    host.querySelectorAll("input, select").forEach(function (el) {
      el.onchange = function () {
        var tr = el.closest("tr");
        if (!tr) return;
        var id = tr.getAttribute("data-id");
        var next = lines.map(function (row) {
          if (row.id !== id) return row;
          var copy = Object.assign({}, row);
          var key = el.getAttribute("data-key");
          if (key === "quantity" || key === "unit_cost") copy[key] = Number(el.value || 0);
          else copy[key] = el.value;
          return copy;
        });
        emit(next);
      };
    });
    host.querySelectorAll("[data-remove]").forEach(function (btn) {
      btn.onclick = function () {
        var idx = Number(btn.getAttribute("data-remove"));
        emit(lines.filter(function (_row, i) { return i !== idx; }));
      };
    });
    var addBtn = host.querySelector("[data-add]");
    if (addBtn) {
      addBtn.onclick = function () {
        emit(lines.concat([blankLine()]));
      };
    }
    var seedBtn = host.querySelector("[data-seed]");
    if (seedBtn) {
      seedBtn.onclick = function () {
        emit(mergeSeed(lines, opts.notes || ""));
      };
    }
  }

  function mount(host, options) {
    if (!host) return null;
    render(host, options || {});
    return host;
  }

  return {
    MAX_LINES: MAX_LINES,
    sanitizeMaterialLines: sanitizeMaterialLines,
    contractorSubtotal: contractorSubtotal,
    lineTotal: lineTotal,
    applyToLaborTotals: applyToLaborTotals,
    seedFromText: seedFromText,
    mergeSeed: mergeSeed,
    blankLine: blankLine,
    render: render,
    mount: mount,
  };
});
