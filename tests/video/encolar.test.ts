/**
 * Qué se lleva un video y qué no.
 *
 * Es una regla de producto, no una optimización: **como mucho tres**. El 67% de
 * las alertas de seguridad se ignora por saturación, y un reporte largo muere en
 * una planilla. Y **solo lo demostrable**: un video es una prueba: si no hay una
 * línea de código ni una grabación, no hay nada que mostrar y el clip sería una
 * afirmación con locución encima.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import { T } from '@/lib/db/tablas'
import type { Evidence } from '@/lib/types/domain'
import { rutaDelCodigo } from '@/server/ingest'
import type { asegurarCodigoEnDisco } from '@/server/ingest/rehidratar'
import { JobError } from '@/server/jobs/errors'
import {
  crearHandlerRunChecks,
  encolarVideos,
  MAX_VIDEOS_POR_CORRIDA,
} from '@/server/checks/handlers'
import type { EnqueueInput } from '@/server/jobs'

import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'
import type { Fila } from '../fixtures/checks/db-falsa'
import { codigoYaEnDisco } from '../fixtures/codigo'

/* ── Andamiaje ────────────────────────────────────────────────────────── */

const CODIGO: Evidence[] = [{ kind: 'code', file: 'src/app/panel/page.tsx', line: 42 }]
const GRABACION: Evidence[] = [
  { kind: 'recording', agentSessionId: 'signup', startMs: 3_000, endMs: 28_000, caption: 'Entramos al panel' },
]
/** Real, pero no hay nada que poner en pantalla. */
const SOLO_TEXTO: Evidence[] = [{ kind: 'database', object: 'pedidos', detail: 'sin reglas de acceso' }]

function hallazgo(id: string, rank: number, evidence: Evidence[]): Fila {
  return { id, analysis_run_id: 'corrida-1', project_id: 'proyecto-1', rank, evidence, video_id: null }
}

function espia(): { encolar: (input: EnqueueInput) => Promise<string>; pedidos: EnqueueInput[] } {
  const pedidos: EnqueueInput[] = []
  return {
    pedidos,
    encolar: async (input) => {
      pedidos.push(input)
      return `trabajo-${pedidos.length}`
    },
  }
}

function baseCon(findings: Fila[], videos: Fila[] = []): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.findings, findings)
  db.sembrar(T.videos, videos)
  return db
}

/** La carpeta de trabajo del video sale de los ids, no de lo que traiga el payload. */
const WORKSPACE = rutaDelCodigo('proyecto-1', 'corrida-1')

/* ── 1. El tope de tres ───────────────────────────────────────────────── */

describe('nunca más de tres videos por corrida', () => {
  it('con cinco destacados manda tres, y son los de mejor posición', async () => {
    const db = baseCon([
      hallazgo('h-5', 5, CODIGO),
      hallazgo('h-2', 2, CODIGO),
      hallazgo('h-4', 4, CODIGO),
      hallazgo('h-1', 1, CODIGO),
      hallazgo('h-3', 3, CODIGO),
    ])
    const { encolar, pedidos } = espia()

    const resumen = await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(resumen.encolados).toBe(MAX_VIDEOS_POR_CORRIDA)
    expect(pedidos.map((p) => (p.payload as { findingId: string }).findingId)).toEqual([
      'h-1',
      'h-2',
      'h-3',
    ])
  })

  it('con menos de tres manda los que hay', async () => {
    const db = baseCon([hallazgo('h-1', 1, CODIGO), hallazgo('h-2', 2, GRABACION)])
    const { encolar, pedidos } = espia()

    await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(pedidos).toHaveLength(2)
  })

  it('sin hallazgos no encola nada', async () => {
    const { encolar, pedidos } = espia()
    await encolarVideos(baseCon([]), contextoDeTrabajo(), { encolar })
    expect(pedidos).toHaveLength(0)
  })
})

/* ── 2. Solo lo que se puede mostrar ──────────────────────────────────── */

