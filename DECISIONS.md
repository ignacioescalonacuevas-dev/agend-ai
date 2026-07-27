# DECISIONS.md — Recupero de Cupos

Registro de decisiones de diseño tomadas durante el desarrollo, según el
acuerdo de trabajo: detalles menores se deciden y documentan aquí; lo que
bloquea el diseño se pregunta antes de asumir.

## Decisiones tomadas

### D-001 · Repo dedicado `agend-ai`
El proyecto arrancó como sub-directorio (`recupero-cupos/`) dentro del repo
`bed-flow` (gestión de camas, stack distinto) para no interferir con ese
desarrollo. Migrado a `agend-ai`, repo dedicado, con la historia de commits
de la Fase 0 preservada. Las rutas del kickoff (`/supabase/migrations`,
`/src/domain/estado-cita.ts`) ahora son relativas a la raíz del repo.

### D-002 · Tabla de transiciones estricta al PRD
`TABLA_TRANSICIONES` implementa exactamente RF-5:
`pendiente → en_contacto → {confirmada | cancelada | reagendar | incontactable}`.
Los cuatro estados de respuesta son terminales en Fase 0. Ver propuestas
P-001/P-002 abajo para los casos que el PRD no cubre.

### D-003 · Columna `estado_cupo` en `citas`
RF-6 exige bloquear el cupo durante la oferta (`en_oferta`) y marcar
`recuperable_no_tomado`. El cupo ES la cita cancelada, así que se modela como
columna nullable `estado_cupo` en `citas`
(`liberado | en_oferta | reasignado | recuperable_no_tomado`; NULL = cupo no
liberado) en vez de una séptima tabla. Complementa, no reemplaza, el lock
`SELECT ... FOR UPDATE` del hito 5.

### D-004 · Solo una oferta viva por cupo, garantizado por índice
Índice único parcial `ofertas_recupero_una_activa_por_cupo`
(`cupo_cita_id WHERE resultado = 'pendiente'`): la secuencialidad de ofertas
queda garantizada a nivel de esquema además del lock transaccional.

### D-005 · RUN normalizado con CHECK de formato en base
Formato almacenado: dígitos sin puntos + guión + dígito verificador
(`12345678-5`, `7654321-K`). El CHECK valida formato; la validación del
dígito verificador (módulo 11) es lógica de ingesta (hito 2).

### D-006 · `servicio` como texto plano por ahora
El PRD §6 no incluye tabla de servicios. RF-1 exige validar "servicio
existente", así que en el hito 2 se decidirá entre catálogo en tabla o lista
de configuración. Cambiarlo después es una migración pequeña.

### D-007 · Auditoría de transiciones inválidas y rollback
`transicionar()` inserta el evento `transicion_rechazada` y lanza
`TransicionInvalidaError` sin tocar el estado. El contrato pide al caller
capturar y **commitear** para conservar ese evento (un rollback lo pierde,
sin otro efecto). El orquestador del hito 3 seguirá ese contrato.

### D-008 · Append-only con GRANT + trigger
Además del REVOKE de UPDATE/DELETE/TRUNCATE exigido por el kickoff, un
trigger bloquea mutaciones incluso para el dueño de la tabla (defensa en
profundidad). Los GRANT cubren los roles Supabase (`anon`, `authenticated`,
`service_role`) cuando existen.

### D-009 · Migraciones en dev/test vía script propio
`scripts/apply-migrations.mjs` aplica `supabase/migrations/*.sql` en orden
para desarrollo y tests (el sandbox no tiene Supabase CLI). Entornos reales
usan la CLI de Supabase sobre el mismo directorio; el directorio de
migraciones es la única fuente de cambios de esquema en ambos caminos.

### D-010 · Cluster Postgres desechable para tests de integración
`scripts/test-db.sh` levanta Postgres 16 (Docker si hay daemon; `initdb`
local si no), crea los roles Supabase simulados y aplica las migraciones.
Así los tests de GRANTs y de transacciones corren contra Postgres real, no
mocks — requisito para el test de concurrencia del hito 5.

