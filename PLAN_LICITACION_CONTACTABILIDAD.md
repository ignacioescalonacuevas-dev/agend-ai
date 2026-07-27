# Plan de Construcción — Sistema Automatizado de Contactabilidad mediante IA
**Licitación:** Servicio de Salud Aysén · 36 meses · $619.685.220 CLP · 10 establecimientos
**Base funcional:** este repo parte del código de Fase 0 (`recupero-cupos`, migrado desde `bed-flow`)
**Estado:** Borrador para revisión · Julio 2026

---

## 0. Resumen ejecutivo

El código heredado (hitos 1-3 de Fase 0) cubre aproximadamente **15-20% del
alcance** exigido por las Especificaciones Técnicas (EETT): la máquina de
estados de citas, la ingesta de agenda y el orquestador de cascada por
WhatsApp/SMS son una base sólida y reutilizable. El resto —IVR real,
multi-establecimiento, interoperabilidad HIS, mesa de ayuda con SLA
contractual, reportería, y endurecimiento de seguridad— **no está
construido** y representa la mayor parte del esfuerzo.

Este documento cubre el plan de construcción técnico. La sección 8 separa,
deliberadamente, los requisitos **no técnicos** de admisibilidad de la
licitación (garantías, experiencia acreditada, certificaciones legales) que
deben resolverse en paralelo y que el código no puede satisfacer por sí
solo.

---

## 1. Qué ya existe vs. qué exige el EETT

