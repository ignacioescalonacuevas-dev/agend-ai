# Recupero de Cupos — Fase 0

Sistema de confirmación de citas y recupero de cupos para un hospital
público chileno (~700 citas/día). La fuente de verdad funcional es
[`PRD_recupero_cupos.md`](./PRD_recupero_cupos.md); las decisiones de diseño
van quedando en [`DECISIONS.md`](./DECISIONS.md).

**Stack:** Next.js (App Router, TypeScript estricto) · Supabase (Postgres,
Auth, RLS) · pg-boss · WhatsApp Cloud API + Twilio SMS · Vitest.

## Estado de los hitos

| # | Hito | Estado |
|---|------|--------|
| 1 | Esquema (6 tablas) + máquina de estados con tests | ✅ listo para revisión |
| 2 | Ingesta Excel/CSV con validación y reporte de rechazos | ✅ listo para revisión |
| 3 | Scheduler + orquestador de cascada (adaptadores mock) | ✅ listo para revisión |
| 4 | Webhooks idempotentes + página pública de respuesta | pendiente |
| 5 | Recupero de cupos con lock transaccional | pendiente |
| 6 | Dashboards por rol con RLS + export xlsx | pendiente |

## Multi-tenant (Fase 1 del plan de licitación)

Este proyecto es la base para la licitación "Sistema Automatizado de
Contactabilidad mediante IA" del Servicio de Salud Aysén (10
establecimientos, 1 plataforma). El detalle completo del plan de
construcción está en
[`PLAN_LICITACION_CONTACTABILIDAD.md`](./PLAN_LICITACION_CONTACTABILIDAD.md).

Avance de la Fase 1:
- Esquema multi-establecimiento: `cita`, `lista_espera`, `servicio` y
  `plantilla_mapeo` quedan scoped por `establecimiento_id`, con Row-Level
  Security habilitado (`tests/multi_tenant.persistencia.test.ts` verifica
  el aislamiento). Detalle en `DECISIONS.md` D-022 a D-024.
- Ventanas horarias por canal (mensajería vs. llamadas) + calendario de
  feriados editable en tabla `feriados`, reemplazando la ventana única
  09:00–20:00 de Fase 0 (`DECISIONS.md` D-026/D-027).
- Canal IVR: la llamada de confirmación pasa de tarea manual a llamada
  automatizada (`CanalLlamada`, mock hasta que exista carrier de voz real),
  con el prefijo 600 exigido por el EETT ya viajando en cada llamada
  colocada (`DECISIONS.md` D-030).
- Reglas de reintentos del EETT: la cascada se rediseñó a un episodio único
  de 3 intentos, anclados a la hora de la cita (recordatorio informativo
  5-7 días antes → recordatorio interactivo 48h antes por WhatsApp → SMS a
  los 120 min → llamada IVR anclada a T-24h, solo si no hubo respuesta
  digital) — ver `DECISIONS.md` D-031 para el detalle y las dos ambigüedades
  del EETT resueltas por decisión explícita. Pendiente, fuera de este
  cambio: el recontacto post-NSP (depende de marcaje de asistencia, RF no
  construida todavía).
- Interoperabilidad HIS (§5) **pospuesta por decisión de producto**: la
  ingesta Excel/CSV del hito 2 queda como vía de carga vigente para los 10
  establecimientos (`DECISIONS.md` D-033).

## Roles y RLS de escritura (§4 del plan de licitación)

Solo el modelo de datos, **sin login real todavía** (no hay proyecto
Supabase provisionado — ver `DECISIONS.md` D-035):

- Tabla `perfiles` (`user_id`, `rol`, `establecimiento_id`) con los 4 roles
  que nombra el EETT: `admision`, `encargado_servicio`, `jefatura`
  (per-establecimiento) y `coordinador_red` (red completa).
- Políticas RLS de INSERT/UPDATE en `citas`/`lista_espera`/`tickets`,
  separadas de las de lectura: los 3 roles locales pueden escribir dentro
  de su propio establecimiento; `coordinador_red` es de solo lectura
  agregada, sin escritura en ninguna parte.
