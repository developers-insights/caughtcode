/**
 * El handler de `generate_video`: de hallazgo a prueba en video.
 *
 * Lo que se prueba, en orden de importancia:
 *
 *  1. **Idempotencia.** Correrlo dos veces deja **un** video, no dos. Un
 *     hallazgo tiene una demostración; una pila de intentos sería basura que
 *     además le cobramos al usuario.
 *  2. **El estado de la fila sigue a la etapa del motor**, siempre por
 *     `ETAPA_A_ESTADO` y nunca por un valor escrito a mano (la columna tiene un
 *     check y cualquier otra cosa se rechaza).
 *  3. **Nada sin evidencia**: un hallazgo sin nada que mostrar no se convierte
 *     en un video con locución encima.
 *  4. Costo en unidades concretas, y ruta en Storage derivada de los ids.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import { T } from '@/lib/db/tablas'
import type { CostBreakdown, VideoScript } from '@/lib/types/domain'
import {
  crearHandlerGenerateVideo,
  rutaDeVideoEnStorage,
  TEXTO_DE_ETAPA,
} from '@/server/video/handlers'
import type { GenerateVideoPayload, SubirVideo } from '@/server/video/handlers'
import { ETAPA_A_ESTADO } from '@/server/video'
import type { EtapaVideo, GenerarVideoOpciones, ResultadoVideo } from '@/server/video'

import { almacenEnMemoria, contextoDeTrabajo, DbFalsa } from '../fixtures/checks/db-falsa'
import type { Fila } from '../fixtures/checks/db-falsa'
import { hallazgoDeEjemplo } from './fixtures'

/* ── Andamiaje ────────────────────────────────────────────────────────── */

const ETAPAS: EtapaVideo[] = ['guion', 'voz', 'render', 'mezcla']

function filaDeHallazgo(parciales: Fila = {}): Fila {
  const hallazgo = hallazgoDeEjemplo()
  return {
    id: 'hallazgo-1',
    analysis_run_id: 'corrida-1',
    project_id: 'proyecto-1',
    pillar: hallazgo.pillar,
    check_id: hallazgo.checkId,
    severity: hallazgo.severity,
    confidence: hallazgo.confidence,
    status: 'open',
    title_plain: hallazgo.titlePlain,
    explanation_plain: hallazgo.explanationPlain,
    impact_plain: hallazgo.impactPlain,
    fix_prompt: hallazgo.fixPrompt,
    evidence: hallazgo.evidence,
    rank: 1,
    video_id: null,
    created_at: hallazgo.createdAt,
    ...parciales,
  }
}

function baseConHallazgo(parciales: Fila = {}): DbFalsa {
  const db = new DbFalsa()
  db.sembrar(T.findings, [filaDeHallazgo(parciales)])
  db.sembrar(T.videos, [])
  db.sembrar(T.agentSessions, [])
  db.sembrar(T.codeIndex, [])
  return db
}

const GUION: VideoScript = {
  kind: 'finding',
  title: 'Cualquiera puede ver los pedidos de otros clientes',
  scenes: [
    { id: 'gancho', narration: 'Mirá lo que pasa cuando entra alguien de afuera.', durationMs: 8_000, visual: { type: 'statement', headline: 'Probemos', tone: 'alarm' } },
    { id: 'prueba', narration: 'Acá está la línea exacta que lo permite.', durationMs: 12_000, visual: { type: 'code', file: 'src/app/panel/page.tsx', line: 42, snippet: 'const supabase = createClient(' } },
  ],
  totalDurationMs: 20_000,
}

const COSTOS: CostBreakdown = {
  entries: [
    { category: 'llm', units: 1, unitLabel: 'guion', costUsd: 0.004, detail: 'claude-sonnet-5' },
    { category: 'tts', units: 612, unitLabel: 'caracteres narrados', costUsd: 0.0098, detail: 'azure' },
    { category: 'render', units: 1.4, unitLabel: 'minutos de máquina', costUsd: 0.0031, detail: 'web' },
  ],
  totalUsd: 0.0169,
}

