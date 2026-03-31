# Margin Guard - SaaS con suscripcion anual (Netlify + Stripe)

Aplicacion web para cotizaciones de obra con control de margen.
Incluye publicacion en `netlify.app`, checkout anual con Stripe y acceso protegido por sesion.

## Flujo comercial

1. Cliente entra a `index.html` (landing publica).
2. Ingresa email y hace checkout anual en Stripe.
3. Stripe redirige a `success.html`.
4. `success.html` valida el `session_id` en Netlify Function y crea cookie de sesion.
5. Usuario accede a `dashboard.html`, `owner.html`, etc.
6. Puede administrar su plan con Stripe Billing Portal.

## Requisitos

- Cuenta Netlify.
- Cuenta Stripe.
- Un precio anual en Stripe (Price ID, por ejemplo `price_...`).

## Variables de entorno (Netlify)

Configura estas variables en `Site settings -> Environment variables`:

- `STRIPE_SECRET_KEY` = clave secreta de Stripe (`sk_live_...` o `sk_test_...`).
- `STRIPE_PRICE_ANNUAL_ID` = Price ID anual (`price_...`).
- `SESSION_SECRET` = string largo aleatorio para firmar sesiones (min 32 chars).
- `ZAPIER_WEBHOOK_URL` = opcional para envio de cotizaciones por Zapier.

## Deploy en Netlify

1. Sube este repo a GitHub.
2. En Netlify: `Add new site -> Import from Git`.
3. Build settings:
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. Agrega variables de entorno.
5. Deploy.

## Pruebas recomendadas

1. Abrir landing en URL de Netlify.
2. Ejecutar checkout en modo test de Stripe.
3. Confirmar redireccion a `/success.html` y luego `/dashboard.html`.
4. Verificar que `/dashboard.html` redirige a landing cuando no hay sesion.
5. Verificar `Gestionar plan` (Billing Portal).

## Estructura principal

- `public/index.html`: landing publica y formulario de suscripcion anual.
- `public/success.html`: activacion de acceso post-checkout.
- `public/dashboard.html`: dashboard protegido.
- `public/owner.html`: calculadora completa protegida.
- `public/js/auth.js`: control de acceso (auth-status + portal + logout).
- `public/js/billing.js`: checkout desde landing.
- `netlify/functions/create-checkout-session.js`
- `netlify/functions/finalize-checkout.js`
- `netlify/functions/auth-status.js`
- `netlify/functions/create-portal-session.js`
- `netlify/functions/logout.js`

## Nota de seguridad

La sesion se guarda en cookie HttpOnly firmada (`mg_session`).
El estado de suscripcion se valida contra Stripe en cada chequeo de acceso.
