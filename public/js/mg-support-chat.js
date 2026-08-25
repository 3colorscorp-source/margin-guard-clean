/**
 * Ask Margin Guard — owner-only Stage 1 support drawer.
 * Loaded by mg-app-nav.js on authenticated owner shell pages.
 */

function mgSupportEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mgSupportRenderInlineMarkdown(escapedLine) {
  return String(escapedLine || "")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function mgSupportRenderAssistantMarkdown(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  if (!text) return "";
  const lines = text.split("\n");
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      html.push("<h3>" + mgSupportRenderInlineMarkdown(mgSupportEscapeHtml(heading[2])) + "</h3>");
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html.push("<ul>");
      while (i < lines.length) {
        const item = /^\s*[-*]\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        html.push("<li>" + mgSupportRenderInlineMarkdown(mgSupportEscapeHtml(item[1])) + "</li>");
        i += 1;
      }
      html.push("</ul>");
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      html.push("<ol>");
      while (i < lines.length) {
        const item = /^\s*\d+[.)]\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        html.push("<li>" + mgSupportRenderInlineMarkdown(mgSupportEscapeHtml(item[1])) + "</li>");
        i += 1;
      }
      html.push("</ol>");
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(mgSupportRenderInlineMarkdown(mgSupportEscapeHtml(lines[i])));
      i += 1;
    }
    html.push("<p>" + para.join("<br>") + "</p>");
  }
  return html.join("");
}

const MG_SUPPORT_INVOICE_RESEND_TYPE = "invoice_resend";
const MG_SUPPORT_INVOICE_RESEND_LABEL = "Resend invoice";
const MG_SUPPORT_INVOICE_RESEND_API = "/.netlify/functions/mg-support-invoice-resend";
const MG_SUPPORT_INVOICE_RESEND_PENDING = "Submitting resend...";
const MG_SUPPORT_INVOICE_RESEND_SUCCESS =
  "Invoice resend was submitted to the email delivery bridge.";
const MG_SUPPORT_INVOICE_RESEND_UNKNOWN =
  "Margin Guard could not confirm whether the resend submission was accepted. It was not automatically retried to avoid sending a duplicate.";
const MG_SUPPORT_INVOICE_RESEND_CLAIMED =
  "Another resend is already in progress or awaiting verification. Margin Guard will not submit another copy automatically.";
const MG_SUPPORT_INVOICE_RESEND_EXPIRED =
  "This confirmation expired. Ask Margin Guard again if you still want to resend the invoice.";
const MG_SUPPORT_INVOICE_RESEND_CHANGED =
  "The invoice changed after this confirmation was created. Ask Margin Guard again before resending it.";
const MG_SUPPORT_INVOICE_RESEND_TRANSPORT =
  "Margin Guard could not confirm the result of the resend request. It will not retry automatically.";

function mgSupportApprovedInvoiceResendAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  if (action.type !== MG_SUPPORT_INVOICE_RESEND_TYPE) return null;
  const token = String(action.confirmation_token || "").trim();
  if (!token) return null;
  return {
    type: MG_SUPPORT_INVOICE_RESEND_TYPE,
    label: MG_SUPPORT_INVOICE_RESEND_LABEL,
    confirmation_token: token,
    expires_at: String(action.expires_at || ""),
  };
}

function mgSupportInvoiceResendPostBody(action) {
  return {
    confirmation_token: String(action && action.confirmation_token ? action.confirmation_token : ""),
    confirmed: true,
  };
}

