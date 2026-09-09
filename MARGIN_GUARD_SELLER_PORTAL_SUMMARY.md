# Margin Guard — Portal Vendedor

Documento principal del portal Vendedor y de **Margin Guard Seller Shield V1**, con cableado **V2**.
Rama de implementación V2: `feat/seller-shield-v2`.
Base auditada: `origin/main` SHA `2e945256bf85e3ffcffca8fe53ae18cc215e1690`.
Worktree: `C:\Margin Guard System\margin-guard-seller-shield-v2`.

Dueño, Invoice Hub, Support y CI de esas superficies no forman parte de este protector. Este documento no es una copia del portal Dueño.

El check requerido de GitHub sigue llamándose **`Seller Shield V1`**. V2 no crea un segundo check.

---

## 1. Propósito del shield

Vendedor está estable en producción. Seller Shield es un **orquestador de contratos existentes**: impide que un cambio futuro (Dueño, Business Settings, Invoice Hub u otro modal) rompa auth, precios, publish/send, calendario, voz, pairing o aislamiento de tenant **antes** de commit, push o merge.

V2 ejecuta el **guard real** en CI. No congela CSS ni copy. No copia miles de líneas de tests. No afirma HMAC en el webhook de estimates. Cero cambios de producto en una PR solo-shield.

Patrones hermanos: Owner Shield V1, Invoice Hub Shield V2. Esos workflows no se modifican desde aquí.

---

## 2. Comandos

Modo requerido (predeterminado):

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

Scope guard y cableado V2:

```bash
node scripts/guard-seller-scope.js
node scripts/guard-seller-scope.js --self-test
node scripts/test-seller-shield-v2.js
```

`--full` es el único argumento extra permitido. Cualquier otro argumento falla con un error explícito. El modo predeterminado **no** ejecuta `scripts/test-mg-sales-ready-004b.js`.

CI (`.github/workflows/seller-shield-v1.yml`) corre required **y** `--full` en todos los PR, aunque no se haya tocado Seller. El guard real vive **dentro** de ese runner. Se omite en `merge_group`. El archivo del workflow no cambia respecto a `origin/main`.

---

## 3. Suites requeridas

Lista fija en `scripts/mg-seller-shield-v1.json` (12):

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
| `scripts/test-get-seller-business-settings.js` | device seller válido, tenant A ≠ B, snapshot más reciente, settings faltantes, sesión revocada |
| `scripts/test-seller-device-pairing.js` | código de 8 caracteres, rol seller, tenant, límite de devices, cookie, status/heartbeat/logout, UI de pairing |
| `scripts/test-seller-quote-number-allocation.js` | RPC `allocate_next_quote_number`, tenant obligatorio, RPC incompleto fail-safe, números distintos, sin fallback local |
| `scripts/test-seller-shield-v2.js` | workflow/job `Seller Shield V1` intacto vs `origin/main`; guard real dentro del runner requerido |

`qa-ch014-send-quote-price-guard.js` **no** es requerida: el test 13 (Dueño) falla en `main`.

Layout móvil crítico no tiene suite dedicada; no se simula cobertura.

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
- Business Settings de seller se leen del snapshot más reciente del tenant del device; tenant A no ve tenant B.
- Pairing seller: código de 8 caracteres, rol `seller`, tope de devices, cookie `mg_device_session`, status/heartbeat/logout.
- Numeración de quotes: solo RPC `allocate_next_quote_number`; respuesta incompleta no inserta.

---

## 6. Gaps conocidos

Los tres gaps de V1 tienen suite y se quitaron de `knownGaps`:

- `get-seller-business-settings` → `scripts/test-get-seller-business-settings.js`
- Pairing UI → `scripts/test-seller-device-pairing.js`
- quote-number collision → `scripts/test-seller-quote-number-allocation.js`

`knownGaps` está vacío. No reintroducir esos nombres sin una suite que falle en rojo.

---

## 7. Webhook de estimate (sin HMAC)

`send-quote-zapier` publica un POST JSON al webhook configurado. **No hay HMAC** en este flujo.

No copiar las garantías HMAC de contratos (`qa-ch013*`) ni de Invoice Hub. El contrato congelado aquí es: gate de status, tenant/device, sin insertar `tenant_projects`, y tests sin POST real.

---

## 8. CI — Seller Shield V1 (V2 wiring)

Hay un GitHub workflow. El check requerido se llama exactamente **`Seller Shield V1`**. El YAML del workflow es el de `origin/main` (V2 no lo reescribe).

En cada PR a `main`:

1. `node scripts/test-mg-seller-shield-v1-runner.js`
2. `node scripts/guard-seller-scope.js --self-test`
3. `node scripts/test-mg-seller-shield-v1.js` — incluye el **guard real**
4. `node scripts/test-mg-seller-shield-v1.js --full` — vuelve a incluir el guard real

El runner lee `GITHUB_EVENT_PATH` (base SHA, título, head), hace fetch limitado del SHA si falta, y ejecuta `node scripts/guard-seller-scope.js` con `BASE_REF` / `PR_TITLE` / `GITHUB_HEAD_REF` por `env`. Un fallo del guard es `exit 1` del runner. Nunca se establece `ALLOW_SELLER_TOUCH=1`. El guard real se omite en `merge_group`.

`scripts/test-seller-shield-v2.js` entra como suite requerida y congela esta integración.

Un PR no-Seller que toque la superficie protegida hace fallar el mismo check. Un PR Seller autorizado pasa el guard e imprime `SELLER_REGRESSION_REQUIRED=1`; las suites required/`--full` corren igual.

Owner Shield V1 e Invoice Hub Shield V2 no se ejecutan desde este workflow y no se modifican.

---

## 9. Resultados medidos

Medidos en `feat/seller-shield-v2` (base `2e945256`) el 2026-09-09. Sin red real.

| Comando | Resultado | Notas |
| --- | --- | --- |
| `node scripts/test-mg-seller-shield-v1-runner.js` | PASS | 68 passed |
| `node scripts/guard-seller-scope.js --self-test` | PASS | 34 self-tests |
| `node scripts/test-seller-shield-v2.js` | PASS | 43 passed |
| `node scripts/test-get-seller-business-settings.js` | PASS | 21 passed |
| `node scripts/test-seller-device-pairing.js` | PASS | 37 passed |
| `node scripts/test-seller-quote-number-allocation.js` | PASS | 24 passed |
| `node scripts/test-mg-seller-shield-v1.js` | PASS | required 12/12; 818 passed; guard real incluido; 004b no |
| `node scripts/test-mg-seller-shield-v1.js --full` | PASS | required 12/12 + optional 1; 905 passed |
| `git diff --check` | limpio | workflow Seller = `origin/main` |

`knownGaps` está vacío. Ningún archivo de producto modificado.

---

## 10. Cómo agregar una suite futura sin debilitar el gate

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

## 11. Scope guard

`scripts/guard-seller-scope.js` compara el árbol (incluye sucio) contra `origin/main`. Alcance explícito: rama con `seller` / `voice-plan` / `seller-shield`, `ALLOW_SELLER_TOUCH=1` (nunca en el workflow), o título `[Seller]`.

No toca Invoice Hub ni Dueño por archivo exclusivo. `public/js/app.js` y libs compartidas solo fallan si el diff coincide con markers de Vendedor, o si el diff compartido es ilegible (fail safe).

Ver `docs/SELLER_PROTECTED_SURFACE.md` para la superficie protegida y las regiones compartidas.