interface MotorFalso {
  generar: (opciones: GenerarVideoOpciones) => Promise<ResultadoVideo>
  /** Estado que tenía la fila de `videos` justo después de cada etapa. */
  estadosVistos: Array<{ etapa: EtapaVideo; status: unknown }>
  llamadas: number
}

/**
 * Motor de mentira: no levanta Chromium ni ffmpeg, pero recorre las cuatro
 * etapas de verdad y escribe un archivo real, que es lo que el handler sube.
 */
function motorFalso(db: DbFalsa, dir: string, extra: Partial<ResultadoVideo> = {}): MotorFalso {
  const motor: MotorFalso = {
    estadosVistos: [],
    llamadas: 0,
    generar: async (opciones) => {
      motor.llamadas += 1
      const videoPath = path.join(dir, `${opciones.finding.id}.mp4`)
      await writeFile(videoPath, Buffer.from('mp4 de mentira'))

      for (const [i, etapa] of ETAPAS.entries()) {
        opciones.onProgress?.({
          etapa,
          status: ETAPA_A_ESTADO[etapa],
          porcentaje: Math.round(((i + 1) / ETAPAS.length) * 100),
        })
        // El handler publica el avance sin bloquear al motor; le damos el turno.
        await new Promise((listo) => setImmediate(listo))
        motor.estadosVistos.push({ etapa, status: db.filasDe(T.videos)[0]?.status })
      }

      return {
        findingId: opciones.finding.id,
        projectId: opciones.projectId,
        status: 'ready',
        url: videoPath,
        videoPath,
        vttPath: path.join(dir, 'subtitulos.vtt'),
        transcriptPath: path.join(dir, 'transcripcion.txt'),
        durationSeconds: 74.2,
        transcript: 'Mirá lo que pasa cuando entra alguien de afuera.',
        costUsd: COSTOS.totalUsd,
        renderer: 'web',
        script: GUION,
        cues: [],
        costBreakdown: COSTOS,
        desglose: {
          guionUsd: 0.004,
          vozUsd: 0.0098,
          renderUsd: 0.0031,
          totalUsd: COSTOS.totalUsd,
          caracteresNarrados: 612,
          computeMs: 84_000,
          videoMs: 74_200,
          calibracion: { minutosPorSegundoDeVideo: 0.019, vecesTiempoReal: 1.13, computeMs: 84_000, videoSegundos: 74.2 },
        },
        avisos: [],
        sinVoz: false,
        workDir: dir,
        ...extra,
      }
    },
  }
  return motor
}

function subidaFalsa(): { subir: SubirVideo; rutas: string[] } {
  const rutas: string[] = []
  return {
    rutas,
    subir: async ({ ruta }) => {
      rutas.push(ruta)
      return { url: `https://storage.test/${ruta}?firma=abc` }
    },
  }
}

