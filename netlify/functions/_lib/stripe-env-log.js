/**
 * Safe Stripe secret key diagnostics for Netlify function logs.
 * Project Deposit and other flows — does not log full keys.
 */
function logStripeSecretDiagnostics(stripeSecretKey, ctx) {
  const sk = String(stripeSecretKey || "");
  const prefix =
    sk.length >= 12 ? `${sk.slice(0, 12)}…` : sk.length ? `${sk.slice(0, Math.min(7, sk.length))}…` : "(empty)";
  const mode = sk.startsWith("sk_live_")
    ? "LIVE"
    : sk.startsWith("sk_test_")
      ? "TEST"
      : "UNKNOWN";
  console.log(`[${ctx}] STRIPE_KEY_PREFIX`, prefix);
  console.log(`[${ctx}] STRIPE_KEY_MODE`, mode);
}

module.exports = { logStripeSecretDiagnostics };
