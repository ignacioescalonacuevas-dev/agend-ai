/**
 * POST /api/ingesta/agenda — agenda file upload (RF-1).
 *
 * multipart/form-data:
 *   archivo   (required) .csv or .xlsx exported from SSASUR
 *   mapeo     (optional) JSON MapeoColumnas; omitted = auto-detect
 *   plantilla (optional) template name to persist the effective mapping
 *
 * Auth arrives with Supabase in hito 6; until then the actor is a dev
 * placeholder and the endpoint must not be exposed publicly.
 */
import { NextResponse } from 'next/server';
import type { MapeoColumnas } from '@/domain/ingesta';
import { MapeoIncompletoError, cargarAgenda } from '@/lib/ingesta-service';

export async function POST(request: Request): Promise<NextResponse> {
  const formulario = await request.formData();
  const archivo = formulario.get('archivo');
  if (!(archivo instanceof File)) {
    return NextResponse.json(
      { error: 'Debe adjuntar el archivo de agenda en el campo "archivo".' },
      { status: 400 },
    );
  }

  let mapeo: MapeoColumnas | undefined;
  const mapeoCrudo = formulario.get('mapeo');
  if (typeof mapeoCrudo === 'string' && mapeoCrudo !== '') {
    try {
      mapeo = JSON.parse(mapeoCrudo) as MapeoColumnas;
    } catch {
      return NextResponse.json({ error: 'El campo "mapeo" no es JSON válido.' }, { status: 400 });
    }
  }

  const plantilla = formulario.get('plantilla');

  try {
    const reporte = await cargarAgenda(
      Buffer.from(await archivo.arrayBuffer()),
      archivo.name,
      {
        actor: 'admision:dev', // TODO(hito 6): real user from Supabase Auth
        mapeo,
        guardarPlantilla: typeof plantilla === 'string' ? plantilla : undefined,
      },
    );
    return NextResponse.json(reporte);
  } catch (err) {
    if (err instanceof MapeoIncompletoError) {
      return NextResponse.json({ error: err.message, faltantes: err.faltantes }, { status: 422 });
    }
    if (err instanceof Error && err.message.startsWith('Formato de archivo no soportado')) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
