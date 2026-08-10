import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { T } from '@/lib/db/tablas'
import { aFinding, aJob, aRun, aVideo } from '@/components/findings'
import type { FindingVideo, JobView, RunView } from '@/components/findings'
import {
  CORRIDA_TERMINADA,
  HALLAZGOS_DEMO,
  PROYECTO_DEMO,
  VIDEOS_DEMO,
  datosDemo,
  esEstadoDemo,
  type EstadoDemo,
} from '@/components/findings/fixtures'
import type { Finding, RunCoverage } from '@/lib/types/domain'

/**
 * De dónde salen los datos de la pantalla.
 *
 * Con `CAUGHTCODE_DEMO=1` se sirven los ejemplos del catálogo, para poder
 * mirar la pantalla sin base. En cualquier otro caso va a Supabase, donde las
 * reglas de acceso hacen el filtrado: acá no se chequean permisos a mano.
 */

export const MODO_DEMO = process.env.CAUGHTCODE_DEMO === '1'

export type Resultado =
  | { ok: true; datos: DatosDeHallazgos }
  | { ok: false; motivo: 'sin-permisos' | 'no-existe' | 'error'; detalle?: string }

export interface DatosDeHallazgos {
  proyecto: { id: string; nombre: string }
  run: RunView | null
  findings: Finding[]
  videos: Record<string, FindingVideo>
  /**
   * Los trabajos encolados de este proyecto.
   *
   * Sin esto la pantalla no puede distinguir *nunca lo revisamos* de
   * *lo revisamos y salió limpio*: en los dos casos no hay corrida ni
   * hallazgos, y decir lo segundo cuando pasó lo primero es afirmar algo que
   * no comprobamos.
   */
  trabajos: JobView[]
}

/** Alcanza para reconstruir el estado: la cola de un proyecto es corta. */
const MAX_TRABAJOS = 30

/* ── Lista ─────────────────────────────────────────────────────────────── */

