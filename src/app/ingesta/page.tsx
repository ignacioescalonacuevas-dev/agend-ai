'use client';

// Minimal upload screen for the 'admision' role (RF-1). Styling and role
// gating arrive with the dashboards in hito 6; this page focuses on the
// upload → validation-report loop.
import { useState } from 'react';

// Fase 1: sin sesión todavía (hito 6), así que el establecimiento se elige a
// mano. En hito 6 este selector desaparece: el establecimiento vendrá del
// usuario autenticado.
const ESTABLECIMIENTOS = [
  ['consultorio-alejandro-gutierrez', 'Consultorio Alejandro Gutiérrez'],
  ['consultorio-victor-domingo-silva', 'Consultorio Víctor Domingo Silva'],
  ['cesfam-puerto-aysen', 'Cesfam Puerto Aysén'],
  ['cosam-coyhaique', 'Cosam Coyhaique'],
  ['direccion-salud-rural-la-junta', 'Dirección de Salud Rural (Cesfam La Junta)'],
  ['hospital-puerto-aysen', 'Hospital Puerto Aysén'],
  ['hospital-puerto-cisnes', 'Hospital Puerto Cisnes'],
  ['hospital-cochrane', 'Hospital Cochrane'],
  ['hospital-chile-chico', 'Hospital Chile Chico'],
  ['direccion-salud-rural', 'Dirección de Salud Rural'],
] as const;

interface FilaRechazada {
  fila: number;
  errores: string[];
  datos: Record<string, string>;
}

interface ReporteCarga {
  archivo: string;
  totalFilas: number;
  citasNuevas: number;
  citasActualizadas: number;
  pacientesNuevos: number;
  rechazadas: FilaRechazada[];
}

export default function PaginaIngesta() {
  const [reporte, setReporte] = useState<ReporteCarga | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setError(null);
    setReporte(null);
    setCargando(true);
    try {
      const respuesta = await fetch('/api/ingesta/agenda', {
        method: 'POST',
        body: new FormData(evento.currentTarget),
      });
      const cuerpo = await respuesta.json();
      if (!respuesta.ok) {
        setError(cuerpo.error ?? 'Error al procesar el archivo.');
      } else {
        setReporte(cuerpo as ReporteCarga);
      }
    } catch {
      setError('No fue posible conectar con el servidor. Intente nuevamente.');
    } finally {
      setCargando(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui' }}>
      <h1>Carga de agenda</h1>
      <p>
        Seleccione el archivo de agenda exportado desde SSASUR (formato .csv o .xlsx). Las filas
        con errores serán reportadas y no se cargarán; el resto quedará normalizado en el sistema.
      </p>

      <form onSubmit={enviar}>
        <label htmlFor="establecimientoId">Establecimiento: </label>
        <select id="establecimientoId" name="establecimientoId" required defaultValue="">
          <option value="" disabled>
            Seleccione…
          </option>
          {ESTABLECIMIENTOS.map(([id, nombre]) => (
            <option key={id} value={id}>
              {nombre}
            </option>
          ))}
        </select>
        <br />
        <br />
        <input type="file" name="archivo" accept=".csv,.xlsx" required />
        <button type="submit" disabled={cargando} style={{ marginLeft: '1rem' }}>
          {cargando ? 'Procesando…' : 'Cargar agenda'}
        </button>
      </form>

      {error !== null && (
        <p role="alert" style={{ color: '#b00020' }}>
          {error}
        </p>
      )}

      {reporte !== null && (
        <section>
          <h2>Resultado de la carga</h2>
          <ul>
            <li>Filas procesadas: {reporte.totalFilas}</li>
            <li>Citas nuevas: {reporte.citasNuevas}</li>
            <li>Citas actualizadas: {reporte.citasActualizadas}</li>
            <li>Pacientes nuevos: {reporte.pacientesNuevos}</li>
            <li>Filas rechazadas: {reporte.rechazadas.length}</li>
          </ul>

          {reporte.rechazadas.length > 0 && (
            <>
              <h3>Filas rechazadas</h3>
              <p>Corrija estos errores en el archivo y vuelva a cargarlo; las filas ya aceptadas no se duplicarán.</p>
              <table border={1} cellPadding={6} style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Errores</th>
                    <th>Contenido</th>
                  </tr>
                </thead>
                <tbody>
                  {reporte.rechazadas.map((fila) => (
                    <tr key={fila.fila}>
                      <td>{fila.fila}</td>
                      <td>{fila.errores.join('; ')}</td>
                      <td>
                        <code>{Object.values(fila.datos).join(' | ')}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </main>
  );
}