| Capacidad EETT | Estado en el código heredado | Brecha |
|---|---|---|
| Confirmación de citas por cascada | ✅ Implementado (paso 1-3, 2 ciclos) | Ajustar reglas exactas a EETT (ver §3) |
| WhatsApp | ✅ Interfaz `CanalMensajeria` + mock | Falta integración real con WhatsApp Business API (Meta BSP) y aprobación de plantillas |
| SMS | 🟡 Diseñado, no integrado | Falta Twilio (o carrier chileno) real |
| **IVR** (obligatorio, canal #1 del EETT) | ❌ Solo "tarea de llamada manual" | **Debe construirse desde cero** — es uno de los 2 canales obligatorios, no puede quedar en fase futura |
| Multi-establecimiento (10 contratos) | ❌ Esquema mono-hospital | Requiere re-arquitectura multi-tenant (§4) |
| Interoperabilidad HIS | ❌ Solo ingesta manual Excel/CSV | Requiere capa de adaptadores por establecimiento (§5) — mayor riesgo/incógnita del proyecto |
| Mesa de ayuda 24x7x365 + SLA | ❌ No existe | Módulo de ticketing completo (§6) |
| Reportería y dashboards | 🟡 Solo placeholders de página | Construir vistas por rol + export (§7) |
| Gestión de campañas por usuarios locales | ❌ No existe | Módulo de administración de plantillas/campañas (§7) |
| Seguridad (MFA, cifrado, auditoría) | 🟡 Auditoría append-only diseñada | Falta MFA, cifrado en reposo verificado, políticas de respaldo/DR documentadas (§9) |
| Reglas de horario/reintentos del EETT | 🟡 Ventana única 09:00-20:00 | Debe diferenciarse por canal y día (§3) |

---

## 2. Arquitectura objetivo

```
                     ┌─────────────────────────┐
                     │   Panel Web (Next.js)    │
                     │  admin · admisión · red  │
                     └────────────┬─────────────┘
                                  │
                     ┌────────────┴─────────────┐
                     │      API / Backend         │
                     │  (multi-tenant por          │
                     │   establecimiento)          │
                     └───┬─────────┬─────────┬────┘
                         │         │         │
              ┌──────────┘   ┌─────┘    ┌────┘
              ▼              ▼          ▼
      ┌───────────────┐ ┌──────────┐ ┌────────────┐
      │ Orquestador de │ │ Adapters │ │ Mesa de    │
      │ Cascada        │ │ HIS      │ │ Ayuda      │
      │ (pg-boss)      │ │ (por     │ │ (tickets + │
      │                │ │  centro) │ │  SLA)      │
      └───┬───┬───┬────┘ └──────────┘ └────────────┘
          │   │   │
      ┌───┘   │   └───┐
      ▼       ▼       ▼
   WhatsApp  IVR     SMS
   (Meta BSP)(Voz)  (Twilio/carrier)
```

Decisiones clave:
- **Multi-tenant a nivel de fila** (`establecimiento_id` en cada tabla +
  RLS), no 10 despliegues separados — más barato de operar y consistente
  con "un solo sistema, un contrato por establecimiento".
- El **IVR** se construye como un canal más detrás de la misma interfaz
  `CanalMensajeria` ya definida en el código heredado, evitando reescribir
  el orquestador de cascada.
- La **interoperabilidad HIS** se aísla en una capa de adaptadores, porque
  cada establecimiento puede tener un HIS distinto (el EETT lo reconoce
  explícitamente: "HIS Institucional o comercial").

---

## 3. Ajustar el motor de reglas a los parámetros exactos del EETT

El scheduler/cascada de Fase 0 ya tiene la lógica correcta (estados,
idempotencia, ventana horaria), pero los **parámetros** deben calzar
exactamente con el EETT, que es más específico que el PRD original:

- Máximo 3 intentos totales por episodio (no superable sin autorización
  escrita de la contraparte — dejar esto configurable, no hardcoded).
- Máximo 2 intentos por canal antes de cambiar de canal.
- Intervalo mínimo entre intentos del mismo canal: 120 minutos.
- Recordatorio informativo: 5-7 días antes, enviado al momento del
  agendamiento.
- Recordatorio interactivo: 48 h antes.
- Llamada de confirmación: 24 h antes, solo si no hubo respuesta digital
  previa.
- Parada automática: cualquier estado "Confirmado" detiene el envío en
  todos los canales (ya existe como regla de silencio invertida — hay que
  invertir la lógica: aquí *si* hay respuesta positiva, se detiene todo).
- Recontacto post-NSP: primer intento dentro de 2 h de la inasistencia
  detectada (requiere marcaje de asistencia, ver RF pendiente del PRD
  original).
- **Ventanas horarias diferenciadas por canal**, no una ventana única:
  - Llamadas salientes: 09:00–11:30 y 14:00–17:00 L-V; 09:00–13:00 sáb.
  - WhatsApp: 08:30–19:00 L-V; 09:00–13:00 sáb.
  - Domingos y festivos: sin contacto de ningún tipo (requiere calendario
    de festivos chilenos, no solo día de la semana).
  - Prefijo de llamadas salientes: 600 (requiere carrier/proveedor de
    telefonía habilitado bajo esa normativa SUBTEL 2025 — ver §8).

**Trabajo:** extraer estos valores a una tabla de parametrización por
establecimiento (el EETT permite variación razonable, y los administradores
de contrato locales deben poder ajustar sin depender del proveedor).

---

## 4. Multi-establecimiento (10 contratos, 1 plataforma)

- Migrar el esquema de "hospital único" a `establecimientos` como entidad
  de primer nivel; toda tabla operativa (`citas`, `pacientes`,
  `intentos_contacto`, `lista_espera`, `eventos_auditoria`) gana
  `establecimiento_id`.
- RLS por establecimiento para roles `admision`, `encargado_servicio`,
  `jefatura` locales.
- Rol adicional **Coordinador de Red** (visión agregada de los 10
  establecimientos) — el EETT lo pide explícitamente y nombra a la persona
  responsable (Mariela Zapata Cid).
- Facturación y contratos son por establecimiento (10 RUTs distintos, 10
  montos disponibles distintos) — el modelo de datos de facturación debe
  separar "contacto efectivo" por establecimiento porque la oferta
  económica se paga por unidad de contacto (Anexo 9), no por suscripción
  plana.
- Onboarding de cada establecimiento debe ser repetible en ≤15 días
  hábiles (plazo contractual y criterio de evaluación del 30%): esto obliga
  a que el módulo de administración de usuarios/campañas por
  establecimiento sea self-service desde el día 1, no manual del
  proveedor.

---

## 5. Interoperabilidad HIS — el mayor riesgo del proyecto

El EETT exige interoperabilidad real con el HIS de cada establecimiento
(API, base de datos, SOA, HL7 — "u otro"), registro automático de
confirmación/cancelación en el HIS, y trazabilidad clínica. Esto es un
**riesgo de descubrimiento**, no solo de construcción: no sabemos hoy qué
HIS usa cada uno de los 10 establecimientos ni qué expone.

Plan:
1. **Semana 1 post-adjudicación:** reunión de levantamiento con cada
   establecimiento (ya contemplada en el EETT como parte del plazo de
   implementación) para identificar HIS y método de integración disponible.
2. Construir la capa de adaptadores con una interfaz única
   (`HISAdapter.confirmar()`, `.cancelar()`, `.cargarAgenda()`) y
   implementaciones concretas por tipo de HIS encontrado.
3. Mientras no haya HIS disponible o el adaptador no esté listo, la
   ingesta Excel/CSV de Fase 0 sirve de *fallback* legítimo — el EETT lo
   permite explícitamente ("Registro y/o carga manual o masiva de agendas
   ... en caso de indisponibilidad HIS").
4. Certificación técnica/carta de conformidad de interoperabilidad es un
   entregable documental, no solo código — coordinar con cada
   establecimiento para firmarla.

---

## 6. Mesa de ayuda 24x7x365 con SLA contractual

Esto es un producto en sí mismo, con requisitos duros y multables:

| Criticidad | 1ª respuesta | Resolución | Multa asociada (Anexo 8) |
|---|---|---|---|
| Alta | 1 h | 4 h | 3-10 UF por evento, según causal |
| Media | 6 h | 24 h | — |
| Baja | 24 h | 5 días hábiles | — |

Requisitos de producto:
- Ticket único autogenerado por solicitud, con los 12 campos mínimos que
  exige el EETT (fecha apertura, canal, solicitante, establecimiento,
  categoría, criticidad, profesional asignado, primera respuesta,
  resolución, acciones, causa raíz, estado).
- Clasificación automática a "criticidad alta" de cualquier incidente que
  interrumpa el envío de mensajes (regla explícita del EETT, no
  discrecional).
- Escalamiento formal documentado (niveles, tiempos, responsables).
- Reportes de cumplimiento de SLA, reincidencias, causa raíz — visibles
  para el Servicio en cualquier momento.
- **24x7x365 real** implica turnos de personal, no solo software. Evaluar
  build vs. buy: construir el módulo de tickets (se integra con el resto
  del sistema y con la regla de "criticidad alta automática") pero apoyar
  la operación 24x7 en un proveedor de NOC/soporte externo si el equipo no
  tiene guardia propia — esto es una decisión de negocio, no solo técnica.

---

## 7. Reportería, dashboards y autonomía de campañas

- Dashboard en tiempo real: contactos efectivos/fallidos, respuestas por
  canal, usuarios no localizados, cumplimiento SLA — con perfil "red
  completa" (Coordinador) y perfil por establecimiento.
- Export a Excel/CSV, con reportes programables (diario/semanal/mensual),
  no solo descarga bajo demanda.
- Módulo de campañas con plantillas reutilizables, editable por usuarios
  locales sin intervención del proveedor — requisito explícitamente
  "obligatorio" y evaluado en Anexo 7 (ítem 3).
- Validación y corrección de números telefónicos inválidos, con reporte —
  ya hay una base en `telefono.ts` (normalización E.164) del código
  heredado; falta el ciclo de corrección + reporte.
- Informe mensual de servicio (por establecimiento + consolidado de red)
  con las 6 secciones que exige el EETT (resumen ejecutivo, estado del
  servicio, mantenimiento, seguridad, soporte técnico, observaciones) —
  esto puede generarse en gran parte desde los datos de auditoría y
  tickets, con una plantilla fija.

---

## 8. Requisitos no técnicos de admisibilidad (bloqueantes, fuera del código)

Esto **no se resuelve con desarrollo de software** y debe evaluarse antes
de comprometer esfuerzo de ingeniería, porque puede determinar si la
oferta es viable:

- **Experiencia acreditada (Anexo 5, 20% de la nota):** exige listado de
  mínimo 5 implementaciones de sistemas de contactabilidad en salud
  (idealmente ≥20 para el puntaje máximo). Sin referencias previas, este
  ítem puntúa 0 y compromete un 20% de la evaluación total.
- **Certificado de propiedad intelectual (Anexo 4):** declarar que el
  software es propio, sin dependencia de terceros — condiciona qué
  componentes de terceros (ej. Twilio, Meta) se pueden usar como
  infraestructura vs. cuánto debe ser IP propia.
- **Certificación de estándares de integración (Anexo 6).**
- **Garantía de seriedad de la oferta:** 3% del monto total (~$18,6M CLP),
  vigencia mínima 150 días — requiere instrumento financiero/boleta
  bancaria.
- **Garantía de fiel cumplimiento:** 5% del monto neto adjudicado, vigente
  36+2 meses — se presenta post-adjudicación pero debe planificarse.
- **Carrier de voz con prefijo saliente 600** (normativa SUBTEL 2025) para
  IVR: requiere alianza con un proveedor de telefonía regulado en Chile,
  no es algo que se resuelva solo con Twilio genérico.
- **Declaraciones legales corporativas** (antisindical, inhabilidades para
  contratar con el Estado, programa de integridad) — requieren una entidad
  legal constituida apta para contratar con el Estado chileno.

**Recomendación:** resolver este bloque en paralelo, en semana 0, con
quien lleve la parte comercial/legal de la oferta. Si alguno de estos
puntos no es viable a tiempo, es mejor saberlo antes de invertir en la
construcción técnica completa.

---

## 9. Seguridad y cumplimiento

- Cifrado en tránsito (TLS 1.2+) — trivial con la infraestructura cloud
  elegida; cifrado en reposo debe verificarse explícitamente (no asumir
  que el proveedor cloud lo activa por defecto).
- Autenticación con doble factor obligatoria para administradores.
- Sin credenciales compartidas — reforzar con RLS + auditoría de sesión.
- Logs de actividad por usuario (ya hay diseño de `eventos_auditoria`
  append-only en el código heredado — extenderlo a nivel de aplicación).
- El EETT cita la Ley N°19.628; en la práctica hoy también aplica la
  **Ley N°21.719** (nueva ley de protección de datos personales, vigente
  desde diciembre 2026) que endurece varios de estos requisitos —
  conviene diseñar contra el estándar más exigente desde el inicio para no
  rehacer trabajo.
- Plan de respaldo y DR documentado (frecuencia, retención, ubicación,
  procedimiento de restauración, pruebas periódicas) — es un entregable
  explícito del EETT, no solo una buena práctica interna.

---

## 10. Roadmap propuesto

| Fase | Contenido | Duración estimada |
|---|---|---|
| **0. Descubrimiento** | Validar bloque no técnico (§8), levantar HIS de los 10 establecimientos, confirmar carrier de voz 600 y BSP de WhatsApp | 2-3 semanas, en paralelo a lo técnico |
| **1. Multi-tenant + parametrización de reglas** | Re-arquitectura de esquema por establecimiento, motor de reglas parametrizado (§3-4) | 3-4 semanas |
| **2. Canal IVR** | Integración de voz saliente, TTS, captura DTMF, grabación+transcripción opcional | 4-6 semanas (depende del carrier) |
| **3. Interoperabilidad HIS** | Framework de adaptadores + primeras integraciones reales | 4-8 semanas (alto riesgo de calendario) |
| **4. Mesa de ayuda + SLA** | Ticketing, clasificación automática, escalamiento, reportes de cumplimiento | 3-4 semanas |
| **5. Reportería y campañas** | Dashboards por rol, export, plantillas de campaña self-service | 3 semanas |
| **6. Seguridad y hardening** | MFA, verificación de cifrado en reposo, plan DR documentado, auditoría end-to-end | 2 semanas, transversal |
| **7. Piloto y puesta en marcha** | Primer establecimiento en producción, ≤15 días hábiles desde OC | Por establecimiento |

Las fases 2 y 3 son las de mayor incertidumbre de calendario porque
dependen de terceros (carrier de voz, HIS de cada establecimiento) fuera
del control directo del equipo de desarrollo.

---

## 11. Próximos pasos inmediatos

1. Resolver §8 (admisibilidad no técnica) — go/no-go antes de seguir.
2. Definir el proveedor de WhatsApp Business API (BSP) y el carrier de voz
   con prefijo 600.
3. Diseñar la migración de esquema multi-tenant sobre las tablas ya
   existentes (`citas`, `pacientes`, `intentos_contacto`, `lista_espera`,
   `eventos_auditoria`).
4. Priorizar el canal IVR de inmediato: es uno de los 2 canales
   obligatorios del EETT y hoy no existe ni como prototipo.
