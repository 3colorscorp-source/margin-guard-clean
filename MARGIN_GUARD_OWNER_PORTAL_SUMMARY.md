# Margin Guard — Portal Dueño

Documento principal del proyecto Dueño. Rama: `feat/owner-voice-parity`.
Base: `origin/main` SHA `b02ac413a9722424d23b454b4bef563267696341`.
Worktree: `C:\Margin Guard System\margin-guard-owner-voice`.
Vendedor se usa solo como referencia de lectura. Este documento no es una copia del portal Vendedor.

---

## 1. Objetivo del portal Dueño

Dueño (`/owner` → `public/owner.html`) es el motor de cotización del propietario: arma el quote actual, define plan operativo y labor, revisa el Scope of Work que verá el cliente, y envía o exporta la cotización.

En esta pantalla el Dueño:

- Carga datos del proyecto y del cliente.
- Construye el **Operational Plan** día por día.
- Revisa y edita **Scope of Work** (`#quoteNotes`) antes de enviarlo en PDF/email.
- Sincroniza o ajusta **Labor**.
- Ve el snapshot de precio recomendado.
- Envía la cotización o exporta PDF.

No es Business Settings, Invoice Hub, contratos ni autenticación. Esas superficies no forman parte de este proyecto.

---

## 2. Estado actual encontrado

Auditoría sobre `origin/main` `b02ac41`. Worktree limpio al crearse. Ningún archivo de Vendedor se modificó.

### Lo que Dueño ya tiene

- Ruta `/owner`.
- Sección **OPERATIONAL PLAN** con timeline, Add day, Generate Scope Draft, editor por día (`#ownerOpDayModal`).
- Scope of Work en `#quoteNotes` (máx. 2000). Generate Scope Draft puede anexar o reemplazar con confirmación.
- Labor con auto-sync desde el plan.
- Modal de envío con `#scope` y `#message` (campos de correo; no son la superficie de voz de Vendedor).
- Estado local `localStorage` clave `mg_owner_v2`.
- `public/js/app.js` renderiza y guarda el plan Dueño (`loadOwner` / `saveOwner` / `refreshOwnerAfterOpChange`).
- `internal_operational_plan` se anula al resetear el draft Dueño, pero Dueño **no tiene UI de voz** ni el modal de review/confirm.

### Fase 1 implementada (2026-09-08)

Dueño ya tiene captura + interpret + preview, sin apply:

- Botón **Review & confirm plan** (`#btnOwnerReviewConfirmOperationalPlan`) después de Generate Scope Draft.
- Modal `#ownerVoicePlanPreviewModal` (dictado, idiomas, transcript, preview dual).
- Script `public/js/owner-voice-operational-plan.js` y librería compartida `public/js/voice-operational-plan.js` (sin modificarla).
- Interpret llama `/.netlify/functions/voice-operational-plan-command` con JSON de texto.
- **Confirm and apply** visible pero deshabilitado (`CONFIRM_APPLY_ENABLED = false`).

### Lo que falta (Fase 2+)

- Apply a `#quoteNotes`, `operational_plan`, labor y fechas tras confirmación explícita.
- Hidratar `current_document` desde el plan Dueño (Fase 1 envía un documento vacío a propósito para no leer ni escribir `mg_owner_v2`).
- Persistencia `quote-internal-operational-plan` si hay `quoteId`.

---

## 3. Arquitectura y archivos relevantes (Dueño)

| Pieza | Ruta | Rol |
| --- | --- | --- |
| Página | `public/owner.html` | UI Dueño, plan, scope, labor, envío |
| Redirect | `netlify.toml` `/owner` → `/owner.html` | Ruta pública |
| Estado / render | `public/js/app.js` | `mg_owner_v2`, timeline, day modal, labor sync, send |
| Plan compartido (teclado) | `public/js/sales-operational-plan.js` | Normaliza días/crew; Dueño ya lo usa |
| Scope draft | script inline en `owner.html` | Generate / Accept / Clear Scope Draft |
| Calendario capacidad | `public/js/owner-capacity-ui.js`, `sales-capacity-calendar.js` | Fechas; no se cambia en este proyecto |
| Auth | `public/js/auth.js`, `tenant.js` | Fuera de alcance |

