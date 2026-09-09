# Margin Guard — Portal Vendedor

Documento principal del portal Vendedor y de **Margin Guard Seller Shield V1**.
Rama de implementación: `feat/seller-shield-v1`.
Base auditada: `origin/main` SHA `87a214b4e851b4d4d744833ac34870ffd6312304`.
Worktree: `C:\Margin Guard System\margin-guard-seller-shield-v1`.

Dueño, Invoice Hub, Support y CI no forman parte de este protector. Este documento no es una copia del portal Dueño.

---

## 1. Propósito del shield

Vendedor está estable en producción. Seller Shield V1 es un **orquestador de contratos existentes**: impide que un cambio futuro rompa auth, precios, publish/send, calendario, voz o aislamiento de tenant **antes** de commit, push o merge.

No congela CSS ni copy. No copia miles de líneas de tests. No afirma HMAC en el webhook de estimates.

Patrón hermano: Invoice Hub Shield V1 (`docs/INVOICE_HUB_PROTECTED_SURFACE.md`).

---

## 2. Comandos

Modo requerido (predeterminado, objetivo 4–8s):

```bash
node scripts/test-mg-seller-shield-v1.js
```

Modo completo (requeridas + opcionales, incluye 004B):

```bash
node scripts/test-mg-seller-shield-v1.js --full
```

Prueba aislada del runner:

```bash
node scripts/test-mg-seller-shield-v1-runner.js
```

Scope guard (archivos Seller fuera de un PR Seller):

```bash
node scripts/guard-seller-scope.js
node scripts/guard-seller-scope.js --self-test
```

`--full` es el único argumento extra permitido. Cualquier otro argumento falla con un error explícito. El modo predeterminado **no** ejecuta `scripts/test-mg-sales-ready-004b.js`.

---

## 3. Suites requeridas

Lista fija en `scripts/mg-seller-shield-v1.json`:

| Suite | Contratos |
| --- | --- |
| `scripts/test-seller-hours-publish-parity.js` | hours-only → worker-days, labor vacía no INSERT, `hoursPerDay` autoritativo, total de servidor, quote no enviable, reset post-send, sin confirmación falsa |
| `scripts/test-owner-seller-send-dual-auth.js` | owner moderno + device seller, aislamiento de tenant, un clic / in-flight, publish antes de Zapier |
| `scripts/test-signing-calendar-reservation.js` | crear/guardar/firmar/enviar no reserva; reserva tras aceptación |
| `scripts/test-voice-operational-plan-phase1.js` | Confirm and apply, Client Scope vs Internal Plan, hoursPerDay, privacidad de plan interno |
| `scripts/test-voice-operational-plan-phase2.js` | New/Continue dictation, interpret no aplica, ES/EN, sin audio, strip de rates |
| `scripts/qa-ch015-target-finish-sync.js` | Target Finish no revive de un proyecto anterior |
| `scripts/test-mg-sales-ready-004c.js` | device, branding, tenant A ≠ tenant B |
| `scripts/qa-ch008a-scheduling-payment.js` | totales, minimum price, depósito, contratos de publish |

`qa-ch014-send-quote-price-guard.js` **no** es requerida: el test 13 (Dueño) falla en `main`.

Layout móvil crítico no tiene suite dedicada; no se simula cobertura. Ver gaps.

---

## 4. Suites opcionales

| Suite | Por qué es opcional |
| --- | --- |
| `scripts/test-mg-sales-ready-004b.js` | ~8.7s (zip-it); RLS y functions adyacentes de Invoice Hub |

Solo entra con `--full`.

---

## 5. Contratos protegidos