function mgSupportMapInvoiceResendClientResult(data, transportError) {
  if (transportError) {
    return { kind: "transport_unknown", text: MG_SUPPORT_INVOICE_RESEND_TRANSPORT, showCase: false };
  }
  const status = String(data && data.action_status ? data.action_status : "");
  const code = String(data && data.result_code ? data.result_code : "");
  if (status === "bridge_accepted") {
    return { kind: "success", text: MG_SUPPORT_INVOICE_RESEND_SUCCESS, showCase: false };
  }
  if (status === "submission_unknown") {
    return {
      kind: "unknown",
      text: MG_SUPPORT_INVOICE_RESEND_UNKNOWN,
      showCase: Boolean(data && data.escalation && data.escalation.eligible && data.escalation.confirmation_token),
      escalation: data && data.escalation,
    };
  }
  if (status === "already_claimed" || code === "already_claimed") {
    return { kind: "claimed", text: MG_SUPPORT_INVOICE_RESEND_CLAIMED, showCase: false };
  }
  if (status === "expired" || code === "expired") {
    return { kind: "expired", text: MG_SUPPORT_INVOICE_RESEND_EXPIRED, showCase: false };
  }
  if (code === "invoice_state_changed") {
    return { kind: "changed", text: MG_SUPPORT_INVOICE_RESEND_CHANGED, showCase: false };
  }
  return { kind: "transport_unknown", text: MG_SUPPORT_INVOICE_RESEND_TRANSPORT, showCase: false };
}

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const API = "/.netlify/functions/mg-support-chat";
  const CREATE_CASE_API = "/.netlify/functions/mg-support-create-case";
  const INVOICE_RESEND_API = MG_SUPPORT_INVOICE_RESEND_API;
  const SUGGESTIONS = [
    "What does Minimum Floor mean?",
    "How do I create an invoice?",
    "How does Contract Hub work?",
  ];

  const SUPPORT_DOCK_MQ = "(min-width: 1100px)";

  let open = false;
  let sending = false;
  let messages = [];
  let lastFocus = null;
  let mounted = false;

  function isDesktopDock() {
    try {
      return window.matchMedia(SUPPORT_DOCK_MQ).matches;
    } catch (_err) {
      return false;
    }
  }

  function ensureWorkspace() {
    let workspace = document.getElementById("mgAppWorkspace");
    if (workspace) return workspace;
    const main = document.getElementById("mgAppMain");
    if (!main || !main.parentNode) return null;
    workspace = document.createElement("div");
    workspace.id = "mgAppWorkspace";
    workspace.className = "mg-app-workspace";
    main.parentNode.insertBefore(workspace, main);
    workspace.appendChild(main);
    return workspace;
  }

  function ensureDockHost() {
    let host = document.getElementById("mgSupportDockHost");
    if (host) return host;
    host = document.createElement("aside");
    host.id = "mgSupportDockHost";
    host.className = "mg-support-dock-host";
    host.hidden = true;
    host.setAttribute("aria-hidden", "true");
    const workspace = ensureWorkspace();
    if (workspace) workspace.appendChild(host);
    else document.body.appendChild(host);
    return host;
  }

  function syncDockLayout() {
    const drawer = document.getElementById("mgSupportDrawer");
    const overlay = document.getElementById("mgSupportOverlay");
    const host = document.getElementById("mgSupportDockHost");
    if (!drawer || !overlay) return;
    const docked = open && isDesktopDock();
    drawer.hidden = !open;
    overlay.hidden = !open || docked;
    if (host) {
      host.hidden = !open;
      host.setAttribute("aria-hidden", open ? "false" : "true");
    }
    document.body.classList.toggle("mg-support-docked", docked);
    drawer.setAttribute("aria-modal", docked ? "false" : "true");
  }

  function isOwnerShell() {
    const mode =
      typeof window.MGAppNav?.getPortalMode === "function"
        ? window.MGAppNav.getPortalMode()
        : "owner";
    if (mode && mode !== "owner") return false;
    const body = document.body;
    if (!body || !body.hasAttribute("data-mg-app-nav")) return false;
    if (body.getAttribute("data-sales-dual-auth") === "true" && mode !== "owner") return false;
    if (body.getAttribute("data-supervisor-dual-auth") === "true" && mode !== "owner") return false;
    return true;
  }

  function currentPage() {
    try {
      return window.location.pathname || "";
    } catch (_err) {
      return "";
    }
  }

  function escapeHtml(value) {
    return mgSupportEscapeHtml(value);
  }

  function actionsHost() {
    return document.getElementById("mgTopbarActions");
  }

  function ensureMounted() {
    if (!isOwnerShell()) {
      teardown();
      return;
    }
    if (mounted) {
      const btn = document.getElementById("mgSupportOpenBtn");
      if (btn) btn.hidden = false;
      return;
    }

    const actions = actionsHost();
    if (!actions) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "mgSupportOpenBtn";
    btn.className = "mg-support-open-btn";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-controls", "mgSupportDrawer");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "Ask Margin Guard";
    actions.appendChild(btn);
    btn.addEventListener("click", function () {
      setOpen(true);
    });

    const dockHost = ensureDockHost();
    dockHost.innerHTML =
      '<div class="mg-support-overlay" id="mgSupportOverlay" hidden></div>' +
      '<aside class="mg-support-drawer" id="mgSupportDrawer" role="dialog" aria-modal="true" aria-labelledby="mgSupportTitle" hidden>' +
      '  <header class="mg-support-header">' +
      '    <div class="mg-support-header__text">' +
      '      <h2 id="mgSupportTitle">Ask Margin Guard</h2>' +
      '      <p class="mg-support-subtitle">Margin Guard Support</p>' +
      "    </div>" +
      '    <button type="button" class="mg-support-close" id="mgSupportCloseBtn" aria-label="Close Ask Margin Guard">Close</button>' +
      "  </header>" +
      '  <div class="mg-support-thread" id="mgSupportThread" aria-live="polite"></div>' +
      '  <form class="mg-support-composer" id="mgSupportForm">' +
      '    <label class="visually-hidden" for="mgSupportInput">Ask Margin Guard</label>' +
      '    <textarea id="mgSupportInput" name="message" rows="2" maxlength="1200" placeholder="Ask how to use Margin Guard"></textarea>' +
      '    <button type="submit" class="btn primary mg-support-send" id="mgSupportSendBtn">Send</button>' +
      "  </form>" +
      "</aside>";

    document.getElementById("mgSupportOverlay").addEventListener("click", function () {
      setOpen(false);
    });
    document.getElementById("mgSupportCloseBtn").addEventListener("click", function () {
      setOpen(false);
    });
    document.getElementById("mgSupportForm").addEventListener("submit", function (event) {
      event.preventDefault();
      void submitQuestion();
    });
    document.getElementById("mgSupportInput").addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submitQuestion();
      }
    });
    document.addEventListener("keydown", onGlobalKey);
    if (window.matchMedia) {
      const mq = window.matchMedia(SUPPORT_DOCK_MQ);
      const onMq = function () {
        if (open) syncDockLayout();
      };
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
      else if (typeof mq.addListener === "function") mq.addListener(onMq);
    }

    mounted = true;
    renderThread();
  }

  function teardown() {
    const btn = document.getElementById("mgSupportOpenBtn");
    if (btn) btn.hidden = true;
    if (open) setOpen(false);
  }

  function onGlobalKey(event) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  function setOpen(next) {
    if (!mounted && next) ensureMounted();
    if (!isOwnerShell() && next) return;
    open = !!next;
    const drawer = document.getElementById("mgSupportDrawer");
    const overlay = document.getElementById("mgSupportOverlay");
    const btn = document.getElementById("mgSupportOpenBtn");
    if (!drawer || !overlay) return;
    drawer.hidden = !open;
    document.body.classList.toggle("mg-support-open", open);
    syncDockLayout();
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      lastFocus = document.activeElement;
      const input = document.getElementById("mgSupportInput");
      if (input) input.focus();
    } else if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus();
    } else if (btn) {
      btn.focus();
    }
  }

  function renderThread() {
    const thread = document.getElementById("mgSupportThread");
    if (!thread) return;
    if (!messages.length) {
      thread.innerHTML =
        '<div class="mg-support-intro">' +
        "<p>Ask me how to use Margin Guard.</p>" +
        '<div class="mg-support-suggestions" role="group" aria-label="Suggested questions">' +
        SUGGESTIONS.map(function (q) {
          return (
            '<button type="button" class="mg-support-chip" data-mg-support-q="' +
            escapeHtml(q) +
            '">' +
            escapeHtml(q) +
            "</button>"
          );
        }).join("") +
        "</div></div>";
      thread.querySelectorAll("[data-mg-support-q]").forEach(function (chip) {
        chip.addEventListener("click", function () {
          const q = chip.getAttribute("data-mg-support-q") || "";
          const input = document.getElementById("mgSupportInput");
          if (input) input.value = q;
          void submitQuestion();
        });
      });
      return;
    }

    thread.innerHTML = messages
      .map(function (msg, idx) {
        if (msg.role === "user") {
          return '<div class="mg-support-msg mg-support-msg--user"><p>' + escapeHtml(msg.text) + "</p></div>";
        }
        if (msg.role === "error") {
          return (
            '<div class="mg-support-msg mg-support-msg--error" role="alert"><p>' +
            escapeHtml(msg.text) +
            '</p><button type="button" class="btn ghost mg-support-retry" data-retry-index="' +
            idx +
            '">Try again</button></div>'
          );
        }
        const sources = Array.isArray(msg.sources) && msg.sources.length
          ? '<p class="mg-support-source">Source: ' + escapeHtml(msg.sources.join(", ")) + "</p>"
          : "";
        const needs = msg.feedback === "down" ? '<p class="mg-support-needs">This answer needs improvement.</p>' : "";
        const loading = msg.pending
          ? '<p class="mg-support-loading" aria-live="polite">Thinking…</p>'
          : "";
        const fb =
          msg.pending || msg.role !== "assistant"
            ? ""
            : '<div class="mg-support-feedback" role="group" aria-label="Rate this answer">' +
              '<button type="button" class="mg-support-fb' +
              (msg.feedback === "up" ? " is-on" : "") +
              '" data-fb="up" data-msg="' +
              idx +
              '" aria-label="Helpful" aria-pressed="' +
              (msg.feedback === "up" ? "true" : "false") +
              '">👍</button>' +
              '<button type="button" class="mg-support-fb' +
              (msg.feedback === "down" ? " is-on" : "") +
              '" data-fb="down" data-msg="' +
              idx +
              '" aria-label="Not helpful" aria-pressed="' +
              (msg.feedback === "down" ? "true" : "false") +
              '">👎</button>' +
              "</div>";
        let caseBlock = "";
        if (msg.caseRef && msg.caseResult === "created") {
          caseBlock =
            '<p class="mg-support-source">Support case created: ' + escapeHtml(msg.caseRef) + "</p>";
        } else if (msg.caseRef && msg.caseResult === "existing_case") {
          caseBlock =
            '<p class="mg-support-source">An open support case already exists: ' +
            escapeHtml(msg.caseRef) +
            "</p>";
        } else if (msg.escalationEligible) {
          caseBlock =
            '<p>' +
            '<button type="button" class="btn ghost mg-support-retry" data-create-case="' +
            idx +
            '"' +
            (msg.casePending ? " disabled" : "") +
            ">Create support case</button>" +
            "</p>";
          if (msg.casePending) {
            caseBlock += '<p class="mg-support-loading" aria-live="polite">Creating support case…</p>';
          }
          if (msg.caseError) {
            caseBlock += '<p class="mg-support-needs" role="alert">' + escapeHtml(msg.caseError) + "</p>";
          }
        }
        let resendBlock = "";
        const approvedResend = mgSupportApprovedInvoiceResendAction(msg.resendAction);
        const showResendButton = Boolean(approvedResend && !msg.resendConsumed);
        if (showResendButton) {
          resendBlock =
            '<p>' +
            '<button type="button" class="btn primary mg-support-resend" data-resend-invoice="' +
            idx +
            '"' +
            (msg.resendPending || msg.resendLocked ? " disabled" : "") +
            ">" +
            MG_SUPPORT_INVOICE_RESEND_LABEL +
            "</button>" +
            "</p>";
          if (msg.resendPending) {
            resendBlock +=
              '<p class="mg-support-loading" aria-live="polite">' +
              MG_SUPPORT_INVOICE_RESEND_PENDING +
              "</p>";
          }
        }
        if (msg.resendResultText) {
          resendBlock +=
            '<p class="mg-support-needs" role="status">' + escapeHtml(msg.resendResultText) + "</p>";
        }
        return (
          '<div class="mg-support-msg mg-support-msg--assistant">' +
          (msg.text ? '<div class="mg-support-md">' + mgSupportRenderAssistantMarkdown(msg.text) + "</div>" : "") +
          loading +
          sources +
          fb +
          needs +
          resendBlock +
          caseBlock +
          "</div>"
        );
      })
      .join("");

    thread.querySelectorAll("[data-fb]").forEach(function (el) {
      el.addEventListener("click", function () {
        const i = Number(el.getAttribute("data-msg"));
        const kind = el.getAttribute("data-fb");
        if (!messages[i] || messages[i].role !== "assistant") return;
        messages[i].feedback = kind;
        renderThread();
      });
    });
    thread.querySelectorAll("[data-create-case]").forEach(function (el) {
      el.addEventListener("click", function () {
        const i = Number(el.getAttribute("data-create-case"));
        void submitSupportCase(i);
      });
    });
    thread.querySelectorAll("[data-resend-invoice]").forEach(function (el) {
      el.addEventListener("click", function () {
        const i = Number(el.getAttribute("data-resend-invoice"));
        void submitInvoiceResend(i);
      });
    });
    thread.querySelectorAll("[data-retry-index]").forEach(function (el) {
      el.addEventListener("click", function () {
        const i = Number(el.getAttribute("data-retry-index"));
        const err = messages[i];
        const prevUser = [...messages].slice(0, i).reverse().find(function (m) {
          return m.role === "user";
        });
        if (prevUser) {
          const input = document.getElementById("mgSupportInput");
          if (input) input.value = prevUser.text;
          void submitQuestion();
        }
      });
    });
    thread.scrollTop = thread.scrollHeight;
  }

  async function submitSupportCase(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== "assistant" || msg.casePending || msg.caseResult) return;
    const token = String(msg.confirmationToken || "");
    if (!token) return;
    msg.casePending = true;
    msg.caseError = "";
    renderThread();
    try {
      const res = await fetch(CREATE_CASE_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirmation_token: token, confirmed: true }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (data && (data.result === "created" || data.result === "existing_case") && data.case_ref) {
        msg.caseResult = data.result;
        msg.caseRef = String(data.case_ref);
        msg.escalationEligible = false;
        msg.confirmationToken = "";
        msg.casePending = false;
        msg.caseError = "";
      } else {
        msg.casePending = false;
        msg.caseError = String(data.error || "I couldn't create that support case right now.");
      }
    } catch (_err) {
      msg.casePending = false;
      msg.caseError = "I couldn't create that support case right now.";
    }
    renderThread();
  }

  async function submitInvoiceResend(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== "assistant") return;
    if (msg.resendPending || msg.resendLocked || msg.resendConsumed) return;
    const approved = mgSupportApprovedInvoiceResendAction(msg.resendAction);
    if (!approved) return;
    msg.resendPending = true;
    msg.resendLocked = true;
    msg.resendResultText = "";
    renderThread();
    let mapped;
    try {
      const res = await fetch(INVOICE_RESEND_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(mgSupportInvoiceResendPostBody(approved)),
      });
      const data = await res.json().catch(function () {
        return null;
      });
      if (!data) {
        mapped = mgSupportMapInvoiceResendClientResult(null, true);
      } else {
        mapped = mgSupportMapInvoiceResendClientResult(data, false);
      }
    } catch (_err) {
      mapped = mgSupportMapInvoiceResendClientResult(null, true);
    }
    msg.resendPending = false;
    msg.resendLocked = true;
    msg.resendResultText = mapped.text;
    if (mapped.kind === "success") {
      msg.resendConsumed = true;
      msg.resendAction = null;
    }
    if (mapped.showCase && mapped.escalation && mapped.escalation.confirmation_token) {
      msg.escalationEligible = true;
      msg.confirmationToken = String(mapped.escalation.confirmation_token);
    }
    renderThread();
  }

  async function submitQuestion() {
    if (sending) return;
    const input = document.getElementById("mgSupportInput");
    const text = String(input && input.value ? input.value : "").trim();
    if (!text) return;
    if (input) input.value = "";
    messages.push({ role: "user", text });
    messages.push({ role: "assistant", text: "", pending: true, sources: [] });
    sending = true;
    const sendBtn = document.getElementById("mgSupportSendBtn");
    if (sendBtn) sendBtn.disabled = true;
    renderThread();

    try {
      const res = await fetch(API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ message: text, page: currentPage() }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      messages = messages.filter(function (m) {
        return !m.pending;
      });
      if (!res.ok || !data.ok) {
        messages.push({
          role: "error",
          text: String(data.error || "Support AI is temporarily unavailable. Please try again."),
        });
      } else {
        messages.push({
          role: "assistant",
          text: String(data.answer || ""),
          sources: Array.isArray(data.sources) ? data.sources : [],
          feedback: "",
          escalationEligible: Boolean(
            data.escalation && data.escalation.eligible && data.escalation.confirmation_token
          ),
          confirmationToken:
            data.escalation && data.escalation.eligible
              ? String(data.escalation.confirmation_token || "")
              : "",
          resendAction: mgSupportApprovedInvoiceResendAction(data.action),
          resendPending: false,
          resendLocked: false,
          resendConsumed: false,
          resendResultText: "",
        });
      }
    } catch (_err) {
      messages = messages.filter(function (m) {
        return !m.pending;
      });
      messages.push({
        role: "error",
        text: "Support AI is temporarily unavailable. Please try again.",
      });
    } finally {
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
      renderThread();
      if (input) input.focus();
    }
  }

  function boot() {
    ensureMounted();
  }

  window.addEventListener("mg-app-nav-ready", function (event) {
    const mode = event && event.detail ? event.detail.mode : "owner";
    if (mode === "owner") boot();
    else teardown();
  });
  window.addEventListener("mg-app-nav-mode", function (event) {
    const mode = event && event.detail ? event.detail.mode : "";
    if (mode === "owner") boot();
    else teardown();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

if (typeof module === "object" && module.exports) {
  module.exports = {
    escapeHtml: mgSupportEscapeHtml,
    renderAssistantMarkdown: mgSupportRenderAssistantMarkdown,
    approvedInvoiceResendAction: mgSupportApprovedInvoiceResendAction,
    invoiceResendPostBody: mgSupportInvoiceResendPostBody,
    mapInvoiceResendClientResult: mgSupportMapInvoiceResendClientResult,
    INVOICE_RESEND_TYPE: MG_SUPPORT_INVOICE_RESEND_TYPE,
    INVOICE_RESEND_LABEL: MG_SUPPORT_INVOICE_RESEND_LABEL,
    INVOICE_RESEND_API: MG_SUPPORT_INVOICE_RESEND_API,
    INVOICE_RESEND_SUCCESS: MG_SUPPORT_INVOICE_RESEND_SUCCESS,
    INVOICE_RESEND_UNKNOWN: MG_SUPPORT_INVOICE_RESEND_UNKNOWN,
    INVOICE_RESEND_CLAIMED: MG_SUPPORT_INVOICE_RESEND_CLAIMED,
    INVOICE_RESEND_EXPIRED: MG_SUPPORT_INVOICE_RESEND_EXPIRED,
    INVOICE_RESEND_CHANGED: MG_SUPPORT_INVOICE_RESEND_CHANGED,
    INVOICE_RESEND_TRANSPORT: MG_SUPPORT_INVOICE_RESEND_TRANSPORT,
  };
}
