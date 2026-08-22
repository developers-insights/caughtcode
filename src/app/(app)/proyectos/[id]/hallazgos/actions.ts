'use server'

/**
 * Cuánto sale volver a revisar este proyecto.
 *
 * Existe por una regla dura (`CLAUDE.md` #3): **el costo se muestra en dólares
 * y en unidades concretas antes de gastar**. La pantalla de hallazgos encolaba
 * la corrida en el mismo click del botón, sin decir el precio.
 *
 * La cuenta se hace **acá, en el servidor**, y al navegador solo baja el número
 * ya resuelto. La tabla de precios (`src/server/cost/pricing.ts`) no viaja al
 * cliente: si viajara, cualquiera podría recalcularla —o verla— y además
 * habría dos lugares donde el precio puede quedar desactualizado.
 */

import { unstable_rethrow } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import { T } from '@/lib/db/tablas'
import { estimate, ESTIMATION } from '@/server/cost/ledger'
import { traducirErrorTecnico } from '@/content/lenguaje'
import type { PresupuestoDeRevision } from '@/components/findings/run-cost'

import { requireSession } from '../../../current-org'

export type PresupuestoResultado =
  | { ok: true; presupuesto: PresupuestoDeRevision }
  | { ok: false; error: string; detalle: string | null }

/**
 * Cuántos archivos tomar para la cuenta cuando nunca analizamos el proyecto.
 *
 * Es el tope que mira el motor: por arriba de esto la estimación no crece en la
 * parte cara. Preferimos calcular alto y que salga menos, antes que prometer
 * barato y cobrar más.
 */
const ARCHIVOS_SIN_MEDIR = ESTIMATION.maxFilesAnalyzed

function leerFileCount(stats: unknown): number | null {
  if (!stats || typeof stats !== 'object') return null
  const valor = (stats as Record<string, unknown>).fileCount
  return typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? Math.round(valor) : null
}

/**
 * El tamaño del proyecto según la última vez que lo miramos.
 *
 * Sale del mapa que dejó la corrida anterior (`code_index`), no de contar
 * archivos de nuevo: contar significaría bajar el repositorio otra vez, que es
 * justamente parte de lo que se está por cobrar.
 */
async function archivosDeLaUltimaCorrida(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
): Promise<number | null> {
  const { data: corrida } = await supabase
    .from(T.analysisRuns)
    .select('id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!corrida?.id) return null

  const { data: indice } = await supabase
    .from(T.codeIndex)
    .select('stats')
    .eq('analysis_run_id', corrida.id)
    .maybeSingle()

  return leerFileCount(indice?.stats)
}

/**
 * El presupuesto de una revisión completa, listo para mostrar.
 *
 * Si algo falla, **no devolvemos un número igual**: devolvemos el error. La
 * pantalla no deja confirmar sin precio, y eso es deliberado — es preferible
 * hacer reintentar a alguien que cobrarle sin avisarle cuánto.
 */
export async function estimarRevisionAction(input: {
  projectId: string
}): Promise<PresupuestoResultado> {
  try {
    const { supabase } = await requireSession()

    // Modo demo: no hay base contra la que preguntar, pero el precio se muestra
    // igual. Una pantalla de demostración que se saltea la regla no sirve para
    // revisar que la regla se cumple.
    const archivos = supabase ? await archivosDeLaUltimaCorrida(supabase, input.projectId) : null

    const presupuesto = estimate('full_audit', { files: archivos ?? ARCHIVOS_SIN_MEDIR })

    return {
      ok: true,
      presupuesto: {
        costUsd: presupuesto.costUsd,
        unidades: presupuesto.unitsPlain,
        medido: archivos !== null,
        archivos,
      },
    }
  } catch (error) {
    // `requireSession()` redirige a la pantalla de entrar cuando no hay sesión,
    // y eso viaja como excepción. Si la tragáramos acá, a alguien con la sesión
    // vencida le diríamos "no pudimos sacar la cuenta" en vez de mandarlo a
    // entrar de nuevo.
    unstable_rethrow(error)

    const legible = traducirErrorTecnico(error instanceof Error ? error.message : String(error))
    return {
      ok: false,
      error: legible?.mensaje ?? 'No pudimos sacar la cuenta.',
      detalle: legible?.detalle ?? null,
    }
  }
}