describe('un hallazgo sin nada que mostrar no genera video', () => {
  it('saltea el que no tiene ni código ni grabación', async () => {
    const db = baseCon([
      hallazgo('con-codigo', 1, CODIGO),
      hallazgo('solo-texto', 2, SOLO_TEXTO),
      hallazgo('con-grabacion', 3, GRABACION),
    ])
    const { encolar, pedidos } = espia()
    const ctx = contextoDeTrabajo()

    await encolarVideos(db, ctx, { encolar })

    expect(pedidos.map((p) => (p.payload as { findingId: string }).findingId)).toEqual([
      'con-codigo',
      'con-grabacion',
    ])
    expect(ctx.registro.join('\n')).toMatch(/no tienen ni una línea de código ni una grabación/)
  })

  it('un hallazgo sin evidencia ninguna tampoco pasa', async () => {
    const db = baseCon([hallazgo('vacio', 1, []), hallazgo('bueno', 2, CODIGO)])
    const { encolar, pedidos } = espia()

    await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(pedidos).toHaveLength(1)
    expect((pedidos[0].payload as { findingId: string }).findingId).toBe('bueno')
  })

  it('los que no están destacados no se llevan video aunque tengan pruebas', async () => {
    const db = baseCon([hallazgo('h-1', 1, CODIGO), hallazgo('h-7', 7, CODIGO)])
    const { encolar, pedidos } = espia()

    await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(pedidos).toHaveLength(1)
    expect((pedidos[0].payload as { findingId: string }).findingId).toBe('h-1')
  })
})

/* ── 3. No se paga dos veces ──────────────────────────────────────────── */

describe('no se vuelve a pagar un video que ya está hecho', () => {
  it('saltea el hallazgo que ya tiene un video listo', async () => {
    const db = baseCon(
      [hallazgo('ya-listo', 1, CODIGO), hallazgo('pendiente', 2, CODIGO)],
      [{ id: 'video-1', finding_id: 'ya-listo', kind: 'finding', status: 'ready' }],
    )
    const { encolar, pedidos } = espia()

    await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(pedidos).toHaveLength(1)
    expect((pedidos[0].payload as { findingId: string }).findingId).toBe('pendiente')
  })

  it('uno que quedó a medias sí se rehace', async () => {
    const db = baseCon(
      [hallazgo('a-medias', 1, CODIGO)],
      [{ id: 'video-1', finding_id: 'a-medias', kind: 'finding', status: 'failed' }],
    )
    const { encolar, pedidos } = espia()

    await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(pedidos).toHaveLength(1)
  })
})

/* ── 4. Lo que viaja en el pedido ─────────────────────────────────────── */

describe('el pedido llega con lo que el otro handler necesita', () => {
  it('trae organización, proyecto, corrida y de qué hallazgo es', async () => {
    const db = baseCon([hallazgo('h-1', 1, CODIGO)])
    const { encolar, pedidos } = espia()

    await encolarVideos(db, contextoDeTrabajo(), { encolar })

    expect(pedidos[0]).toMatchObject({
      orgId: 'org-1',
      projectId: 'proyecto-1',
      analysisRunId: 'corrida-1',
      kind: 'generate_video',
      payload: { findingId: 'h-1', workspaceDir: WORKSPACE, kind: 'finding' },
    })
  })

  it('si la cola rechaza un pedido, los otros salen igual', async () => {
    const db = baseCon([hallazgo('h-1', 1, CODIGO), hallazgo('h-2', 2, CODIGO)])
    const pedidos: EnqueueInput[] = []
    const ctx = contextoDeTrabajo()

    await encolarVideos(db, ctx, {
      encolar: async (input: EnqueueInput) => {
        if ((input.payload as { findingId: string }).findingId === 'h-1') {
          throw new Error('la cola estaba caída')
        }
        pedidos.push(input)
        return 'trabajo-2'
      },
    })

    expect(pedidos).toHaveLength(1)
    expect(ctx.registro.join('\n')).toMatch(/No se pudo pedir el video/)
  })
})

/* ── 5. Está enganchado de verdad al final de la revisión ─────────────── */