- Owner moderno puede usar el send de Vendedor autorizado; seller requiere device válido; un seller no toma el tenant de otro.
- Tarifas del tenant y `hoursPerDay` autenticado son autoritativos.
- Labor hours-only se convierte a worker-days; labor vacía no publica.
- Minimum price y total de servidor en publish.
- Quote inválida / no enviable se bloquea; un clic no dispara send duplicado; publish y send mantienen orden.
- Estimate Zapier: **webhook JSON sin firma** (no HMAC). Tests no envían email ni quotes reales.
- Reset del formulario solo después de éxito; Target Finish no contamina el siguiente proyecto.
- Calendario: reserva únicamente tras aceptación o scheduling autorizado.
- Voz: New/Continue, interpret no aplica, Confirm and apply obligatorio, Client Scope vs Internal Plan, sin audio, ES/EN.
- Branding de tenant aislado en la ruta seller.
- Costos internos no viajan en el cuerpo público / Zapier / interpret (Phase 1–2). El CSS premium del transcript no es un contrato de este shield.

---

## 6. Gaps conocidos

El runner **siempre** imprime estas líneas. No fallan el gate:

```
KNOWN GAP — NOT YET PROTECTED: get-seller-business-settings
KNOWN GAP — NOT YET PROTECTED: Pairing UI
KNOWN GAP — NOT YET PROTECTED: quote-number collision
```

No hay pruebas superficiales que finjan cubrirlos.

---

## 7. Webhook de estimate (sin HMAC)

`send-quote-zapier` publica un POST JSON al webhook configurado. **No hay HMAC** en este flujo.

No copiar las garantías HMAC de contratos (`qa-ch013*`) ni de Invoice Hub. El contrato congelado aquí es: gate de status, tenant/device, sin insertar `tenant_projects`, y tests sin POST real.

---

## 8. Resultados medidos

Medidos en `feat/seller-shield-v1` (base `87a214b`) el 2026-09-09. Sin red real.

| Comando | Resultado | Suites | Pruebas | Duración |
| --- | --- | --- | --- | --- |
| `node scripts/test-mg-seller-shield-v1-runner.js` | PASS | fixtures | 50 passed | 314ms |
| `node scripts/guard-seller-scope.js --self-test` | PASS | — | 11 passed | 51ms |
| `node scripts/test-mg-seller-shield-v1.js` | PASS | required 8/8; 004b no | 693 | 2916ms |
| `node scripts/test-mg-seller-shield-v1.js --full` | PASS | required 8/8 + optional 1 | 780 | 3992ms |

Gaps impresos en ambos modos del shield (no fallan):

```
KNOWN GAP — NOT YET PROTECTED: get-seller-business-settings
KNOWN GAP — NOT YET PROTECTED: Pairing UI
KNOWN GAP — NOT YET PROTECTED: quote-number collision
```

`git diff --check` limpio. Ningún archivo de producto ni test existente modificado.

---

## 9. Cómo agregar una suite futura sin debilitar el gate

1. La suite debe ser Node aislada: sin red real, sin secretos reales, sin escribir producción.
2. Debe imprimir un resumen reconocible (`N passed`, `Passed N assertions`, o `N assertions passed`) y salir `0` solo si pasó.
3. Añadir una entrada en `scripts/mg-seller-shield-v1.json`:
   - `required` si el contrato es de Vendedor y la suite corre en pocos segundos.
   - `optional` si es lenta o adyacente (Hub/RLS).
4. Poner `minPassed` en el conteo **actual** (el runner falla si baja).
5. No mover una requerida a opcional para hacer verde un cambio.
6. No añadir una suite que necesite Netlify, Supabase, Zapier, OpenAI o email reales.
7. Correr `node scripts/test-mg-seller-shield-v1-runner.js` y el modo requerido.
8. Actualizar esta tabla.

Una requerida faltante, con exit ≠ 0, con cero tests, o sin resumen reconocible es **FAIL**. Nunca SKIP.

---

## 10. Scope guard

`scripts/guard-seller-scope.js` compara el árbol (incluye sucio) contra `origin/main`. Alcance explícito: rama con `seller` / `voice-plan` / `seller-shield`, `ALLOW_SELLER_TOUCH=1`, o título `[Seller]`.

No toca Invoice Hub. `public/js/app.js` y libs compartidas solo fallan si el diff coincide con markers de Vendedor.
