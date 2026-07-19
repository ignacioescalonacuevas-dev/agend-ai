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

## Hito 1 — cómo correrlo

```bash
cd recupero-cupos
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
  encola el paso 1. Un pase de recuperación re-encola citas sin intentos.
- **Cascada por ciclo**: paso 1 WhatsApp (plantilla 3 botones) → T+4 h paso
  2 SMS con enlace de un toque → T+8 h paso 3 tarea de llamada manual
  (intento `llamada`/`pendiente`). Ciclo 2 espeja al 1 desde T+12 h; 4 h
  después de agotarlo, la cita pasa a `incontactable` (auditado). Si el
  paciente responde, todo paso posterior se omite en silencio.
- **Ventana horaria 09:00–20:00 (America/Santiago)**: pasos fuera de
  ventana se difieren a la próxima apertura (tests cubren ambos cambios de
  hora chilenos). Fallos de envío quedan `fallido` y pg-boss reintenta con
  backoff; el índice único `(cita, ciclo, paso)` garantiza a lo más un
  intento por paso.
- **Canales**: interfaz `CanalMensajeria` con mocks (`CanalMock`) para
  desarrollar sin credenciales; los adaptadores reales de Meta/Twilio se
  enchufan sin tocar la cascada.

### Estructura

```
recupero-cupos/
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
