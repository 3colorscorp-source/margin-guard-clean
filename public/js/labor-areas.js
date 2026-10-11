/**
 * Optional quote areas. Sell subtotals come from the server.
 * An empty list keeps the quote as one labor total.
 */
(function (global) {
  var UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/[xy]/g, function (ch) {
      var n = (Math.random() * 16) | 0;
      var v = ch === "x" ? n : (n & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function money(amount) {
    var n = Number(amount);
    var value = Number.isFinite(n) ? n : 0;
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }

  function sanitizeClientAreas(raw) {
    var list = Array.isArray(raw) ? raw : [];
    var used = {};
    var areas = [];
    list.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var name = String(item.name || "").trim().slice(0, 80);
      var scope = String(item.scope || "").trim().slice(0, 4000);
      var id = String(item.id || "").trim();
      if (!UUID_RE.test(id) || used[id]) id = newId();
      used[id] = true;
      areas.push({
        id: id,
        name: name,
        scope: scope,
        sort_order: areas.length,
      });
    });
    return areas.slice(0, 30);
  }

  function areaSelectHtml(areas, selectedId) {
    var opts =
      '<option value="">Choose area</option>' +
      areas
        .map(function (area) {
          var selected = area.id === selectedId ? " selected" : "";
          var label = area.name || "Untitled area";
          return '<option value="' + escapeHtml(area.id) + '"' + selected + ">" + escapeHtml(label) + "</option>";
        })
        .join("");
    return '<select data-key="area_id" aria-label="Area">' + opts + "</select>";
  }

  function subtotalFor(area, subtotals) {
    var list = Array.isArray(subtotals) ? subtotals : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].sort_order === area.sort_order) return list[i].sell_subtotal;
    }
    return null;
  }

  function workersForArea(workers, areaId) {
    return (Array.isArray(workers) ? workers : []).filter(function (worker) {
      return worker && worker.area_id === areaId;
    });
  }

  function render(host, model) {
    if (!host) return;
    var areas = sanitizeClientAreas(model && model.areas);
    var workers = Array.isArray(model && model.workers) ? model.workers : [];
    var subtotals = Array.isArray(model && model.subtotals) ? model.subtotals : [];
    var cards = areas
      .map(function (area, index) {
        var sell = subtotalFor(area, subtotals);
        var sellText = sell == null ? "Sell subtotal updates from the protected price." : "Sell subtotal " + money(sell);
        var others = areas.filter(function (item) {
          return item.id !== area.id;
        });
        var moveOptions = others
          .map(function (item) {
            return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name || "Untitled area") + "</option>";
          })
          .join("");
        var moveBlock = others.length
          ? '<label>Move labor to</label><select data-move-target>' +
            moveOptions +
            '</select><button type="button" class="btn" data-area-action="move">Move labor</button>'
          : "";
        return (
          '<article class="mg-labor-area-card" data-area-id="' +
          escapeHtml(area.id) +
          '">' +
          '<div class="mg-labor-area-card__top">' +
          '<label>Area name<input data-area-name maxlength="80" value="' +
          escapeHtml(area.name) +
          '" placeholder="Name this area" /></label>' +
          '<p class="mg-labor-area-sub">' +
          escapeHtml(sellText) +
          "</p></div>" +
          '<label>Scope for the client<textarea data-area-scope rows="3" maxlength="4000" placeholder="Work included in this area">' +
          escapeHtml(area.scope) +
          "</textarea></label>" +
          '<div class="mg-labor-area-actions">' +
          '<button type="button" class="btn ghost" data-area-action="up"' +
          (index === 0 ? " disabled" : "") +
          ">Up</button>" +
          '<button type="button" class="btn ghost" data-area-action="down"' +
          (index === areas.length - 1 ? " disabled" : "") +
          ">Down</button>" +
          '<button type="button" class="btn danger" data-area-action="ask-delete">Delete</button>' +
          "</div>" +
          '<div class="mg-labor-area-confirm" data-area-confirm hidden>' +
          "<p>This area has labor lines. Move them or delete them. They will not be dropped silently.</p>" +
          moveBlock +
          '<button type="button" class="btn danger" data-area-action="drop-lines">Delete labor lines</button>' +
          '<button type="button" class="btn ghost" data-area-action="cancel-delete">Cancel</button>' +
          "</div></article>"
        );
      })
      .join("");
    host.innerHTML =
      '<div class="mg-labor-areas__head"><h3>Areas</h3>' +
      "<p>Optional. Leave this empty to price the quote as one labor total. Names are free.</p></div>" +
      cards +
      (model && model.allowAdd === false
        ? ""
        : '<button type="button" class="btn" data-area-action="add">Add area</button>');
    host.dataset.bound = "1";
    host._mgAreas = areas;
    host._mgWorkers = workers;
  }

  function readCards(host) {
    var cards = host.querySelectorAll(".mg-labor-area-card");
    var areas = [];
    cards.forEach(function (card) {
      areas.push({
        id: card.getAttribute("data-area-id"),
        name: String(card.querySelector("[data-area-name]")?.value || "").trim(),
        scope: String(card.querySelector("[data-area-scope]")?.value || "").trim(),
        sort_order: areas.length,
      });
    });
    return sanitizeClientAreas(areas);
  }

  function commit(host, areas, workers) {
    if (typeof host._mgOnCommit === "function") {
      host._mgOnCommit({
        areas: sanitizeClientAreas(areas),
        workers: workers,
      });
    }
  }

  function mount(host, model) {
    if (!host) return;
    host._mgOnCommit = model && model.onCommit;
    render(host, model);
    if (host.dataset.events === "1") return;
    host.dataset.events = "1";
    host.addEventListener("click", function (event) {
      var button = event.target.closest("[data-area-action]");
      if (!button || !host.contains(button)) return;
      event.preventDefault();
      var action = button.getAttribute("data-area-action");
      var areas = readCards(host);
      var workers = Array.isArray(host._mgWorkers) ? host._mgWorkers.slice() : [];
      if (action === "add") {
        areas.push({ id: newId(), name: "", scope: "", sort_order: areas.length });
        commit(host, areas, workers);
        return;
      }
      var card = button.closest(".mg-labor-area-card");
      if (!card) return;
      var id = card.getAttribute("data-area-id");
      var index = areas.findIndex(function (area) {
        return area.id === id;
      });
      if (index < 0) return;
      if (action === "up" && index > 0) {
        var prev = areas[index - 1];
        areas[index - 1] = areas[index];
        areas[index] = prev;
        commit(host, areas, workers);
        return;
      }
      if (action === "down" && index < areas.length - 1) {
        var next = areas[index + 1];
        areas[index + 1] = areas[index];
        areas[index] = next;
        commit(host, areas, workers);
        return;
      }
      if (action === "ask-delete") {
        var assigned = workersForArea(workers, id);
        if (!assigned.length) {
          areas.splice(index, 1);
          commit(host, areas, workers);
          return;
        }
        var panel = card.querySelector("[data-area-confirm]");
        if (panel) panel.hidden = false;
        return;
      }
      if (action === "cancel-delete") {
        var open = card.querySelector("[data-area-confirm]");
        if (open) open.hidden = true;
        return;
      }
      if (action === "move") {
        var target = card.querySelector("[data-move-target]");
        var targetId = target ? target.value : "";
        if (!targetId) return;
        workers = workers.map(function (worker) {
          if (worker && worker.area_id === id) return Object.assign({}, worker, { area_id: targetId });
          return worker;
        });
        areas.splice(index, 1);
        commit(host, areas, workers);
        return;
      }
      if (action === "drop-lines") {
        workers = workers.filter(function (worker) {
          return !worker || worker.area_id !== id;
        });
        areas.splice(index, 1);
        commit(host, areas, workers);
      }
    });
    host.addEventListener("change", function (event) {
      var field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
      if (!field.matches("[data-area-name], [data-area-scope]")) return;
      commit(host, readCards(host), host._mgWorkers || []);
    });
  }

  function payloadAreas(areas) {
    return sanitizeClientAreas(areas).map(function (area) {
      return {
        id: area.id,
        name: area.name,
        scope: area.scope,
        sort_order: area.sort_order,
      };
    });
  }

  global.MgLaborAreas = {
    newId: newId,
    sanitizeClientAreas: sanitizeClientAreas,
    areaSelectHtml: areaSelectHtml,
    mount: mount,
    payloadAreas: payloadAreas,
    money: money,
  };
})(typeof window !== "undefined" ? window : globalThis);
