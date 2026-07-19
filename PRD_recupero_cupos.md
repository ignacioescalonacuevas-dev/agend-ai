# PRD — Sistema de Recupero de Cupos y Confirmación de Citas
**Versión:** 0.1 · Julio 2026 · **Autor:** Ignacio Escalona · **Estado:** Borrador para desarrollo (Fase 0)

---

## 1. Contexto y problema

Los hospitales públicos chilenos pierden cupos de atención diariamente por inasistencias ("no se presenta", NSP) y cancelaciones tardías. Las soluciones actuales de recordatorio tienen dos carencias confirmadas con usuarios reales:

1. **No reagendan:** detectan la cancelación pero el cupo se pierde igual.
2. **No dan feedback:** los encargados de servicio y las jefaturas no ven niveles de confirmación, cancelación ni pacientes incontactables.

El sistema contacta a cada paciente 24–48 h antes de su cita (~700 citas/día en el establecimiento objetivo), gestiona su respuesta mediante una máquina de estados, y ante una cancelación ofrece el cupo automáticamente al siguiente paciente elegible de la lista de espera.

## 2. Objetivos y métricas de éxito

| Objetivo | Métrica | Meta piloto (90 días) |
|---|---|---|
| Reducir NSP | % citas no presentadas vs. baseline | −30% relativo |
| Recuperar cupos | Cupos reasignados / cupos cancelados | ≥ 40% |
| Visibilidad | Servicios con dashboard activo | 100% del piloto |
| Contactabilidad | % pacientes con respuesta (cualquier canal) | ≥ 85% |

**No-objetivos del MVP:** integración directa con SSASUR (fase 2), predicción de no-show con ML, agendamiento de citas nuevas de origen.

## 3. Usuarios y roles

| Rol | Permisos | Necesidad principal |
|---|---|---|
| `admin` | Todo, configuración de servicios y plantillas | Operar el sistema |
| `admision` | Carga de agenda, cola de cambios, gestión lista de espera | Reflejar cambios en SSASUR |
| `encargado_servicio` | Lectura de SU servicio, export | Saber quién confirmó, canceló o es incontactable |
| `jefatura` | Lectura agregada de todos los servicios, export | Tendencias y cupos recuperados |

Los pacientes NO tienen cuenta: interactúan solo por WhatsApp/SMS/voz.

## 4. Alcance funcional (Fase 0 + Fase 1)

### RF-1 · Ingesta de agenda
- Carga de archivo Excel/CSV con la agenda exportada desde SSASUR por admisión.
- Mapeo de columnas configurable (asistente de primera carga, plantilla guardada).
- Validación: RUN válido (dígito verificador), teléfono normalizado a E.164 (+56), fecha futura, servicio existente. Filas inválidas se reportan, no se descartan silenciosamente.
- Deduplicación: recargas del mismo día actualizan, no duplican (clave natural: RUN + servicio + fecha_hora).

### RF-2 · Scheduler
- Job cada 60 min: selecciona citas con estado `pendiente` cuya fecha_hora esté entre +24 h y +48 h y encola trabajos de contacto.
- Idempotente: una cita nunca entra dos veces a la cascada.
- Ventana horaria de contacto: solo entre 09:00 y 20:00 (America/Santiago). Trabajos fuera de horario se difieren.

### RF-3 · Orquestador de contacto (cascada)
- Paso 1: WhatsApp Cloud API, plantilla con 3 botones: **Confirmo / Cancelo / Necesito cambiar**.
- Paso 2 (T+4 h sin respuesta): SMS con enlace corto a página pública de respuesta de un toque (token firmado de un solo uso, sin login).
- Paso 3 (T+8 h sin respuesta): tarea de llamada manual en cola para operador (fase 0); IA de voz en fase 2.
- Tras 2 ciclos completos sin respuesta → estado `incontactable`.
- Cada intento se registra en `intentos_contacto` (canal, plantilla, timestamp, resultado, message_id externo).

### RF-4 · Procesamiento de respuestas
- Webhook de Meta (WhatsApp) y Twilio (SMS/voz) → normalización → transición de estado.
- Respuestas de texto libre en WhatsApp: clasificación simple por palabras clave (sí/no/cambiar); si es ambigua, re-pregunta con botones. Sin LLM en fase 0.
- Toda transición de estado emite un evento de auditoría.

### RF-5 · Máquina de estados de la cita
`pendiente → en_contacto → { confirmada | cancelada | reagendar | incontactable }`
- **Regla crítica:** el silencio NUNCA libera un cupo. Solo una cancelación explícita dispara el recupero.
- `reagendar` envía la solicitud a la cola de admisión y libera el cupo original al pool de recupero.
- Transiciones válidas definidas en código como tabla única (single source of truth); transiciones inválidas lanzan error y evento de auditoría.