### D-011 · RLS se activa en el hito 6
Los primeros hitos operan por backend con rol de servicio. Activar RLS sin
políticas ahora solo agregaría ruido; las políticas por rol y por servicio
llegan con el dashboard (hito 6). `eventos_auditoria` ya queda protegida hoy
por D-008.

### D-012 · Catálogo `servicios` en tabla (resuelve D-006)
RF-1 exige validar "servicio existente"; se creó la tabla `servicios`
(slug + nombre + activo) con FK desde `citas` y `lista_espera`. Los valores
de los archivos se normalizan a slug ('Dermatología' → 'dermatologia').

### D-013 · Plantillas de mapeo minimalistas
`plantillas_mapeo` guarda el mapeo columna→campo como jsonb bajo un nombre.
El "asistente de primera carga" de RF-1 es por ahora: auto-detección por
alias de encabezados + mapeo manual opcional + guardado de plantilla. El
asistente visual completo queda para cuando exista el dashboard (hito 6).

### D-014 · Ingesta sin autenticación hasta el hito 6
El endpoint `/api/ingesta/agenda` usa actor `admision:dev` fijo. Con
Supabase Auth (hito 6) se exigirá rol `admision`/`admin` y el actor será el
usuario real. No exponer el entorno de desarrollo públicamente.

### D-015 · Recargas actualizan solo campos de agenda
El upsert por clave natural refresca `profesional` (y datos del paciente)
pero NUNCA `estado` ni `origen`: una recarga no debe deshacer una
confirmación o cancelación ya registrada. Duplicados dentro del mismo
archivo: gana la primera fila, las siguientes se rechazan con motivo.

### D-016 · Teléfonos: 9 dígitos nacionales
Se aceptan formatos con +56, 56, prefijo 0 histórico, espacios/guiones;
todo se normaliza a `+56` + 9 dígitos (móviles y fijos post-2016). Números
que no resuelven a 9 dígitos se rechazan (mejor rechazar que contactar a un
número equivocado). La carga marca `consentimiento_contacto = true` porque
la agenda proviene del proceso institucional de admisión.

### D-017 · Calendario de la cascada
El PRD fija T+4 h (SMS) y T+8 h (llamada) para el ciclo 1. Para el ciclo 2
(no especificado) se espeja el ciclo 1 partiendo en T+12 h; la verificación
de `incontactable` corre 4 h después del último paso (T+24 h). Si la
fecha de la cita llega antes de completar la cascada, esta se detiene sin
marcar `incontactable` (la asistencia se marca manualmente en fase 0).

### D-018 · `ciclo`/`paso` en `intentos_contacto` + cola de llamadas
Se agregaron columnas `ciclo` (1-2) y `paso` (1-3) con índice único
`(cita_id, ciclo, paso)`: idempotencia dura — un paso solo puede producir un
intento aunque el job se repita. La "cola de llamadas manuales" del paso 3
es simplemente un intento con canal `llamada` y resultado `pendiente` (el
operador la resolverá desde el dashboard, hito 6); no requiere tabla nueva.

### D-019 · Semántica de envío: at-least-once
El intento y el envío comparten transacción; una caída entre el envío al
proveedor y el commit puede reenviar el mensaje en el reintento (aceptable
en fase 0; los adaptadores reales usarán claves de idempotencia del
proveedor). Un envío fallido queda como `fallido` y autoriza el reenvío en
el reintento de pg-boss (backoff exponencial, 5 intentos).

### D-020 · Idempotencia del scheduler
El scheduler transiciona `pendiente → en_contacto` (auditado) ANTES de
encolar: el estado es lo que impide que una cita entre dos veces a la
cascada. Un pase de recuperación re-encola citas `en_contacto` sin intentos
tras 90 min (enqueue perdido); el `singletonKey` por (cita, ciclo, paso) en
pg-boss deduplica en la cola.