Campos largos en Dueño:

| Campo | ID | Uso | ¿Candidato de paridad de voz? |
| --- | --- | --- | --- |
| Scope of Work | `#quoteNotes` | Texto cliente en PDF/email | Sí, **después** de Confirm and apply, equivalente a `#salesMessageToClient` |
| Day editor | `#ownerOpDayModal` phase / task / crew | Edición manual de un día | Indirecto: el modal de voz edita el documento del plan, no cada input del day modal |
| Send: Scope / Notas | `#scope` | Cuerpo de correo | No. Vendedor no dicta aquí |
| Send: Mensaje | `#message` | Cuerpo de correo | No |
| Nombre negocio PDF | `#bizNameOwner` | Marca corta | No |

---

## 4. Diferencias Vendedor vs Dueño (solo las que afectan voz)

| Tema | Vendedor (`/sales`) | Dueño (`/owner`) |
| --- | --- | --- |
| Entrada de voz | Botón **Review & confirm plan** abre modal con dictado | No existe |
| Scope cliente | `#salesMessageToClient` | `#quoteNotes` |
| Fechas | `#salesStartDate`, `#salesTargetFinishDate` | `#ownerStartDate`, `#ownerTargetFinishDate` (finish calculado / readonly) |
| Store | estado sales | `mg_owner_v2` |
| Schema del plan | `operational_plan` + `internal_operational_plan` (documento voz) | Timeline legacy `operational_plan`; `internal_operational_plan` casi sin UI |
| Apply tras confirmar | `applyConfirmedVoicePlanToState` + labor auto-sync seller | Hay que mapear al apply Dueño existente; **no copiar el apply de Vendedor** |
| Persistencia servidor | `quote-internal-operational-plan` si hay `quoteId` | Dueño suele no tener `quoteId` hasta enviar; apply local primero |
| JS de voz | Inline en `public/sales.html` (~650 líneas) + `/js/voice-operational-plan.js` | Nada |

Conclusión: la lógica de captura/interpretación es reutilizable. El apply, los IDs del DOM y el refresh **no se pueden copiar**.

---

## 5. Función de voz solicitada

Paridad con la voz **real** de Vendedor: dictado del plan operativo dentro de un modal de revisión. No es un micrófono genérico junto a cada textarea.

Flujo autorizado (igual que Vendedor):

1. Dueño pulsa **Review & confirm plan**.
2. Puede dictar (idioma es-US / en-US) o escribir en el transcript.
3. Ve estado **Listening…**, puede detener o continuar.
4. **Interpret and preview** propone un plan; no guarda ni envía.
5. Revisa columnas Client Scope vs Internal Plan y edita el draft.
6. **Confirm and apply** escribe el plan en el quote Dueño. Cancelar deja todo igual.
7. Si el navegador no soporta reconocimiento, los micrófonos se deshabilitan y se puede escribir.

La voz nunca debe:

- Guardar o enviar la cotización sola.
- Publicar contenido.
- Reemplazar en silencio el Scope of Work existente (Vendedor solo escribe el narrative tras Confirm; Dueño debe avisar si `#quoteNotes` ya tiene texto).
- Recalcular precio/labor sin Confirm and apply.
- Subir audio a Supabase, Netlify o Zapier.

Servicio de terceros ya usado por Vendedor (indispensable para paridad, no se añade uno nuevo):

- **Web Speech API del navegador**: el audio no lo sube Margin Guard; Chrome suele enviarlo al STT del propio navegador/Google.
- **Interpretación**: el **texto** del transcript (no el audio) va a `voice-operational-plan-command`, que usa OpenAI (`gpt-4o-mini`). El endpoint no persiste quotes ni proyectos.

