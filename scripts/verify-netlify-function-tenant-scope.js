#!/usr/bin/env node
/**
 * Verificación estática mínima: cada handler en netlify/functions/*.js que use
 * supabaseRequest o REST /rest/v1/ hacia Supabase debe incluir al menos un
 * patrón de acotación documentado, o estar en netlify-function-tenant-scope-allowlist.json
 *
 * No sustituye revisión de código ni pruebas de integración.
 * Uso: node scripts/verify-netlify-function-tenant-scope.js
 * Código distinto de 0 = fallo.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const FUNCTIONS_DIR = path.join(REPO_ROOT, "netlify", "functions");
const ALLOWLIST_PATH = path.join(__dirname, "netlify-function-tenant-scope-allowlist.json");

/** Patrones que cuentan como “acotado” para el verificador v1 (substring en el archivo). */
const SAFE_SUBSTRINGS = [
  "tenant_id=eq.",
  "tenant_id=not.is.null",
  "public_token=eq.",
  "stripe_customer_id=eq.",
  "tenant_id:",
  "tenants?id=eq.",
  "profiles?tenant_id=eq."
];

function usesSupabaseRest(src) {
  return (
    src.includes("supabaseRequest") ||
    src.includes("/rest/v1/") ||
    src.includes("rest/v1/quotes") ||
    src.includes("rest/v1/${")
  );
}

function passesHeuristic(src) {
  return SAFE_SUBSTRINGS.some((s) => src.includes(s));
}

function loadAllowlist() {
  try {
    const raw = fs.readFileSync(ALLOWLIST_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[verify-netlify-function-tenant-scope] No se pudo leer allowlist:", e.message);
    process.exit(1);
  }
}

function main() {
  const allowlist = loadAllowlist();
  const names = fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith(".js"));

  const failures = [];

  for (const name of names) {
    const full = path.join(FUNCTIONS_DIR, name);
    let src;
    try {
      src = fs.readFileSync(full, "utf8");
    } catch (e) {
      failures.push({ file: name, reason: `lectura: ${e.message}` });
      continue;
    }

    if (!usesSupabaseRest(src)) {
      continue;
    }

    if (passesHeuristic(src)) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(allowlist, name)) {
      continue;
    }

    failures.push({
      file: name,
      reason:
        "Usa supabaseRequest o /rest/v1/ pero no coincide con ningún patrón SAFE_SUBSTRINGS ni está en allowlist."
    });
  }

  if (failures.length) {
    console.error("[verify-netlify-function-tenant-scope] FALLÓ:\n");
    for (const f of failures) {
      console.error(`  - ${f.file}: ${f.reason}`);
    }
    console.error(
      "\nPatrones seguros esperados (al menos uno):",
      SAFE_SUBSTRINGS.join(", ")
    );
    console.error(
      "\nSi el archivo es una excepción legítima, documentarla en scripts/netlify-function-tenant-scope-allowlist.json"
    );
    process.exit(1);
  }

  console.log(
    "[verify-netlify-function-tenant-scope] OK: todos los handlers con Supabase REST pasan heurística o allowlist."
  );
  process.exit(0);
}

main();