async function conCarpeta<T2>(fn: (dir: string) => Promise<T2>): Promise<T2> {
  const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-video-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function videos(db: DbFalsa): Fila[] {
  return db.filasDe(T.videos)
}

/* ── 1. Idempotencia ──────────────────────────────────────────────────── */

describe('idempotencia: un hallazgo, un video', () => {
  it('dos trabajos distintos sobre el mismo hallazgo dejan una sola fila', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const motor = motorFalso(db, dir)
      const { subir } = subidaFalsa()
      const payload: GenerateVideoPayload = { findingId: 'hallazgo-1', workspaceDir: dir }

      // Un almacén por trabajo: el segundo no ve el avance del primero y rehace
      // todo. Es el caso que de verdad importa.
      const handler = () =>
        crearHandlerGenerateVideo({
          db: async () => db,
          store: almacenEnMemoria().store,
          generar: motor.generar,
          subir,
        })

      await handler()(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))
      expect(videos(db)).toHaveLength(1)
      const primerId = videos(db)[0].id

      await handler()(payload, contextoDeTrabajo({ jobId: 'trabajo-2' }))

      expect(videos(db)).toHaveLength(1)
      expect(videos(db)[0].id, 'la fila se reusó, no se recreó').toBe(primerId)
    })
  })

  it('el mismo trabajo reintentado no vuelve a producir el video', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const motor = motorFalso(db, dir)
      const { store } = almacenEnMemoria()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store,
        generar: motor.generar,
        subir: subidaFalsa().subir,
      })
      const payload: GenerateVideoPayload = { findingId: 'hallazgo-1', workspaceDir: dir }

      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))
      expect(motor.llamadas).toBe(1)

      // Mismo jobId y mismo almacén: las etapas hechas se saltean.
      await handler(payload, contextoDeTrabajo({ jobId: 'trabajo-1' }))

      expect(motor.llamadas, 'un reintento volvió a pagar el render').toBe(1)
      expect(videos(db)).toHaveLength(1)
    })
  })

  it('el hallazgo queda apuntando al video', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir: subidaFalsa().subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, contextoDeTrabajo())

      expect(db.filasDe(T.findings)[0].video_id).toBe(videos(db)[0].id)
    })
  })
})

/* ── 2. Etapa → estado ────────────────────────────────────────────────── */

describe('el estado de la fila sigue a la etapa del motor', () => {
  it('cada etapa deja en la base el estado que dice ETAPA_A_ESTADO', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const motor = motorFalso(db, dir)
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motor.generar,
        subir: subidaFalsa().subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, contextoDeTrabajo())

      expect(motor.estadosVistos).toHaveLength(ETAPAS.length)
      for (const visto of motor.estadosVistos) {
        expect(visto.status, `la etapa ${visto.etapa} dejó otro estado`).toBe(
          ETAPA_A_ESTADO[visto.etapa],
        )
      }
      expect(videos(db)[0].status, 'al terminar tiene que quedar listo').toBe('ready')
    })
  })

  it('late con el texto de cada etapa, y ese texto no tiene jerga', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const ctx = contextoDeTrabajo()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir: subidaFalsa().subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, ctx)

      const dichos = ctx.etapas.map((e) => e.stage).filter(Boolean) as string[]
      for (const etapa of ETAPAS) {
        expect(dichos, `nunca se avisó la etapa ${etapa}`).toContain(TEXTO_DE_ETAPA[etapa])
      }
    })
  })

  it('ningún texto de etapa usa palabras que el usuario no entiende', () => {
    const prohibidas = /\b(mux(ing)?|encod(e|ing)|render(ing|izando)?|codec|bitrate|ffmpeg|tts|chromium)\b/i
    for (const [etapa, texto] of Object.entries(TEXTO_DE_ETAPA)) {
      expect(texto, `"${texto}" (${etapa}) tiene jerga`).not.toMatch(prohibidas)
    }
  })

  it('el mapa de etapas cubre las cuatro y solo usa estados que la base acepta', () => {
    const permitidos = ['queued', 'rendering', 'ready', 'failed']
    for (const etapa of ETAPAS) {
      expect(TEXTO_DE_ETAPA[etapa], `falta el texto de ${etapa}`).toBeTruthy()
      expect(permitidos).toContain(ETAPA_A_ESTADO[etapa])
    }
  })
})

/* ── 3. Nada sin evidencia ────────────────────────────────────────────── */

describe('nada sin evidencia', () => {
  it('un hallazgo sin nada que mostrar no genera video, y lo dice claro', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo({ evidence: [] })
      const motor = motorFalso(db, dir)
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motor.generar,
        subir: subidaFalsa().subir,
      })

      await expect(
        handler({ findingId: 'hallazgo-1', workspaceDir: dir }, contextoDeTrabajo()),
      ).rejects.toThrow(/prueba que mostrar/i)

      expect(motor.llamadas, 'se puso a renderizar igual').toBe(0)
    })
  })

  it('si el hallazgo ya no existe, no se reintenta para siempre', async () => {
    await conCarpeta(async (dir) => {
      const db = new DbFalsa()
      db.sembrar(T.findings, [])
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir: subidaFalsa().subir,
      })

      await expect(
        handler({ findingId: 'fantasma', workspaceDir: dir }, contextoDeTrabajo()),
      ).rejects.toMatchObject({ retryable: false })
    })
  })
})

