-- Fase 1 — el monto disponible del contrato no debe vivir en la base de
-- datos operativa (es información contractual/licitatoria, no un dato que
-- el sistema de contactabilidad necesite para operar). Se retira la
-- columna agregada en la migración anterior.

alter table establecimientos drop column monto_disponible_clp;