export async function cargarHallazgos(
  projectId: string,
  estadoDemo?: string,
): Promise<Resultado> {
  if (MODO_DEMO) return demo(estadoDemo)

  const supabase = await createClient()

  const { data: proyecto, error: errorProyecto } = await supabase
    .from(T.projects)
    .select('id, name, deleted_at')
    .eq('id', projectId)
    .maybeSingle()

  if (errorProyecto) return { ok: false, motivo: 'error', detalle: errorProyecto.message }
  // Las reglas de acceso ya filtran por organización: si no vino, o no existe
  // o no es de este usuario. No podemos distinguir, y está bien que así sea.
  if (!proyecto || proyecto.deleted_at) return { ok: false, motivo: 'sin-permisos' }

  const [{ data: runRow, error: errorRun }, { data: jobRows, error: errorJobs }] = await Promise.all([
    supabase
      .from(T.analysisRuns)
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from(T.jobs)
      .select('id, kind, status, last_error, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(MAX_TRABAJOS),
  ])

  if (errorRun) return { ok: false, motivo: 'error', detalle: errorRun.message }
  if (errorJobs) return { ok: false, motivo: 'error', detalle: errorJobs.message }

  const trabajos = (jobRows ?? []).map(aJob)

  const run = runRow ? aRun(runRow) : null
  if (!run) {
    return {
      ok: true,
      datos: {
        proyecto: { id: proyecto.id, nombre: proyecto.name },
        run: null,
        findings: [],
        videos: {},
        trabajos,
      },
    }
  }

  const { data: filas, error: errorFindings } = await supabase
    .from(T.findings)
    .select('*')
    .eq('analysis_run_id', run.id)
    .order('rank', { ascending: true })

  if (errorFindings) return { ok: false, motivo: 'error', detalle: errorFindings.message }

  const findings = (filas ?? []).map(aFinding)

  return {
    ok: true,
    datos: {
      proyecto: { id: proyecto.id, nombre: proyecto.name },
      run,
      findings,
      videos: await cargarVideos(supabase, findings),
      trabajos,
    },
  }
}

/* ── Cobertura: todo lo que se revisó, no solo lo que se encontró ────────── */

export type ResultadoCobertura =
  | { ok: true; proyecto: { id: string; nombre: string }; coverage: RunCoverage | null }
  | { ok: false; motivo: 'sin-permisos' | 'error'; detalle?: string }

export async function cargarCobertura(projectId: string): Promise<ResultadoCobertura> {
  if (MODO_DEMO) {
    return {
      ok: true,
      proyecto: { id: PROYECTO_DEMO.id, nombre: PROYECTO_DEMO.nombre },
      coverage: null,
    }
  }

  const supabase = await createClient()

  const { data: proyecto, error: errorProyecto } = await supabase
    .from(T.projects)
    .select('id, name, deleted_at')
    .eq('id', projectId)
    .maybeSingle()

  if (errorProyecto) return { ok: false, motivo: 'error', detalle: errorProyecto.message }
  if (!proyecto || proyecto.deleted_at) return { ok: false, motivo: 'sin-permisos' }

  const { data: runRow, error: errorRun } = await supabase
    .from(T.analysisRuns)
    .select('coverage')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (errorRun) return { ok: false, motivo: 'error', detalle: errorRun.message }

  return {
    ok: true,
    proyecto: { id: proyecto.id, nombre: proyecto.name },
    coverage: (runRow as { coverage: RunCoverage | null } | null)?.coverage ?? null,
  }
}

/* ── Un hallazgo ───────────────────────────────────────────────────────── */

export type ResultadoHallazgo =
  | { ok: true; proyecto: { id: string; nombre: string }; finding: Finding; video: FindingVideo | null }
  | { ok: false; motivo: 'sin-permisos' | 'no-existe' | 'error'; detalle?: string }

export async function cargarHallazgo(
  projectId: string,
  findingId: string,
): Promise<ResultadoHallazgo> {
  if (MODO_DEMO) {
    const finding = HALLAZGOS_DEMO.find((f) => f.id === findingId)
    if (!finding) return { ok: false, motivo: 'no-existe' }
    return {
      ok: true,
      proyecto: { id: PROYECTO_DEMO.id, nombre: PROYECTO_DEMO.nombre },
      finding,
      video: VIDEOS_DEMO[finding.id] ?? null,
    }
  }

  const supabase = await createClient()

  const { data: proyecto } = await supabase
    .from(T.projects)
    .select('id, name, deleted_at')
    .eq('id', projectId)
    .maybeSingle()

  if (!proyecto || proyecto.deleted_at) return { ok: false, motivo: 'sin-permisos' }

  const { data: fila, error } = await supabase
    .from(T.findings)
    .select('*')
    .eq('id', findingId)
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) return { ok: false, motivo: 'error', detalle: error.message }
  if (!fila) return { ok: false, motivo: 'no-existe' }

  const finding = aFinding(fila)

  let video: FindingVideo | null = null
  if (finding.videoId) {
    const { data: videoRow } = await supabase
      .from(T.videos)
      .select('*')
      .eq('id', finding.videoId)
      .maybeSingle()
    video = videoRow ? aVideo(videoRow) : null
  }

  return { ok: true, proyecto: { id: proyecto.id, nombre: proyecto.name }, finding, video }
}

/* ── Auxiliares ────────────────────────────────────────────────────────── */

type Supabase = Awaited<ReturnType<typeof createClient>>

/** Solo los videos de los destacados: son los únicos que se ven en la lista. */
async function cargarVideos(
  supabase: Supabase,
  findings: Finding[],
): Promise<Record<string, FindingVideo>> {
  const ids = findings
    .filter((f) => f.rank >= 1 && f.rank <= 3 && f.videoId)
    .map((f) => f.videoId as string)

  if (ids.length === 0) return {}

  const { data } = await supabase.from(T.videos).select('*').in('id', ids)
  if (!data) return {}

  const porId = new Map(data.map((row) => [row.id, aVideo(row)]))
  const salida: Record<string, FindingVideo> = {}
  for (const f of findings) {
    const video = f.videoId ? porId.get(f.videoId) : undefined
    if (video) salida[f.id] = video
  }
  return salida
}

function demo(estadoCrudo?: string): Resultado {
  const estado: EstadoDemo = esEstadoDemo(estadoCrudo) ? estadoCrudo : 'listo'

  if (estado === 'sin-permisos') return { ok: false, motivo: 'sin-permisos' }
  if (estado === 'error') return { ok: false, motivo: 'error', detalle: 'Demostración del estado de error.' }

  const { findings, run, trabajos } = datosDemo(estado)

  return {
    ok: true,
    datos: {
      proyecto: { id: PROYECTO_DEMO.id, nombre: PROYECTO_DEMO.nombre },
      run: estado === 'job-fallado' ? { ...CORRIDA_TERMINADA, status: 'failed' } : run,
      findings,
      videos: VIDEOS_DEMO,
      trabajos,
    },
  }
}
