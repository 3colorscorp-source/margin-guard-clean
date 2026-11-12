/**
 * Optional 3D Views / Proposal PDFs on Owner and Seller quote screens.
 * Uploads go through /.netlify/functions/quote-proposal-pdfs into estimate-pdfs.
 */
(function () {
  const MAX_FILES = 6;
  const MAX_BYTES = Math.floor(3.5 * 1024 * 1024);
  const ENDPOINT = "/.netlify/functions/quote-proposal-pdfs";
  const STYLE_ID = "mg-proposal-pdfs-style";

  let files = [];
  let busy = false;
  let hosts = [];
  let activeQuoteId = "";

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function escapeHtml(v) {
    return String(v || "").replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }

  function quoteIdFromWorkspace() {
    if (activeQuoteId) return activeQuoteId;
    if (window.MarginGuardQuoteProposalState && typeof window.MarginGuardQuoteProposalState.getQuoteId === "function") {
      return String(window.MarginGuardQuoteProposalState.getQuoteId() || "").trim();
    }
    try {
      const owner = JSON.parse(localStorage.getItem("mg_owner_v2") || "{}");
      const sales = JSON.parse(localStorage.getItem("mg_sales_v2") || "{}");
      return String(owner.quoteId || sales.quoteId || "").trim();
    } catch (_err) {
      return "";
    }
  }

  function persist(next) {
    files = Array.isArray(next) ? next.slice(0, MAX_FILES) : [];
    if (
      !activeQuoteId &&
      window.MarginGuardQuoteProposalState &&
      typeof window.MarginGuardQuoteProposalState.setFiles === "function"
    ) {
      window.MarginGuardQuoteProposalState.setFiles(files);
    }
    renderAll();
  }

  function currentFiles() {
    if (
      !activeQuoteId &&
      window.MarginGuardQuoteProposalState &&
      typeof window.MarginGuardQuoteProposalState.getFiles === "function"
    ) {
      const fromState = window.MarginGuardQuoteProposalState.getFiles();
      if (Array.isArray(fromState)) files = fromState.slice(0, MAX_FILES);
    }
    return files;
  }

  function setActiveQuote(quoteId) {
    activeQuoteId = String(quoteId || "").trim();
    if (!activeQuoteId) {
      files = [];
      renderAll();
      return Promise.resolve([]);
    }
    return loadFromQuote(activeQuoteId);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      ".mg-proposal-pdfs{margin:12px 0 0;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.14);box-sizing:border-box}" +
      ".mg-proposal-pdfs h3{margin:0 0 4px;font-size:14px;font-weight:800;letter-spacing:.02em}" +
      ".mg-proposal-pdfs p{margin:0 0 10px;font-size:11.5px;line-height:1.45;opacity:.88}" +
      ".mg-proposal-pdfs__list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
      ".mg-proposal-pdfs__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}" +
      ".mg-proposal-pdfs__name{flex:1 1 140px;font-size:13px;font-weight:650;word-break:break-word}" +
      ".mg-proposal-pdfs__meta{font-size:11px;opacity:.72}" +
      ".mg-proposal-pdfs__actions{display:flex;gap:6px;flex-wrap:wrap}" +
      ".mg-proposal-pdfs__empty{font-size:12px;opacity:.75;margin:0 0 10px}" +
      ".mg-proposal-pdfs__status{min-height:1.2em;font-size:12px;margin:8px 0 0}" +
      ".mg-proposal-pdfs__status.is-err{color:#fca5a5}" +
      ".mg-proposal-pdfs input[type=file]{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}" +
      "#publicEstimateProposalPdfsSection{margin-top:16px}" +
      "#publicEstimateProposalPdfs{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}" +
      "#publicEstimateProposalPdfs a{color:inherit;font-weight:700;text-decoration:underline}";
    document.head.appendChild(style);
  }

  function formatSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return Math.round(v / 102.4) / 10 + " KB";
    return Math.round(v / (1024 * 102.4)) / 10 + " MB";
  }

  function setStatus(host, message, isErr) {
    const el = host && host.querySelector(".mg-proposal-pdfs__status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-err", Boolean(isErr));
  }

  function renderHost(host) {
    if (!host) return;
    injectStyle();
    const list = currentFiles();
    const quoteId = quoteIdFromWorkspace();
    host.innerHTML =
      '<div class="mg-proposal-pdfs">' +
      "<h3>3D Views / Proposal PDFs</h3>" +
      "<p>Optional. These PDFs stay with this quote and are included when you send it. The client opens them from the public estimate page. Price, scope, and terms are unchanged.</p>" +
      (list.length
        ? '<ul class="mg-proposal-pdfs__list">' +
          list
            .map(function (row, index) {
              const open = row.url
                ? '<a class="btn" href="' +
                  escapeHtml(row.url) +
                  '" target="_blank" rel="noopener noreferrer">Open</a>'
                : "";
              return (
                '<li class="mg-proposal-pdfs__row" data-id="' +
                escapeHtml(row.id || "") +
                '">' +
                '<span class="mg-proposal-pdfs__name">' +
                escapeHtml(row.name || "proposal.pdf") +
                "</span>" +
                '<span class="mg-proposal-pdfs__meta">' +
                escapeHtml(formatSize(row.size)) +
                "</span>" +
                '<span class="mg-proposal-pdfs__actions">' +
                open +
                '<button type="button" class="btn" data-replace="' +
                index +
                '">Replace</button>' +
                '<button type="button" class="btn danger" data-remove="' +
                index +
                '">Remove</button>' +
                "</span></li>"
              );
            })
            .join("") +
          "</ul>"
        : '<p class="mg-proposal-pdfs__empty">No proposal PDFs attached yet.</p>') +
      '<div class="inline-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<label class="btn' +
      (busy || list.length >= MAX_FILES ? " " : " primary") +
      '">' +
      (list.length >= MAX_FILES ? "Limit reached" : "Add PDF") +
      '<input type="file" accept="application/pdf,.pdf" ' +
      (busy || list.length >= MAX_FILES ? "disabled" : "") +
      " /></label>" +
      "</div>" +
      '<p class="mg-proposal-pdfs__status"></p>' +
      '<input type="file" accept="application/pdf,.pdf" data-replace-input hidden />' +
      "</div>";

    const addInput = host.querySelector('input[type=file]:not([data-replace-input])');
    if (addInput) {
      addInput.onchange = function () {
        const file = addInput.files && addInput.files[0];
        addInput.value = "";
        if (file) void uploadFile(file, null, host);
      };
    }
    const replaceInput = host.querySelector("[data-replace-input]");
    host.querySelectorAll("[data-replace]").forEach(function (btn) {
      btn.onclick = function () {
        const idx = Number(btn.getAttribute("data-replace"));
        const row = currentFiles()[idx];
        if (!row || !replaceInput) return;
        replaceInput.onchange = function () {
          const file = replaceInput.files && replaceInput.files[0];
          replaceInput.value = "";
          if (file) void uploadFile(file, row.id, host);
        };
        replaceInput.click();
      };
    });
    host.querySelectorAll("[data-remove]").forEach(function (btn) {
      btn.onclick = function () {
        const idx = Number(btn.getAttribute("data-remove"));
        void removeFile(idx, host);
      };
    });
    if (!quoteId) {
      setStatus(host, "Files upload now and attach to this quote when you send it.", false);
    }
  }

  function renderAll() {
    hosts.forEach(renderHost);
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () {
        reject(new Error("Unable to read that file."));
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadFile(file, replaceId, host) {
    if (busy) return;
    if (!file || file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStatus(host, "Only PDF files can be attached.", true);
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus(host, "Each PDF must be 3.5 MB or smaller.", true);
      return;
    }
    if (!replaceId && currentFiles().length >= MAX_FILES) {
      setStatus(host, "A quote can include up to " + MAX_FILES + " proposal PDFs.", true);
      return;
    }
    busy = true;
    renderAll();
    setStatus(host, "Uploading…", false);
    try {
      const contentBase64 = await fileToBase64(file);
      const body = {
        filename: file.name,
        content_base64: contentBase64,
      };
      const quoteId = quoteIdFromWorkspace();
      if (quoteId) body.quote_id = quoteId;
      if (replaceId) body.replace_id = replaceId;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Unable to upload the PDF.");
      }
      if (Array.isArray(data.files) && quoteId) {
        persist(data.files);
      } else if (data.file) {
        const next = currentFiles().slice();
        if (replaceId) {
          const idx = next.findIndex(function (row) {
            return String(row.id) === String(replaceId);
          });
          if (idx >= 0) next[idx] = data.file;
          else next.push(data.file);
        } else {
          next.push(data.file);
        }
        persist(next);
      }
      setStatus(host, "PDF attached to this quote.", false);
    } catch (err) {
      setStatus(host, err && err.message ? err.message : "Unable to upload the PDF.", true);
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function removeFile(index, host) {
    const row = currentFiles()[index];
    if (!row) return;
    const quoteId = quoteIdFromWorkspace();
    if (!quoteId) {
      persist(currentFiles().filter(function (_row, i) {
        return i !== index;
      }));
      return;
    }
    busy = true;
    renderAll();
    try {
      const res = await fetch(ENDPOINT, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ quote_id: quoteId, id: row.id }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Unable to remove the PDF.");
      }
      persist(Array.isArray(data.files) ? data.files : currentFiles().filter(function (_row, i) {
        return i !== index;
      }));
    } catch (err) {
      setStatus(host, err && err.message ? err.message : "Unable to remove the PDF.", true);
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function loadFromQuote(quoteId) {
    const id = String(quoteId || quoteIdFromWorkspace() || "").trim();
    if (!id) return currentFiles();
    try {
      const res = await fetch(ENDPOINT + "?quote_id=" + encodeURIComponent(id), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (res.ok && data && data.ok && Array.isArray(data.files)) {
        persist(data.files);
      }
    } catch (_err) {
      /* keep local list */
    }
    return currentFiles();
  }

  async function attachToQuote(quoteId) {
    const id = String(quoteId || "").trim();
    const list = currentFiles();
    if (!id || !list.length) return { ok: true, files: list };
    const res = await fetch(ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "attach", quote_id: id, files: list }),
    });
    const data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Unable to attach proposal PDFs to this quote.");
    }
    persist(Array.isArray(data.files) ? data.files : list);
    return data;
  }

  function ensureHost() {
    const form = document.getElementById("hubQuoteEditForm");
    let hub = document.getElementById("hubProposalPdfsSection");
    if (form && !hub) {
      hub = document.createElement("section");
      hub.id = "hubProposalPdfsSection";
      hub.className = "mg-proposal-pdfs-host";
      hub.setAttribute("aria-label", "3D Views / Proposal PDFs");
      form.insertAdjacentElement("afterend", hub);
    }
    const scope = document.querySelector(
      ".owner-operational .owner-op-scope-work, .seller-operational .seller-op-scope-work, .owner-op-scope-work, .seller-op-scope-work, #salesNotesSection"
    );
    let owner = document.getElementById("ownerProposalPdfsSection");
    let sales = document.getElementById("salesProposalPdfsSection");
    if (scope && sales && sales.previousElementSibling !== scope && !scope.contains(sales)) {
      scope.insertAdjacentElement("afterend", sales);
    }
    const found = [owner, sales, hub].filter(Boolean);
    if (found.length) return found;
    if (!scope) return [];
    const section = document.createElement("section");
    section.id = "salesProposalPdfsSection";
    section.className = "mg-proposal-pdfs-host";
    section.setAttribute("aria-label", "3D Views / Proposal PDFs");
    scope.insertAdjacentElement("afterend", section);
    return [section];
  }

  function mount() {
    injectStyle();
    hosts = ensureHost();
    const fromState = currentFiles();
    if (fromState.length) files = fromState;
    renderAll();
    const quoteId = quoteIdFromWorkspace();
    if (quoteId) void loadFromQuote(quoteId);
  }

  window.MarginGuardQuoteProposalPdfs = {
    mount: mount,
    attachToQuote: attachToQuote,
    loadFromQuote: loadFromQuote,
    setActiveQuote: setActiveQuote,
    getFiles: currentFiles,
    setFiles: persist,
    MAX_FILES: MAX_FILES,
    MAX_BYTES: MAX_BYTES,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  window.addEventListener("load", function () {
    mount();
  });
  setTimeout(mount, 800);
})();