---

## 6. Alcance autorizado

Incluido:

- Superficie de voz Dueño en Operational Plan.
- Reutilizar sin modificar: `public/js/voice-operational-plan.js`, `netlify/functions/voice-operational-plan-command.mjs`, `netlify/functions/_lib/voice-operational-plan.js`.
- Apply Dueño: `operational_plan`, opcionalmente `internal_operational_plan`, `#quoteNotes` con revisión, labor auto-sync **existente** tras confirmación.
- Tests Dueño nuevos. Documento de este proyecto.

Excluido:

- Cualquier cambio en `public/sales.html` u otros archivos de Vendedor.
- Pricing, contratos, calendario como producto, invoices, emails, autenticación.
- Micrófonos en el modal de envío (`#scope`, `#message`).
- Librerías nuevas.
- Commit, push, PR, merge, deploy.
- Corregir defectos de la voz de Vendedor.

---

## 7. Riesgos y dependencias

| Riesgo | Mitigación |
| --- | --- |
| Copiar el apply de Vendedor rompe fechas Dueño (finish readonly) y labor | Apply Dueño propio: `deriveLegacyOperationalPlan` + `refreshOwnerAfterOpChange`; no escribir el calendario seller |
| `app.js` es compartido; un cambio descuidado afecta Vendedor | Preferir JS nuevo solo Dueño. Si hace falta un hook en `app.js`, debe ejecutarse solo si existe `#ownerOperationalSection` |
| Confirmación puede actualizar labor/costo (igual que Vendedor) | Solo después de Confirm and apply; Interpret never writes state |
| Dueño usa plan legacy; el documento de voz es más rico | Hidratar con `hydrateFromLegacyOperationalPlan`; al aplicar, derivar legacy para el timeline Dueño |
| `#quoteNotes` ya tiene texto | No sobrescribir en silencio; confirmar o anexar, alineado al Generate Scope Draft Dueño |
| Web Speech API ausente (Firefox, algunos iOS) | Fallback de escritura, mismo patrón Vendedor |
| Permiso de micrófono denegado | Mensaje claro en Dueño (Vendedor hoy muestra el código crudo; no se “arregla” Vendedor) |
| IDs duplicados `voicePlan*` si se copian tal cual | Prefijo Dueño en IDs (`ownerVoicePlan*`) para no chocar con tests/scripts pensados para sales.html |

Dependencias existentes (no nuevas): sesión owner/seller, `MgVoiceOperationalPlan`, endpoint de interpretación, `MgSalesOperationalPlan`.

---

## 8. Plan de implementación por fases

### Fase 0 — Este documento (hecho)

Aislamiento, auditoría, plan. Sin implementación de voz.

### Fase 1 — Superficie Dueño (hecha)

- Botón **Review & confirm plan** después de Generate Scope Draft.
- Modal Dueño: dictado `es-US`/`en-US`, transcript máx. 6000, New / Continue / Stop, Interpret, Clear, Cancel, preview Client Scope vs Internal Plan.
- Confirm and apply visible, deshabilitado, marcado como fase posterior.
- CSS scoped en `owner.html`. JS nuevo `public/js/owner-voice-operational-plan.js`.
- Web Speech API; sin `getUserMedia`; sin audio al servidor.
- Interpret: POST JSON de texto al endpoint existente. `current_document` vacío en esta fase.
- Cancel/Close detiene reconocimiento y aborta interpret. Respuestas obsoletas se ignoran.
- Permiso denegado: mensaje en español entendible. Sin Speech API: mics off, editor + Interpret siguen.
- Tests: `scripts/test-owner-voice-operational-plan.js` (80 PASS). Tests Vendedor phase1/phase2 sin cambios (PASS).
- `app.js` no se tocó.

### Fase 2 — Apply Dueño

