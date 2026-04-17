/**
 * Browser Supabase client for pages that need direct table access (optional).
 * Set before this script (recommended: Netlify inject or meta tags — no hardcoded project keys):
 *   window.__MG_SUPABASE_URL
 *   window.__MG_SUPABASE_ANON_KEY
 * Fallback when globals are unset: <meta name="mg-supabase-url" content="..."> and
 * <meta name="mg-supabase-anon-key" content="..."> (empty content is ignored).
 */
(function () {
  let URL =
    typeof window.__MG_SUPABASE_URL === "string" && window.__MG_SUPABASE_URL.trim()
      ? window.__MG_SUPABASE_URL.trim()
      : "";
  let ANON =
    typeof window.__MG_SUPABASE_ANON_KEY === "string" && window.__MG_SUPABASE_ANON_KEY.trim()
      ? window.__MG_SUPABASE_ANON_KEY.trim()
      : "";

  if (!URL) {
    const m = document.querySelector('meta[name="mg-supabase-url"]');
    const c = m && m.getAttribute("content");
    if (c && String(c).trim()) URL = String(c).trim();
  }
  if (!ANON) {
    const m = document.querySelector('meta[name="mg-supabase-anon-key"]');
    const c = m && m.getAttribute("content");
    if (c && String(c).trim()) ANON = String(c).trim();
  }

  if (!URL || !ANON) {
    return;
  }

  if (typeof window.supabase === "undefined" || typeof window.supabase.createClient !== "function") {
    return;
  }
  if (window.supabaseClient && typeof window.supabaseClient.from === "function") {
    return;
  }
  try {
    const client = window.supabase.createClient(URL, ANON);
    window.supabaseClient = client;
    window.sb = client;
  } catch (_err) {
    /* leave client unset */
  }
})();
