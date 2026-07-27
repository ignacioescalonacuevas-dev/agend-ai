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
