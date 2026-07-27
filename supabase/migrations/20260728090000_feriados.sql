-- Fase 1 — calendario de feriados nacionales (EETT §"Requisitos del
-- Convenio": "Días bloqueados: domingos y festivos, sin contacto de ningún
-- tipo"). Tabla editable sin depender de un deploy, consistente con la
-- autonomía de los establecimientos exigida por el EETT.
--
-- Sembrado SOLO con feriados 2026 de fecha cierta (fijos + los dos móviles
-- de Semana Santa, calculados por el algoritmo de Meeus/Jones/Butcher).
-- Deliberadamente NO se incluyen los feriados sujetos a la "ley de
-- traslado a día lunes" (12 de octubre, 31 de octubre) ni el Día Nacional
-- de los Pueblos Indígenas (fecha variable por decreto, ligada al
-- solsticio): confirmar la fecha exacta 2026 contra el Diario Oficial /
-- decreto del Ministerio del Interior antes de producción — ver
-- DECISIONS.md.

create table feriados (
  fecha     date primary key,
  nombre    text not null,
  creado_at timestamptz not null default now()
);

insert into feriados (fecha, nombre) values
  ('2026-01-01', 'Año Nuevo'),
  ('2026-04-03', 'Viernes Santo'),
  ('2026-04-04', 'Sábado Santo'),
  ('2026-05-01', 'Día Nacional del Trabajo'),
  ('2026-05-21', 'Día de las Glorias Navales'),
  ('2026-07-16', 'Virgen del Carmen'),
  ('2026-08-15', 'Asunción de la Virgen'),
  ('2026-09-18', 'Independencia Nacional'),
  ('2026-09-19', 'Día de las Glorias del Ejército'),
  ('2026-11-01', 'Todos los Santos'),
  ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad');