- Confirm and apply → estado `mg_owner_v2` + refresh Dueño.
- Scope a `#quoteNotes` con preservación explícita si ya hay texto.
- Labor: respetar el toggle auto-sync Dueño; no inventar cálculo nuevo.
- Fechas: reutilizar el refresh Dueño; no portar writers de `#salesStartDate`.
- Si hay `quoteId`, persistir con `quote-internal-operational-plan` (mismo contrato que Vendedor). Si no hay, solo local (Vendedor hace lo mismo).
- Cancel / close: abort interpret, stop mic, no tocar estado.

### Fase 3 — Pruebas y verificación

Ver sección 9. Detenerse antes de commit/push/PR.

---

## 9. Pruebas necesarias

### Unitarias / DOM (Node, sin red)

Archivo nuevo `scripts/test-owner-voice-operational-plan.js` (no reescribir los tests de Vendedor):

- `owner.html` tiene botón Review, modal, mic, continue, transcript, interpret, confirm.
- Carga `/js/voice-operational-plan.js` y el script Dueño.
- IDs Dueño no viven en `sales.html` (aislamiento).
- New dictation limpia transcript; Continue preserva.
- Interpret solo escribe el draft del modal.
- Confirm sigue siendo obligatorio.
- No hay `MediaRecorder` / upload de audio.
- Fallback si no hay `SpeechRecognition`.
- Apply mapea a `#quoteNotes` / `operational_plan`, no a IDs seller.

Los tests existentes `test-voice-operational-plan-phase1.js` y `phase2.js` siguen siendo la congelación de Vendedor; no modificarlos salvo que un cambio Dueño los rompa (no debería).

### Navegador

- Chrome escritorio: dictar, listening visible, stop, continue, interpret, cancel, confirm.
- Chrome Android o equivalente móvil: mismos controles, layout apilado.
- Denegar micrófono: mensaje entendible; se puede escribir.
- Navegador sin Speech Recognition: mics off, type + interpret.
- QuoteNotes con texto previo: no desaparece en silencio.
- Confirm con auto-sync on: labor se actualiza; sin auto-send ni PDF.
- Cancel después de interpret: plan Dueño intacto.

---

## 10. Registro de decisiones y avances

| Fecha | Decisión / avance |
| --- | --- |
| 2026-09-08 | Proyecto aislado en worktree `margin-guard-owner-voice`, rama `feat/owner-voice-parity`, base `b02ac41`. |
| 2026-09-08 | Voz de Vendedor = modal de plan operativo (Web Speech + interpret OpenAI + Confirm). No hay mic por campo. |
| 2026-09-08 | Backend `voice-operational-plan-command` ya admite owner. Falta UI/apply Dueño. |
| 2026-09-08 | No extraer ni editar `sales.html`. Reutilizar módulos compartidos sin cambiarlos. |
| 2026-09-08 | No implementar voz todavía. Siguiente paso: Fase 1 tras PASS del propietario. |
| 2026-09-08 | Defectos Vendedor se reportan, no se corrigen aquí: mensaje `not-allowed` crudo; no hay Pausa distinta de Stop; abrir el modal borra el transcript; Firefox suele no tener Speech API. |
| 2026-09-08 | Fase 1 implementada en Dueño: modal preview-only. Confirm deshabilitado. Sin writers a `#quoteNotes`, fechas, labor, `mg_owner_v2` ni servidor. `app.js` no modificado. |

---

## 11. Mapa de voz en Vendedor (referencia mínima)

Solo lo necesario para paridad. No modificar estos archivos.

**UI / captura** — `public/sales.html`

- Estilos `.voice-plan-*` (~1019–1145).
- Modal `#voicePlanPreviewModal` (~1764–1818).
- Botón `#btnReviewConfirmOperationalPlan`.
- Script: `startVoicePlanRecognition`, interpret, confirm (~6179–6820).
- Include `/js/voice-operational-plan.js`.

