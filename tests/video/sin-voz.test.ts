/**
 * El clip tiene que salir aunque no haya voz.
 *
 * Hoy `TTS_PROVIDER=azure` y las claves están vacías. Eso no puede significar
 * "no hay video": significa "hay video sin narración, con los subtítulos
 * puestos, y el sistema dice por qué". Un job caído deja al usuario sin nada;
 * un archivo mudo sin explicación lo deja pensando que el producto está roto.
 *
 * Estos tests producen un **MP4 de verdad** con ffmpeg. El motor de imagen se
 * reemplaza por uno que dibuja un color (así no hay que levantar Chromium),
 * pero el armado de la voz, el cierre de tiempos, la mezcla y los subtítulos
 * son los de producción.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

import { generateVideo } from '@/server/video'
import { correrFfmpeg, inspeccionar } from '@/server/video/ffmpeg'
import { ALTO, ANCHO, FPS } from '@/server/video/renderer'
import type { VideoRenderer } from '@/server/video/renderer'
import type { TtsProvider } from '@/server/video/tts/types'
import { TtsError } from '@/server/video/tts/types'

import { hallazgoDeEjemplo } from './fixtures'

/* ── Un motor de imagen barato pero real ──────────────────────────────── */

/**
 * Dibuja un color plano durante lo que dura el guion. No es el video que ve el
 * usuario —eso lo hace `render/web.ts` con Playwright— pero es un archivo de
 * video legítimo, que es lo que necesita la mezcla para ser una prueba honesta.
 */
function rendererDeColor(): VideoRenderer {
  return {
    id: 'color-de-prueba',
    async render(entrada) {
      const arranque = Date.now()
      const videoPath = path.join(entrada.workDir, 'mudo.mp4')
      const segundos = Math.max(1, entrada.script.totalDurationMs / 1000)

      await correrFfmpeg([
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x1b1d23:s=${ANCHO}x${ALTO}:r=${FPS}:d=${segundos.toFixed(3)}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        videoPath,
      ])

      return {
        videoPath,
        preRollMs: 0,
        timelineMs: entrada.script.totalDurationMs,
        computeMs: Date.now() - arranque,
        origenTokens: 'fallback',
      }
    },
  }
}

/** Entorno tal cual está hoy en `.env.local`: se pide Azure y no hay clave. */
const SIN_CLAVES: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  TTS_PROVIDER: 'azure',
  AZURE_SPEECH_KEY: '',
  AZURE_SPEECH_REGION: '',
  GOOGLE_TTS_API_KEY: '',
}

async function conCarpeta<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-sinvoz-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ── 1. Sin claves ────────────────────────────────────────────────────── */

describe('sin claves de voz, el video sale igual', () => {
  it('produce un MP4 reproducible, con subtítulos y con el motivo anotado', async () => {
    await conCarpeta(async (dir) => {
      const resultado = await generateVideo({
        finding: hallazgoDeEjemplo(),
        projectId: 'proyecto-1',
        sessions: [],
        workspaceDir: dir,
        renderer: rendererDeColor(),
        entorno: SIN_CLAVES,
      })

      // 1. El archivo existe y es un video de verdad.
      const info = await stat(resultado.videoPath)
      expect(info.size, 'el MP4 salió vacío').toBeGreaterThan(1_000)

      const medido = await inspeccionar(resultado.videoPath)
      expect(medido.tieneVideo, 'el archivo final no tiene imagen').toBe(true)
      expect(medido.durationMs).toBeGreaterThan(0)

      // 2. Se sabe que no hay voz, y se sabe por qué.
      expect(resultado.sinVoz).toBe(true)
      expect(resultado.motivoSinVoz).toBeTruthy()
      expect(resultado.motivoSinVoz).toMatch(/AZURE_SPEECH_KEY/)
      expect(resultado.avisos.join('\n')).toContain('sin voz')

      // 3. Los subtítulos, que son lo que reemplaza a la narración, están.
      const vtt = await readFile(resultado.vttPath, 'utf8')
      expect(vtt).toContain('WEBVTT')
      expect(vtt.split('-->').length - 1, 'el VTT no tiene ni un subtítulo').toBeGreaterThan(0)

      // El reproductor arma los subtítulos desde `script`, no desde el VTT.
      expect(resultado.script.scenes.length).toBeGreaterThan(0)
      for (const escena of resultado.script.scenes) {
        expect(escena.narration.trim().length).toBeGreaterThan(0)
      }
      expect(resultado.transcript.trim().length).toBeGreaterThan(0)
    })
  }, 120_000)
})