/* ── 4. Costo y archivo ───────────────────────────────────────────────── */

describe('costo y archivo', () => {
  it('reporta el costo en unidades concretas, nunca en créditos', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const ctx = contextoDeTrabajo()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir: subidaFalsa().subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, ctx)

      const etiquetas = ctx.costos.map((c) => c.unitLabel)
      expect(etiquetas).toContain('caracteres narrados')
      expect(etiquetas).toContain('minutos de máquina')
      expect(etiquetas).toContain('segundos de video')
      for (const etiqueta of etiquetas) {
        expect(etiqueta, 'apareció la palabra prohibida').not.toMatch(/crédito/i)
      }

      // Los segundos de video son un rótulo, no un cargo: sumarían dos veces.
      const total = ctx.costos.reduce((a, c) => a + c.costUsd, 0)
      expect(total).toBeCloseTo(COSTOS.totalUsd, 6)
    })
  })

  it('guarda el archivo en una ruta derivada de los ids, para que reintentar sobrescriba', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const { subir, rutas } = subidaFalsa()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, contextoDeTrabajo())

      const videoId = String(videos(db)[0].id)
      expect(rutas).toEqual([rutaDeVideoEnStorage('org-1', 'proyecto-1', videoId)])
      expect(videos(db)[0].url).toContain(videoId)
    })
  })

  it('guarda lo que el reproductor necesita: dirección, duración, guion y transcripción', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir: subidaFalsa().subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, contextoDeTrabajo())

      const fila = videos(db)[0]
      expect(fila.url).toBeTruthy()
      expect(fila.duration_s).toBe(74.2)
      expect(fila.transcript).toBeTruthy()
      // De acá salen los subtítulos del reproductor.
      expect((fila.script as VideoScript).scenes.length).toBeGreaterThan(0)
    })
  })

  it('si la subida falla, el video no queda "listo" apuntando a la nada', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir).generar,
        subir: async () => {
          throw new Error('el bucket dijo que no')
        },
      })

      await expect(
        handler({ findingId: 'hallazgo-1', workspaceDir: dir }, contextoDeTrabajo()),
      ).rejects.toThrow(/No se pudo guardar el video/)

      expect(videos(db)[0].status).toBe('failed')
      expect(videos(db)[0].url ?? null).toBeNull()
    })
  })
})

/* ── 5. Sin voz: el motivo queda registrado ───────────────────────────── */

describe('un clip sin narración nunca se entrega sin explicación', () => {
  it('deja escrito en la fila por qué no hay voz, y el video igual queda listo', async () => {
    await conCarpeta(async (dir) => {
      const db = baseConHallazgo()
      const ctx = contextoDeTrabajo()
      const motivo = 'Faltan AZURE_SPEECH_KEY o AZURE_SPEECH_REGION. El clip sale sin voz.'
      const handler = crearHandlerGenerateVideo({
        db: async () => db,
        store: almacenEnMemoria().store,
        generar: motorFalso(db, dir, {
          sinVoz: true,
          motivoSinVoz: motivo,
          avisos: [motivo],
        }).generar,
        subir: subidaFalsa().subir,
      })

      await handler({ findingId: 'hallazgo-1', workspaceDir: dir }, ctx)

      const fila = videos(db)[0]
      expect(fila.status, 'sin voz no es un fallo: el video se entrega igual').toBe('ready')
      expect(String(fila.error)).toContain('AZURE_SPEECH_KEY')
      expect(ctx.registro.join('\n')).toContain('sin voz')
    })
  })
})