### D-021 · Enlace del SMS provisorio
Hasta el hito 4, el SMS enlaza a `/r/{citaId}` sin token. Se reemplaza por
el token firmado de un solo uso cuando exista la página pública.

### D-022 · Multi-tenant por fila, no por despliegue (Fase 1 EETT)
El EETT de la licitación exige un contrato por establecimiento (10 en
total) sobre una sola plataforma. Se optó por `establecimiento_id` en cada
tabla operativa + RLS, en vez de 10 despliegues separados: más barato de
operar, y necesario para el rol "Coordinador de la Red" (visión agregada).
`servicios` pasa de PK simple (`id`) a compuesta (`establecimiento_id, id`):
el mismo slug de servicio ('dermatologia') puede existir en dos
establecimientos como filas distintas. `citas` y `lista_espera` heredan
`establecimiento_id` y sus claves naturales/únicas lo incluyen.

### D-023 · RLS parcial ya en Fase 1 (revisa D-011)
D-011 postergaba toda RLS al hito 6. Se adelantó una porción mínima: SELECT
en `servicios`/`citas`/`lista_espera`/`plantillas_mapeo` filtrado por
`current_setting('app.establecimiento_id')` o `app.coordinador_red = true`
vía función `app_establecimiento_visible()`. Motivo: el aislamiento entre
establecimientos es una garantía de esquema, no solo de aplicación, y vale
la pena tenerla desde que el multi-tenant existe. Lo que SIGUE en hito 6:
políticas de INSERT/UPDATE por rol (`admin`/`admision`/
`encargado_servicio`/`jefatura`) y el wiring real de claims JWT de Supabase
Auth — hoy `app.establecimiento_id` se fija a mano vía `set_config` (ver
`tests/multi_tenant.persistencia.test.ts`), no desde una sesión de usuario.
`service_role` tiene `BYPASSRLS` (igual que en Supabase gestionado); el
pool `pg` del backend seguirá conectando con un rol privilegiado hasta que
exista sesión por usuario.

### D-024 · `pacientes` y `eventos_auditoria` quedan fuera del multi-tenant (por ahora)
Dos decisiones deliberadas, no descuidos:
- `pacientes` sigue global (sin `establecimiento_id`): una persona puede
  atenderse en más de un establecimiento de la misma red, y su RUN es un
  identificador nacional. La tabla en sí no queda con RLS — el aislamiento
  real ocurre en `citas`/`lista_espera`, que sí son privadas. Limitación
  conocida: alguien con rol `authenticated` que ya conozca un RUN podría
  potencialmente leer `pacientes` directo (no vía join) sin que RLS lo
  filtre. Se resuelve en hito 6 exponiendo `pacientes` solo vía funciones/
  vistas que exigen un `citas`/`lista_espera` visible como puente, no la
  tabla cruda.