/* ── 2. El proveedor configurado se cae a mitad de camino ─────────────── */

describe('si el servicio de voz falla, el clip no se cae con él', () => {
  it('rehace la locución en silencio y deja dicho qué pasó', async () => {
    await conCarpeta(async (dir) => {
      let intentos = 0
      const proveedorRoto: TtsProvider = {
        id: 'azure',
        name: 'Azure Speech',
        ssmlDialect: 'azure',
        defaultVoice: 'es-AR-TomasNeural',
        async synthesize() {
          intentos += 1
          throw new TtsError('Azure Speech respondió 401. Clave vencida.', 'azure')
        },
      }

      const resultado = await generateVideo({
        finding: hallazgoDeEjemplo(),
        projectId: 'proyecto-1',
        sessions: [],
        workspaceDir: dir,
        renderer: rendererDeColor(),
        tts: proveedorRoto,
        entorno: SIN_CLAVES,
      })

      expect(intentos, 'ni siquiera intentó narrar').toBeGreaterThan(0)
      expect(resultado.sinVoz).toBe(true)
      expect(resultado.motivoSinVoz).toMatch(/Azure Speech/)
      expect(resultado.motivoSinVoz).toMatch(/401/)

      const medido = await inspeccionar(resultado.videoPath)
      expect(medido.tieneVideo).toBe(true)
      expect(resultado.script.scenes.length).toBeGreaterThan(0)
    })
  }, 120_000)

  it('el clip queda entero mudo, nunca mitad narrado y mitad no', async () => {
    await conCarpeta(async (dir) => {
      // Falla recién en la segunda frase: sin la vuelta atrás completa, el clip
      // saldría con la primera escena narrada y el resto en silencio.
      let llamadas = 0
      const seCaeAlSegundo: TtsProvider = {
        id: 'azure',
        name: 'Azure Speech',
        ssmlDialect: 'azure',
        defaultVoice: 'es-AR-TomasNeural',
        async synthesize(_ssml, opts) {
          llamadas += 1
          if (llamadas >= 2) throw new TtsError('Se acabó la cuota.', 'azure')
          const { silenceWav } = await import('@/server/video/tts/wav')
          const { mkdir, writeFile } = await import('node:fs/promises')
          await mkdir(opts.outDir, { recursive: true })
          const ruta = path.join(opts.outDir, `${opts.basename}.wav`)
          await writeFile(ruta, silenceWav(1_200))
          return {
            audioPath: ruta,
            durationMs: 1_200,
            costUsd: 0.01,
            provider: 'azure',
            voice: 'es-AR-TomasNeural',
            characters: 40,
            cached: false,
          }
        },
      }

      const resultado = await generateVideo({
        finding: hallazgoDeEjemplo(),
        projectId: 'proyecto-1',
        sessions: [],
        workspaceDir: dir,
        renderer: rendererDeColor(),
        tts: seCaeAlSegundo,
        entorno: SIN_CLAVES,
      })

      expect(resultado.sinVoz, 'quedó marcado como narrado').toBe(true)
      expect(resultado.motivoSinVoz).toMatch(/cuota/i)
      // Lo que se pagó de la tanda abortada no se cobra como narración buena.
      expect(resultado.desglose.vozUsd).toBe(0)
    })
  }, 120_000)
})