- `src/lib/perfiles-repo.ts` (`obtenerContextoSesion()`) y
  `src/lib/rls-contexto.ts` (`aplicarContextoSesion()`) son las piezas que
  una futura capa de wiring de Supabase Auth real llamará por request; hoy
  las usan directamente los tests (`tests/perfiles.persistencia.test.ts`).
- Pendiente: login real (`supabase-js`), MFA (§9), UI de administración de
  usuarios.

## Mesa de ayuda (§6 del plan de licitación)

Hito 1: esquema + máquina de estados + cálculo de SLA, **sin UI todavía**
(el modelo de roles ya existe — ver arriba — pero no hay login real
conectado; ver `DECISIONS.md` D-034 para el detalle completo y las
decisiones tomadas sin texto exacto del EETT).

- Ticket con los 12 campos mínimos del EETT (`tickets`, migración
  `20260731090000_tickets_mesa_ayuda.sql`), máquina de estados lineal
  `abierto → en_atencion → resuelto → cerrado` (`src/domain/estado-ticket.ts`,
  mismo patrón que `estado-cita.ts`), multi-tenant + RLS igual que el resto
  del esquema.
- Clasificación automática a criticidad alta para incidentes que
  interrumpen el envío de mensajes (`crearTicket()` en
  `src/lib/tickets-service.ts`), no discrecional, auditada cuando hay
  override.
- SLA por criticidad (alta 1h/4h, media 6h/24h, baja 24h/5 días hábiles)
  en `src/domain/sla-ticket.ts`.
- Pendiente: página/dashboard de mesa de ayuda, escalamiento automático,
  reportes de cumplimiento de SLA (§7) y la dotación 24x7x365 (decisión de
  negocio, no de código).

```bash
npm run db:test:start
DATABASE_URL=postgres://postgres@127.0.0.1:54329/recupero_test npx vitest run \
  tests/estado-ticket.matriz.test.ts tests/sla-ticket.test.ts tests/tickets.persistencia.test.ts
npm run db:test:stop
```

## Hito 1 — cómo correrlo

```bash
npm install

# Tests unitarios (matriz completa de transiciones, sin base de datos)
npm run test:unit

# Suite completa: levanta un Postgres desechable, aplica migraciones,
# corre unitarios + integración y apaga el cluster.
npm run test:full
```

Alternativa manual (deja la base arriba para inspeccionarla con psql):

```bash
npm run db:test:start   # cluster en 127.0.0.1:54329 + roles + migraciones
DATABASE_URL=postgres://postgres@127.0.0.1:54329/recupero_test npx vitest run
npm run db:test:stop
```

Sin `DATABASE_URL`, los tests de integración se saltan y solo corren los
tests unitarios (matriz de transiciones, RUN, teléfonos, fechas, ingesta).

## Hito 2 — ingesta de agenda (RF-1)

```bash
npm run db:test:start    # base local con migraciones y catálogo de servicios
DATABASE_URL=postgres://postgres@127.0.0.1:54329/recupero_test npm run db:seed
DATABASE_URL=postgres://postgres@127.0.0.1:54329/recupero_test npm run dev
# → http://localhost:3000/ingesta  (cargue ejemplos/agenda_ejemplo.csv)
```

- Acepta `.csv` (separador `,` o `;`) y `.xlsx`, con detección automática de
  columnas por alias ("RUT Paciente", "Especialidad", "Fecha y hora", …) o
  mapeo manual; la plantilla efectiva puede guardarse para recargas.
- Valida: RUN con dígito verificador (módulo 11), teléfono normalizado a
  E.164 (+56), servicio existente en el catálogo, fecha futura interpretada
  en `America/Santiago` (con tests de borde para el cambio de hora chileno).
- Las filas inválidas se reportan con todos sus errores; nunca se descartan
  en silencio. Recargar el mismo archivo actualiza por clave natural
  (RUN + servicio + fecha/hora) sin duplicar y sin resetear el estado de
  citas que ya avanzaron en su ciclo de vida.