- `eventos_auditoria` no ganó `establecimiento_id` en esta migración:
  hacerlo bien requiere pasarlo por cada punto de `registrarEvento()`
  (`estado-cita.ts`, `cascada.ts`, `ingesta-service.ts`), y ese trabajo
  pertenece al hito 6 (dashboard con "vista de consulta filtrable solo para
  `admin` y `jefatura`", RF-8). Por ahora la protección de
  `eventos_auditoria` sigue siendo GRANT + trigger (D-008), sin RLS.

### D-025 · `establecimientos` sin monto del contrato
`monto_disponible_clp` (agregado en D-022) se retiró en una migración
siguiente: es información contractual/licitatoria, no un dato que el
sistema de contactabilidad necesite para operar, y no debería vivir en la
base de datos operativa. Se prefirió una migración nueva que hace `DROP
COLUMN` en vez de reescribir la migración anterior — no se reescriben
migraciones ya aplicadas (D-009), aunque en este caso nunca haya salido de
entornos de desarrollo.

### D-026 · Ventanas horarias por canal + calendario de feriados (RF-2/RF-3)
Fase 0 usaba una ventana única 09:00–20:00 para todo canal. El EETT define
ventanas distintas: mensajería (WhatsApp/SMS) 08:30–19:00 L-V y 09:00–13:00
sábado; llamadas (IVR) 09:00–11:30 y 14:00–17:00 L-V (dos tramos, con pausa
de mediodía) y 09:00–13:00 sábado; domingos y feriados bloqueados para todo
canal. `dentroDeVentana()`/`proximaAperturaVentana()` ahora reciben
`canal` y el set de feriados (cargado de la tabla `feriados`, no
hardcodeado, para que sea editable sin deploy). El SMS comparte ventana con
WhatsApp: el EETT los agrupa bajo "mensajería" y solo separa el horario de
llamadas.

### D-027 · Calendario de feriados 2026 parcial a propósito
La tabla `feriados` se sembró solo con fechas de certeza total: los fijos
del calendario chileno + los dos móviles de Semana Santa (calculados por
Meeus/Jones/Butcher, no copiados de memoria). **Deliberadamente NO
incluye** el 12 de octubre ni el 31 de octubre (sujetos a la ley de
traslado a día lunes, cuya fecha exacta 2026 no se calculó aquí para no
arriesgar un error operacional) ni el Día Nacional de los Pueblos
Indígenas (fecha variable por decreto, ligada al solsticio). Hay que
completar la tabla contra el Diario Oficial antes de producción — es un
`INSERT` simple, no una migración de esquema.

### D-028 · Prefijo 600 para llamadas salientes: pendiente de canal IVR
El EETT exige que las llamadas salientes usen el prefijo 600 (normativa
SUBTEL 2025). No se agregó configuración para esto todavía porque no existe
canal de voz real: el "paso 3" de la cascada sigue siendo una tarea de
llamada manual (D-018), no una llamada automatizada. Se resuelve cuando se
construya el canal IVR (Fase 2 del plan de licitación) — agregar la
constante ahora, sin nada que la consuma, sería configuración sin uso.

### D-029 · Reglas de reintentos del EETT: brecha conocida, no resuelta aquí
El EETT fija máximo 3 intentos totales por episodio, máximo 2 por canal
antes de cambiar, 120 min mínimo entre intentos del mismo canal, y tres
tipos de recordatorio con anticipación fija (informativo 5-7 días antes al
agendar, interactivo 48 h antes, llamada de confirmación 24 h antes). El
modelo actual de cascada (2 ciclos × 3 pasos, hasta 6 intentos) no calza
con eso: son dos modelos de negocio distintos, no un ajuste de parámetros.
Redefinir esto toca la estructura de `cascada.ts`, no solo constantes —
queda como el siguiente paso explícito de la Fase 1, pendiente de decisión
de producto antes de tocar código (igual que P-001/P-002 abajo).

## Propuestas fuera del PRD (pendientes de tu visto bueno)

### P-001 · Cancelación tardía tras confirmar
El PRD no define `confirmada → cancelada`. En la práctica un paciente puede
cancelar después de confirmar, y esa cancelación debería disparar recupero
(RF-6). Propuesta: permitir `confirmada → cancelada` y `confirmada →
reagendar`. **No implementado** hasta tu confirmación (afecta hito 4).

### P-002 · Respuesta tardía de un paciente `incontactable`
Si un paciente marcado `incontactable` responde después, hoy la respuesta se
rechaza (y queda auditada). Propuesta: permitir `incontactable →
{confirmada | cancelada | reagendar}` — coherente con "el silencio nunca
libera un cupo": una respuesta explícita tardía debería contar. **No
implementado** hasta tu confirmación (afecta hito 4).

### P-003 · Dedup de mensajes entrantes de webhook
El índice único sobre `intentos_contacto.external_message_id` cubre
callbacks de estado de mensajes salientes. Para mensajes *entrantes* (la
respuesta del paciente) probablemente convenga una tabla
`mensajes_entrantes` con su propio id externo único. Se decide en el hito 4.