### RF-6 · Recupero de cupos
- Trigger: transición a `cancelada` o `reagendar`.
- Selección: pacientes de `lista_espera` del mismo servicio con `pre_consentido = true`, ordenados por prioridad y antigüedad.
- Oferta **secuencial** por WhatsApp con timeout de 2 h por paciente. Nunca simultánea.
- Bloqueo pesimista del cupo durante la oferta (lock a nivel de fila / estado `en_oferta`) para impedir doble asignación.
- Aceptación → nueva cita con `origen = recupero`, confirmación al paciente, tarea a cola de admisión ("registrar en SSASUR").
- Lista agotada sin tomador → cupo marcado `recuperable_no_tomado`, visible en dashboard.

### RF-7 · Dashboard y reportería
- Vista encargado: tabla de citas de su servicio (hoy + 48 h) con estado, historial de intentos expandible, tasas del día.
- Vista jefatura: agregado por servicio, serie temporal de NSP, cupos recuperados acumulados, comparación con baseline.
- Vista admisión: cola de cambios pendientes de aplicar en SSASUR con check de "aplicado" (auditado).
- Export a Excel (xlsx) de cualquier vista, con los mismos filtros aplicados.

### RF-8 · Auditoría
- Tabla `eventos_auditoria` append-only: sin UPDATE/DELETE a nivel de GRANT en Postgres.
- Registra: transiciones de estado, ofertas de recupero, cargas de agenda, acciones de usuarios, cambios aplicados en SSASUR.
- Vista de consulta filtrable solo para `admin` y `jefatura`.

## 5. Requisitos no funcionales

| Área | Requisito |
|---|---|
| **Protección de datos** | Datos de salud = categoría sensible bajo Ley 21.719 (Chile). Cifrado en tránsito y reposo, minimización (solo campos necesarios para contactar), retención definida y documentada. Sin datos reales en entornos de desarrollo. |
| **Seguridad** | Supabase Auth + RLS por rol y por servicio. Tokens de respuesta pública: firmados, de un solo uso, expiración 48 h. Secretos solo en variables de entorno. |
| **Concurrencia** | Un cupo jamás puede asignarse a dos pacientes: lock transaccional en la oferta de recupero. Webhooks idempotentes (dedup por message_id). |
| **Volumen** | 700 citas/día → ~2.000 mensajes/día con cascada y recupero. Colas con reintentos y backoff exponencial ante fallos de API externas. |
| **Disponibilidad** | El sistema degrada con gracia: si Meta/Twilio caen, los trabajos se difieren, nunca se pierden. |
| **Zona horaria** | Todo en America/Santiago. Cuidado con UTC en Postgres: almacenar timestamptz, mostrar localizado. |
| **Auditabilidad** | Cualquier reasignación reconstruible de punta a punta (quién, cuándo, por qué canal, con qué respuesta). |

## 6. Modelo de datos (resumen)

- `pacientes` (run PK, nombre, telefonos[], canal_preferido, consentimiento_contacto, consentimiento_aviso_corto)
- `citas` (id PK, run_paciente FK, servicio, profesional, fecha_hora timestamptz, estado, origen)
- `intentos_contacto` (id PK, cita_id FK, canal, plantilla, timestamp, resultado, external_message_id)
- `lista_espera` (id PK, run_paciente FK, servicio, prioridad, pre_consentido, fecha_ingreso)
- `ofertas_recupero` (id PK, cupo_cita_id FK, run_paciente FK, enviada_at, expira_at, resultado)
- `eventos_auditoria` (id PK, entidad, entidad_id, accion, actor, detalle jsonb, timestamp) — append-only

## 7. Riesgos y decisiones abiertas

| Riesgo | Mitigación |
|---|---|
| Plantillas WhatsApp requieren aprobación de Meta (días) | Enviarlas a aprobación en semana 1, antes de terminar el backend |
| Baja adopción de carga manual por admisión | Asistente de carga a prueba de errores + una sola acción diaria |
| Paciente confirma pero no asiste | Métrica separada: "confirmó y no asistió" (requiere marcaje de asistencia post-cita, entrada manual en fase 0) |
| Convenio SSASUR no llega | El MVP no lo necesita; el valor se demuestra con Excel |

## 8. Fases

- **Fase 0 (2–4 semanas):** RF-1 a RF-5, RF-7 básico, RF-8. Piloto en un servicio.
- **Fase 1 (piloto 90 días):** RF-6 completo, llamadas humanas, medición vs. baseline.
- **Fase 2:** IA de voz, integración SSASUR por convenio, multi-establecimiento, predicción NSP.