**Comportamiento de captura**

- `SpeechRecognition` / `webkitSpeechRecognition`. No `getUserMedia` explícito.
- New dictation: borra transcript y empieza. Continue: anexa. Segundo clic en el activo: stop.
- Mientras escucha, el otro botón de mic se deshabilita (anti doble activación).
- Idiomas dictado: `es-US`, `en-US`. Documento cliente: `en` / `es`.
- Transcript máx. 6000. Interim results en el textarea.
- Interpret: POST JSON `{ transcript, current_document, start_date, client_language }` con cookies. No audio.
- Confirm: aplica al estado seller; persiste solo si hay `quoteId`.

**Librería y backend (reutilizables, no tocar en este proyecto salvo bug Dueño imposible de aislar)**

- `public/js/voice-operational-plan.js` → `window.MgVoiceOperationalPlan`
- `netlify/functions/_lib/voice-operational-plan.js`
- `netlify/functions/voice-operational-plan-command.mjs` (`resolveOwnerOrSellerContext`)
- Persist opcional: `netlify/functions/quote-internal-operational-plan.js`

---

## 12. Archivos de la Fase 1

Modificados:

- `public/owner.html` — botón, modal, CSS, script tags.
- `MARGIN_GUARD_OWNER_PORTAL_SUMMARY.md` — este registro.

Creados:

- `public/js/owner-voice-operational-plan.js` — captura + interpret + preview. Sin apply.
- `scripts/test-owner-voice-operational-plan.js`

No modificados (confirmado vs SHA `b02ac41`):

- `public/sales.html`
- `public/js/voice-operational-plan.js`
- `scripts/test-voice-operational-plan-phase1.js`
- `scripts/test-voice-operational-plan-phase2.js`
- `netlify/functions/voice-operational-plan-command.mjs`
- `netlify/functions/_lib/voice-operational-plan.js`
- `public/js/app.js`

---

## 13. Revisión visual Fase 1 (2026-09-08)

Servidor local: `npx netlify-cli dev --port 8888 --offline` en este worktree.

**Bloqueo:** `/owner` redirige a `http://localhost:8888/index.html?login=1`. No hay sesión Dueño en este navegador y no se usaron secretos ni credenciales. Los escenarios autenticados (dictado, Interpret 200, before/after de `#quoteNotes`) **no se ejecutaron**.

Comprobado sin login:

- `GET /owner.html` → 200. El botón Review está después de Generate Scope Draft. El modal y el script Dueño están en el HTML.
- `POST /.netlify/functions/voice-operational-plan-command` sin sesión → **401** `{"ok":false,"code":"no_device_session","error":"Device session required"}`, `Content-Type: application/json`. No es audio/Blob/FormData.

### `git diff --check`

- Comando: `git diff --check`
- Exit code: **2**
- `git config --get core.autocrlf` → `true`
- `git check-attr text eol -- public/owner.html` → `text: unspecified`, `eol: unspecified`
- `core.whitespace` no está configurado (default de Git)

Bytes (no se reescribió el archivo):

- Línea nueva 407: `last8_codes=45,99,97,114,100,32,123,13` → termina en `{` + **CR (13)**. Cero espacios/tabs antes del CR.
- Línea 1 existente y HEAD: también terminan en CR (`<!doctype html>\r`).
- HEAD `owner.html`: **1382 CRLF**, **1 LF** (L516 toolbar).
- Worktree: **1569 CRLF**, **0 LF**.
- 187 líneas `+` en el diff: **187 con CR**, **0 con espacio/tab real al final**.

Conclusión: no hay whitespace real que corregir. El aviso es CR-at-eol sobre líneas nuevas CRLF, el mismo ending que ya usa casi todo `owner.html` en el blob de Git. La línea toolbar aparece como `-/+` idéntico porque HEAD L516 era el único LF y el worktree la tiene en CRLF; no se normalizó el archivo completo.

No commit / no deploy.
