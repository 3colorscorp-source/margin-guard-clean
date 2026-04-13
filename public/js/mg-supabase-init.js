/**
 * Browser Supabase client for pages that need direct table access (optional).
 * URL/key can be overridden before this script runs:
 *   window.__MG_SUPABASE_URL
 *   window.__MG_SUPABASE_ANON_KEY
 */
(function () {
  const URL =
    typeof window.__MG_SUPABASE_URL === "string" && window.__MG_SUPABASE_URL.trim()
      ? window.__MG_SUPABASE_URL.trim()
      : "https://yaagobzgozzozibublmj.supabase.co";
  const ANON =
    typeof window.__MG_SUPABASE_ANON_KEY === "string" && window.__MG_SUPABASE_ANON_KEY.trim()
      ? window.__MG_SUPABASE_ANON_KEY.trim()
      : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhYWdvYnpnb3p6b3ppYnVibG1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NjE3MjgsImV4cCI6MjA4NzEzNzcyOH0.Ogt7cEt3jRiEGtA8-dXXSZyRJtJfZqVfPAErz6cM7aU";

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
