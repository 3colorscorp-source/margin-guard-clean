/**
 * Premium quote-send confirmation UI (owner + sales send modals).
 * Uses only server-provided public URLs for links (never client tenant_id).
 */
(function (global) {
  var NS = "__MG_QUOTE_SEND_FEEDBACK__";

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitizeHttpUrl(raw) {
    var u = String(raw || "").trim();
    if (!/^https?:\/\//i.test(u)) return "";
    try {
      var o = new URL(u);
      if (o.protocol !== "http:" && o.protocol !== "https:") return "";
      return o.href;
    } catch (_e) {
      return "";
    }
  }

  function baseNoticeClass(el) {
    return (el && el.getAttribute("data-mg-send-status-class")) || "notice";
  }

  function stripToPlainNotice(el) {
    if (!el) return;
    el.innerHTML = "";
    el.className = baseNoticeClass(el);
  }

  function clear(el) {
    if (!el) return;
    el.style.display = "none";
    el.innerHTML = "";
    el.textContent = "";
    el.className = baseNoticeClass(el);
    el.removeAttribute("role");
  }

  function showPlain(el, className, text) {
    if (!el) return;
    stripToPlainNotice(el);
    el.className = baseNoticeClass(el) + (className ? " " + className : "");
    el.textContent = text || "";
    el.style.display = "block";
  }

  function render(el, opts) {
    if (!el) return;
    opts = opts || {};
    var variant = opts.variant === "warning" ? "warning" : opts.variant === "error" ? "error" : "success";
    var title = opts.title || (variant === "warning" ? "Action needed" : variant === "error" ? "Something went wrong" : "Done");
    var lines = Array.isArray(opts.detailLines) ? opts.detailLines.filter(Boolean) : [];
    var publicUrl = sanitizeHttpUrl(opts.publicUrl);
    var base = baseNoticeClass(el);

    var hintsHtml = lines
      .map(function (t) {
        return '<p class="mg-quote-send-card__hint">' + escapeHtml(t) + "</p>";
      })
      .join("");

    var openBtn =
      publicUrl && opts.showPublicLink !== false
        ? '<a class="btn secondary mg-quote-send-card__cta" href="' +
          escapeHtml(publicUrl) +
          '" target="_blank" rel="noopener noreferrer">Open public quote</a>'
        : "";

    var iconSvg =
      variant === "success"
        ? '<svg class="mg-quote-send-card__glyph" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
        : variant === "warning"
          ? '<svg class="mg-quote-send-card__glyph" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>'
          : '<svg class="mg-quote-send-card__glyph" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';

    el.className = base + " mg-quote-send-card mg-quote-send-card--" + variant;
    el.innerHTML =
      '<div class="mg-quote-send-card__shell">' +
      '<div class="mg-quote-send-card__row">' +
      '<div class="mg-quote-send-card__mark" aria-hidden="true">' +
      iconSvg +
      "</div>" +
      '<div class="mg-quote-send-card__body">' +
      '<div class="mg-quote-send-card__title">' +
      escapeHtml(title) +
      "</div>" +
      hintsHtml +
      (openBtn ? '<div class="mg-quote-send-card__actions">' + openBtn + "</div>" : "") +
      "</div></div></div>";
    el.style.display = "block";
    el.setAttribute("role", "status");
  }

  function renderQuoteZapierOutcome(el, ctx) {
    ctx = ctx || {};
    var publishData = ctx.publishData || {};
    var zapData = ctx.zapData || {};
    var hadPdfPayload = Boolean(ctx.hadPdfPayload);
    var publicUrlRaw =
      ctx.publicQuoteUrl || publishData.public_url || zapData.public_quote_url || "";
    var publicUrl = sanitizeHttpUrl(publicUrlRaw);
    var zap = zapData.zapier != null ? String(zapData.zapier) : "";
    var pdfOk = Boolean(zapData.pdfUrl);
    var pdfFailed = hadPdfPayload && (!pdfOk || Boolean(zapData.pdfUploadError));
    var emailFailed = /^error_/.test(zap) || zap === "error_network";
    var emailOk = zap === "ok";

    if (emailFailed || pdfFailed) {
      var title = "Quote was created, but delivery needs attention.";
      var details = [];
      if (emailFailed && pdfFailed) {
        details.push(
          "The proposal link is ready, but the PDF attachment and automated email need attention."
        );
        details.push("Check Zapier or resend from the quote actions.");
      } else if (emailFailed) {
        title = "Quote was created, but email delivery needs attention.";
        details.push("Check Zapier or resend from the quote actions.");
      } else {
        title = "Quote was created, but the PDF attachment needs attention.";
        details.push("Check Zapier or resend from the quote actions.");
      }
      render(el, { variant: "warning", title: title, detailLines: details, publicUrl: publicUrl });
      return { variant: "warning", publicUrl: publicUrl };
    }

    var detailLines = [];
    detailLines.push(
      emailOk
        ? "Your client received the proposal with the approval and deposit link."
        : "Use the public link below so your client can review, approve, and pay the deposit."
    );
    if (pdfOk) detailLines.push("PDF proposal attached.");
    if (emailOk) detailLines.push("Email delivery confirmed.");
    render(el, {
      variant: "success",
      title: "Quote sent successfully",
      detailLines: detailLines,
      publicUrl: publicUrl
    });
    return { variant: "success", publicUrl: publicUrl };
  }

  function renderSendError(el, friendlyMessage) {
    render(el, {
      variant: "error",
      title: friendlyMessage || "Something went wrong",
      detailLines: ["Please try again. If this keeps happening, contact support."],
      showPublicLink: false
    });
  }

  function friendlySendFailureMessage(err) {
    var raw = err && (err.message || String(err));
    if (/Unable to create public quote link/i.test(raw)) {
      return "We couldn't create the public link. Please try again.";
    }
    if (/Published total does not match/i.test(raw)) {
      return "Totals changed while sending. Refresh the page and try again.";
    }
    if (/Unauthorized|Forbidden/i.test(raw)) {
      return "Your session may have expired. Sign in again and retry.";
    }
    if (/Unable to complete send|Unable to send estimate/i.test(raw)) {
      return "We couldn't complete the send. Please try again.";
    }
    if (/PDF generation failed/i.test(raw)) {
      return "We couldn't generate the PDF. Refresh the page and try again.";
    }
    return "Something went wrong. Please try again.";
  }

  global[NS] = {
    clear: clear,
    stripToPlainNotice: stripToPlainNotice,
    showPlain: showPlain,
    render: render,
    renderQuoteZapierOutcome: renderQuoteZapierOutcome,
    renderSendError: renderSendError,
    friendlySendFailureMessage: friendlySendFailureMessage,
    sanitizeHttpUrl: sanitizeHttpUrl
  };
})(typeof window !== "undefined" ? window : globalThis);
