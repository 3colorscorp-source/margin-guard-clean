# Margin Guard - Owner Blueprint v1

## Vision del producto
Margin Guard existe para evitar el problema: "rico en papel, quebrado en caja".
El sistema obliga disciplina de precio, protege margen y conecta cotizacion con dinero real del negocio.

## Objetivo de negocio
1. Proteger flujo de caja real.
2. Estandarizar cotizaciones por horas o dias.
3. Evitar descuentos destructivos por parte del equipo comercial.
4. Alinear ventas, operacion y finanzas con reglas automaticas.

## Roles y permisos

### 1) Dashboard (Owner Finance View)
Ve:
- Saldos reales de banco por cuenta.
- Semaforo financiero de salud por cuenta:
  - Expenses (operacion)
  - Profit (ganancia retenida)
  - Savings (reserva/ahorro)
- Runway: meses cubiertos con caja disponible.
- Meta de ahorro: minimo 12 meses de costos operativos.

No negociable:
- El semaforo se basa en dinero real, no en ingresos proyectados.

### 2) Dueno (Admin Finance Engine)
Configura:
- Costos operativos mensuales completos.
- Impuestos del empleador por estado (default California).
- Comision de vendedores.
- Costos por trabajador/rol.
- Reglas de pricing.

Reglas base v1:
- Ganancia por defecto: 30%.
- Reserva/Ahorro fija: 5% (bloqueada, no editable por otros roles).
- Precio minimo nunca por debajo del umbral de perdida.

### 3) Pipeline de ventas
Etapas:
- Lead
- Discovery
- Quote Sent
- Negotiation
- Won
- Lost

Mide:
- Win rate por vendedor.
- Margen promedio vendido.
- Tiempo de cierre.
- Proyeccion de caja a 30/60/90 dias.

### 4) Vendedor
Puede:
- Ingresar horas o dias estimados.
- Ingresar alcance y notas.
- Ver precio recomendado final para cliente.
- Ver su semaforo de comision.

No puede ver:
- Estructura interna de costos (overhead total, impuestos detallados, profit account, savings account).

Semaforo vendedor:
- Verde: precio en rango objetivo (comision maxima).
- Amarillo: permitido con reduccion de comision.
- Rojo: bloqueado o requiere aprobacion.

Mensajes automaticos de negociacion (copiar/pegar):
- "Este precio protege garantia, tiempos y calidad del proyecto."
- "Podemos ajustar alcance o fases para bajar costo sin comprometer margen."
- "Debajo de este umbral, la propuesta requiere ajuste de alcance."

### 5) Supervisor
Puede ver:
- Horas/dias presupuestados de mano de obra.
- Presupuesto operativo del proyecto para ejecucion.
- Registro diario/semanal de gastos reales de material y mano de obra.

No puede ver:
- Ganancia total del negocio ni estructura completa de costos corporativos.

Bonus de supervisor:
- Base: 1% si termina a tiempo y dentro de presupuesto.
- Decremento automatico por retraso o sobrecosto.

### 6) Sales Admin
Controla:
- Calidad de datos de cotizaciones.
- Reglas de descuentos y aprobaciones.
- Plantillas comerciales y mensajes.
- Asignacion de leads y SLA de seguimiento.

## Motor de precios (v1)

Formula base:
1. Costo directo = mano de obra + cargas empleador + materiales estimados.
2. Costo indirecto = overhead proporcional por horas del proyecto.
3. Base de costo = costo directo + costo indirecto.
4. Ganancia = base * 30% (editable solo owner).
5. Reserva = base * 5% (fija no negociable).
6. Precio recomendado = base + ganancia + reserva.

Controles:
- Precio minimo operativo = base + margen minimo de seguridad.
- Si vendedor intenta descuento por debajo de minimo, bloquear y pedir aprobacion.

## Indicadores clave (KPI)
1. Cash runway (meses).
2. Savings coverage vs meta 12 meses.
3. Margen estimado vs margen real por proyecto.
4. Desviacion de costos por supervisor.
5. Win rate por vendedor y por rango de precio.
6. Porcentaje de descuentos fuera de politica.

## Riesgos criticos a controlar
1. Vender por debajo de costo real.
2. Mostrar datos financieros sensibles al rol equivocado.
3. Cobros sin activacion de acceso o acceso sin suscripcion.
4. Proyectos sin tracking de costo real.
5. Descuentos sin trazabilidad ni aprobacion.

## Recomendacion de arquitectura
1. Frontend web por roles (Dashboard, Owner, Sales, Supervisor, Sales Admin).
2. API con autorizacion por rol.
3. Integracion bancaria (fase 2) para saldos reales.
4. Motor de reglas de precio centralizado (server-side).
5. Auditoria completa de cambios y aprobaciones.

## Fases de ejecucion recomendadas

### Fase A (MVP comercial)
- Owner + Sales + reglas de precio + semaforo + suscripcion anual.
- Meta: vender sin perder margen.

### Fase B (Control operativo)
- Supervisor + tracking real diario/semanal + cierre de proyecto con reporte.
- Meta: medir desviacion y proteger rentabilidad real.

### Fase C (Finanzas reales)
- Dashboard bancario real + meta 12 meses + alertas de salud financiera.
- Meta: control de caja total del negocio.

### Fase D (Escalamiento)
- Pipeline avanzado + forecasting + comparativas USA/LatAm + reportes ejecutivos.
- Meta: escalar sin perder control.

## Decisiones de owner (ya aplicadas en sistema actual)
1. Ganancia default de cotizacion en 30%.
2. Reserva fija de 5% bloqueada como no negociable.
3. Base lista para pruebas privadas antes de abrir ventas publicas.