describe('la revisión termina pidiendo los videos', () => {
  it('corre como última etapa de run_checks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-encolar-'))
    try {
      const db = new DbFalsa()
      db.sembrar(T.codeIndex, [
        {
          analysis_run_id: 'corrida-1',
          symbol_graph: { symbols: [], edges: [] },
          routes: [],
          ranked_files: [],
          db_schema: { source: 'none', tables: [], buckets: [], functions: [] },
          stats: { fileCount: 3, totalBytes: 900, languages: {}, truncated: false, notes: [] },
        },
      ])
      db.sembrar(T.projects, [{ id: 'proyecto-1', stack_detected: { framework: 'nextjs' } }])
      db.sembrar(T.agentSessions, [])
      db.sembrar(T.videos, [])
      // Ya revisados en una corrida anterior: acá interesa el encolado, no el motor.
      db.sembrar(T.findings, [hallazgo('h-1', 1, CODIGO), hallazgo('h-2', 2, GRABACION)])

      const { encolar, pedidos } = espia()
      const ctx = contextoDeTrabajo()
      const handler = crearHandlerRunChecks({
        db: async () => db,
        store: almacenEnMemoria().store,
        checks: [],
        encolar,
        // La carpeta está vacía a propósito: acá interesa el encolado, no el
        // código. Sin el doble, el handler saldría a buscar la copia guardada.
        asegurar: codigoYaEnDisco(),
      })

      await handler({ repoPath: dir }, ctx)

      expect(pedidos.map((p) => p.kind)).toEqual(['generate_video', 'generate_video'])
      expect(ctx.etapas.map((e) => e.stage)).toContain('Preparando los videos de lo más importante')

      // Agregar una etapa al final no puede hacer que el cierre retroceda: la
      // que antes terminaba en 100 ahora cierra en 95 y la nueva llega a 100.
      //
      // Ojo: no se puede exigir que la serie entera sea creciente. `runStages`
      // late `(indice / total) * 100` al *arrancar* cada etapa, así que con
      // etapas de progreso declarado el número baja al cambiar de etapa. Eso
      // pasa desde antes de esta etapa nueva y vive en `src/server/jobs`.
      const avances = ctx.etapas.map((e) => e.progress).filter((p): p is number => typeof p === 'number')
      expect(avances.at(-1)).toBe(100)
      expect(avances.indexOf(95), 'la etapa anterior ya no cierra en 95').toBeGreaterThan(-1)
      expect(avances.lastIndexOf(100)).toBeGreaterThan(avances.indexOf(95))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * Regresión. Esta etapa llamaba a `conCodigoEnDisco` para calcular una ruta —no
   * lee ni un archivo—, así que bajaba y descomprimía el repo entero para nada. Y
   * si entre una etapa y la otra se perdía el disco y la copia de Storage no
   * estaba, tiraba `sin_copia_guardada` sin reintento **con los hallazgos ya
   * guardados y las tres etapas anteriores hechas**: la corrida terminaba en
   * `partial` con mensaje de error cuando la revisión había salido entera.
   *
   * El doble de acá falla a partir de la segunda llamada, que es exactamente el
   * caso "el disco se evaporó entre etapas".
   */
  it('no vuelve a pedir el código: si el disco se perdió, la revisión no se cae', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-encolar-'))
    try {
      const db = new DbFalsa()
      db.sembrar(T.codeIndex, [
        {
          analysis_run_id: 'corrida-1',
          symbol_graph: { symbols: [], edges: [] },
          routes: [],
          ranked_files: [],
          db_schema: { source: 'none', tables: [], buckets: [], functions: [] },
          stats: { fileCount: 3, totalBytes: 900, languages: {}, truncated: false, notes: [] },
        },
      ])
      db.sembrar(T.projects, [{ id: 'proyecto-1', stack_detected: { framework: 'nextjs' } }])
      db.sembrar(T.agentSessions, [])
      db.sembrar(T.videos, [])
      db.sembrar(T.findings, [hallazgo('h-1', 1, CODIGO)])

      let llamadas = 0
      const asegurar: typeof asegurarCodigoEnDisco = async ({ repoPath }) => {
        llamadas += 1
        if (llamadas > 1) {
          throw new JobError(
            'Perdimos la copia de tu código. Volvé a lanzar la revisión y lo traemos de nuevo.',
            { retryable: false, code: 'sin_copia_guardada' },
          )
        }
        return { codeDir: repoPath, rehidratado: false, ingesta: null }
      }

      const { encolar, pedidos } = espia()
      const handler = crearHandlerRunChecks({
        db: async () => db,
        store: almacenEnMemoria().store,
        checks: [],
        encolar,
        asegurar,
      })

      await handler({ repoPath: dir }, contextoDeTrabajo())

      expect(llamadas, 'la etapa de videos volvió a pedir el código').toBe(1)
      expect(pedidos.map((p) => p.kind)).toEqual(['generate_video'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
