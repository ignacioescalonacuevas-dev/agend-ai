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

**Actualización (Fase 1 en curso):** multi-establecimiento (§4), ventanas
horarias por canal + feriados (§3), el canal IVR como interfaz + mock (§3,
§10) y las reglas exactas de reintentos del EETT (§3, episodio único de 3
intentos) ya están implementados — ver `DECISIONS.md` D-022 a D-031 y el
estado de hitos en `README.md`. La interoperabilidad HIS (§5) se **pospone
por decisión de producto** (`DECISIONS.md` D-033): la ingesta Excel/CSV de
Fase 0 queda como vía de carga vigente para los 10 establecimientos hasta
que se retome. El recontacto post-NSP dentro de §3 sigue pendiente porque
depende de una RF de marcaje de asistencia que no existe todavía.

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
| **IVR** (obligatorio, canal #1 del EETT) | 🟡 Interfaz `CanalLlamada` + mock, prefijo 600 ya integrado | Falta TTS/captura DTMF/grabación reales y un carrier de telefonía chileno (§10) |
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
- El **IVR** se construyó como canal `CanalLlamada` (deliberadamente
  distinto de `CanalMensajeria`: una llamada no es "enviar y olvidar") sin
  tocar el orquestador de cascada (`DECISIONS.md` D-030) — ya implementado
  con mock; falta el carrier de telefonía real.
- La **interoperabilidad HIS** se aísla en una capa de adaptadores, porque
  cada establecimiento puede tener un HIS distinto (el EETT lo reconoce
  explícitamente: "HIS Institucional o comercial").

---

## 3. Ajustar el motor de reglas a los parámetros exactos del EETT

El scheduler/cascada de Fase 0 ya tiene la lógica correcta (estados,
idempotencia, ventana horaria), pero los **parámetros** deben calzar
exactamente con el EETT, que es más específico que el PRD original.

**✅ Hecho** — ventanas horarias diferenciadas por canal, no una ventana
única:
  - Llamadas salientes: 09:00–11:30 y 14:00–17:00 L-V; 09:00–13:00 sáb.
  - Mensajería (WhatsApp/SMS): 08:30–19:00 L-V; 09:00–13:00 sáb.
  - Domingos y feriados: sin contacto de ningún tipo, vía tabla `feriados`
    editable sin deploy (sembrada solo con fechas de certeza total para
    2026 — ver `DECISIONS.md` D-027 para lo que falta confirmar contra el
    Diario Oficial).
  - Prefijo de llamadas salientes (600, normativa SUBTEL 2025): la
    constante ya viaja en cada llamada colocada por el canal IVR
    (`DECISIONS.md` D-030). Lo que falta es el carrier/proveedor de
    telefonía real detrás del mock — ver § Fase 2 del roadmap, §10.

**✅ Hecho** — episodio único de 3 intentos anclados a la hora de la cita
(`DECISIONS.md` D-031, reemplaza el modelo heredado de "2 ciclos × 3 pasos"):
- Máximo 3 intentos totales por episodio: `interactivo_1` (WhatsApp),
  `interactivo_2` (SMS), `llamada` (IVR) — el recordatorio `informativo` no
  cuenta para este tope.
- Cambio de canal entre `interactivo_1` y `interactivo_2` (WhatsApp → SMS).
- Intervalo mínimo entre intentos del mismo canal: no se ejercita hoy (cada
  canal se usa una sola vez en el episodio), pero `interactivo_2` respeta
  120 minutos desde el envío real de `interactivo_1`.
- Recordatorio informativo: ventana 5-7 días antes, WhatsApp uno-a-muchos,
  sin botones, encolado por un scan horario independiente
  (`encolarInformativos`).
- Recordatorio interactivo: WhatsApp a T-48h/T-24h (mismo scheduler que ya
  existía) + reintento por SMS 120 min después.
- Llamada de confirmación: anclada a T-24h exacto (no relativa al paso
  anterior), condicionada a que no haya habido respuesta digital previa.
- Parada automática: cualquier estado ≠ `en_contacto` (incluye
  "Confirmado") detiene el envío en todos los canales — ya existía como
  regla de silencio invertida, sigue aplicando sin cambios.

**❌ Pendiente** (`DECISIONS.md` D-031, explícitamente fuera de este
cambio):
- Recontacto post-NSP: primer intento dentro de 2 h de la inasistencia
  detectada — requiere marcaje de asistencia, una RF que no existe todavía
  en el PRD original.

Dos ambigüedades del EETT se resolvieron por decisión explícita (documentada
en D-031 para revisión si aparece el texto exacto de la especificación): el
orden de canales dentro del tope de 3 (WhatsApp → SMS en vez de WhatsApp
×2), y el anclaje de `interactivo_2` (relativo al envío real del paso
anterior, no a un offset fijo desde la hora de la cita).

---

## 4. Multi-establecimiento (10 contratos, 1 plataforma)

- Migrar el esquema de "hospital único" a `establecimientos` como entidad
  de primer nivel; toda tabla operativa (`citas`, `pacientes`,
  `intentos_contacto`, `lista_espera`, `eventos_auditoria`) gana
  `establecimiento_id`.
- **✅ Hecho** — RLS por establecimiento para roles `admision`,
  `encargado_servicio`, `jefatura` locales: tabla `perfiles` + políticas de
  escritura (`DECISIONS.md` D-035). Falta el login real (sin proyecto
  Supabase provisionado todavía) que conecte una sesión de usuario real con
  este modelo.
- Rol adicional **Coordinador de Red** (visión agregada de los 10
  establecimientos, de solo lectura por diseño) — el EETT lo pide
  explícitamente y nombra a la persona responsable (Mariela Zapata Cid).
  **✅ Hecho** el modelo de datos; sin escritura para este rol (D-035).
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

**Decisión (`DECISIONS.md` D-033):** por ahora se **pospone** la
construcción de la capa de adaptadores HIS. La ingesta Excel/CSV ya
construida en Fase 0 (hito 2, `src/lib/ingesta-service.ts`) queda como el
mecanismo de carga de agenda vigente para los 10 establecimientos —no un
fallback temporal a reemplazar pronto, sino la vía de ingesta activa
mientras no se retome este ítem—. El EETT lo permite explícitamente
("Registro y/o carga manual o masiva de agendas ... en caso de
indisponibilidad HIS"). Cuando se retome:

1. **Semana 1 post-adjudicación:** reunión de levantamiento con cada
   establecimiento (ya contemplada en el EETT como parte del plazo de
   implementación) para identificar HIS y método de integración disponible.
2. Construir la capa de adaptadores con una interfaz única
   (`HISAdapter.confirmar()`, `.cancelar()`, `.cargarAgenda()`) y
   implementaciones concretas por tipo de HIS encontrado.
3. Certificación técnica/carta de conformidad de interoperabilidad es un
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

**✅ Hecho (hito 1, `DECISIONS.md` D-034) — esquema + dominio, sin UI:**
- Ticket único autogenerado (`tickets`, folio en `numero`) con los 12 campos
  mínimos que exige el EETT (fecha apertura, canal, solicitante,
  establecimiento, categoría, criticidad, profesional asignado, primera
  respuesta, resolución, acciones, causa raíz, estado).
- Clasificación automática a "criticidad alta" de cualquier incidente que
  interrumpa el envío de mensajes (regla explícita del EETT, no
  discrecional) — flag `interrumpe_envio_mensajes`, override auditado en
  `crearTicket()`.
- Cálculo de los plazos de SLA de la tabla de arriba
  (`src/domain/sla-ticket.ts`), incluyendo días hábiles para la resolución
  de criticidad baja.
- Máquina de estados `abierto → en_atencion → resuelto → cerrado`
  (`src/domain/estado-ticket.ts`), multi-tenant + RLS igual que el resto
  del esquema.

**❌ Pendiente:**
- Escalamiento formal documentado (niveles, tiempos, responsables).
- Reportes de cumplimiento de SLA, reincidencias, causa raíz — visibles
  para el Servicio en cualquier momento (naturalmente §7, reportería).
- Página/dashboard de mesa de ayuda — no construida todavía porque no hay
  sistema de auth/roles real en la app (`/ingesta` sigue siendo la única
  página).
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
- Autenticación con doble factor obligatoria para administradores —
  pendiente: depende del login real (`DECISIONS.md` D-035), que a su vez
  depende de tener un proyecto Supabase provisionado.
- Sin credenciales compartidas — reforzar con RLS + auditoría de sesión.
  **✅ Hecho el modelo de RLS de escritura por rol** (D-035); falta la
  sesión de usuario real que lo active (hoy el contexto se fija a mano vía
  `aplicarContextoSesion()`, solo usado desde tests).
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
| **2. Canal IVR** | ✅ Interfaz y orquestación con mock. Falta: carrier de telefonía real, TTS real, captura DTMF real, grabación+transcripción opcional | 4-6 semanas (depende del carrier) |
| **3. Interoperabilidad HIS** | **Pospuesta por decisión de producto (D-033).** Framework de adaptadores + primeras integraciones reales, cuando se retome. Mientras tanto la ingesta Excel/CSV de Fase 0 es la vía de carga vigente | 4-8 semanas (alto riesgo de calendario), sin fecha de inicio definida |
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
3. ~~Diseñar la migración de esquema multi-tenant~~ — hecho (`DECISIONS.md`
   D-022 a D-025).
4. ~~Priorizar el canal IVR~~ — hecho como interfaz + mock
   (`DECISIONS.md` D-030); falta cerrar el carrier de telefonía real para
   que deje de ser un mock.
5. ~~Redefinir las reglas de reintentos del EETT en `cascada.ts`~~ — hecho
   (`DECISIONS.md` D-031); pendiente el recontacto post-NSP, bloqueado por
   la RF de marcaje de asistencia (§3).
6. Interoperabilidad HIS (§5) **pospuesta por decisión de producto**
   (`DECISIONS.md` D-033) — la ingesta Excel/CSV queda como vía de carga
   vigente para los 10 establecimientos. Retomar cuando corresponda,
   empezando por el levantamiento de qué HIS usa cada establecimiento.