- Cada carga queda auditada en `eventos_auditoria` (`carga_agenda`).

## Hito 3 — scheduler y cascada de contacto (RF-2, RF-3)

```bash
npm run db:test:start
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/recupero_test
npm run db:seed
EJECUTAR_SCHEDULER_AL_INICIO=1 npm run worker   # pg-boss + mocks con log
```

- **Scheduler (cada 60 min, cron pg-boss en `America/Santiago`)**: toma
  citas `pendiente` con fecha entre +24 h y +48 h, las pasa a `en_contacto`
  (eso hace la selección idempotente: una cita jamás entra dos veces) y
  encola el paso `interactivo_1`. Un pase de recuperación re-encola citas
  sin intentos. Un segundo pase, independiente (`encolarInformativos`),
  encola el recordatorio informativo 5-7 días antes sin transicionar
  estado.
- **Episodio único de 3 intentos** (D-029/D-031, reglas exactas del EETT):
  `informativo` (WhatsApp uno-a-muchos, T-7d..T-5d, no cuenta para el tope)
  → `interactivo_1` WhatsApp con botones (T-48h..T-24h) → `interactivo_2`
  SMS con enlace de un toque (120 min después) → `llamada` IVR de
  confirmación, anclada a T-24h y condicionada a que no haya habido
  respuesta digital → `verificacion` 4h después, que marca `incontactable`
  si sigue sin respuesta. Si el paciente responde, todo paso posterior se
  omite en silencio.
- **Ventana horaria por canal (America/Santiago)**: mensajería (WhatsApp/
  SMS) 08:30–19:00 L-V y 09:00–13:00 sábado; llamadas 09:00–11:30 y
  14:00–17:00 L-V y 09:00–13:00 sábado; domingos y feriados (tabla
  `feriados`) bloqueados para todo canal. Pasos fuera de ventana se
  difieren a la próxima apertura del canal correspondiente (tests cubren
  cambios de hora chilenos, fines de semana y feriados). Fallos de envío
  quedan `fallido` y pg-boss reintenta con backoff; el índice único
  `(cita, paso)` garantiza a lo más un intento por paso.
- **Canales**: interfaz `CanalMensajeria` (WhatsApp/SMS) e interfaz
  separada `CanalLlamada` (IVR, `llamar()` en vez de `enviar()` — una
  llamada no es "enviar y olvidar"). Mocks (`CanalMock`, `CanalLlamadaMock`)
  para desarrollar sin credenciales; los adaptadores reales de Meta/Twilio/
  carrier de voz se enchufan sin tocar la cascada. El resultado de una
  llamada (contestó, colgó, opción marcada) llega después por webhook
  (hito 4); hasta entonces `llamar()` solo confirma que el carrier colocó
  la llamada.

### Estructura

```
.
├── supabase/migrations/   # migration-first: única vía de cambios de esquema
├── src/domain/
│   └── estado-cita.ts     # máquina de estados (módulo único, RF-5)
├── src/app/               # Next.js App Router (placeholder hasta hito 2/6)
├── tests/                 # Vitest: matriz de transiciones + persistencia
└── scripts/               # test-db.sh, apply-migrations.mjs
```

### Máquina de estados (RF-5)

```
pendiente → en_contacto → { confirmada | cancelada | reagendar | incontactable }
```

Regla crítica: el silencio **nunca** libera un cupo; solo `cancelada` o
`reagendar` disparan el recupero. Toda transición pasa por `transicionar()`,
que valida contra la tabla única, persiste y emite el evento de auditoría en
la misma transacción. `eventos_auditoria` es append-only por GRANT y por
trigger.

### Variables de entorno

Copiar `.env.example` a `.env.local` (gitignoreado). Para el hito 1 solo se
usa `DATABASE_URL`; el resto queda documentado para los hitos siguientes.
Nunca cargar datos reales de pacientes en entornos de desarrollo (Ley
21.719): los seeds y tests usan RUN y teléfonos sintéticos.
