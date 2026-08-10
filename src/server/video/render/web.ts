/**
 * Renderer `web`: graba con Playwright una página HTML animada.
 *
 * Lo usa: `src/server/video/index.ts` cuando `VIDEO_RENDERER=web` (el default).
 * El porqué de esta elección está documentado en `../renderer.ts` (cierre de D11).
 *
 * Cómo funciona, en orden:
 *   1. se copia la grabación del agente al directorio de trabajo, para que la
 *      página la referencie con una ruta relativa y no haya líos de permisos
 *      de `file://`;
 *   2. se escribe `escena.html` con los tokens de la app incrustados;
 *   3. se abre en Chromium con `recordVideo` y se espera a que la página avise
 *      que el video ya está posicionado;
 *   4. se dispara la línea de tiempo y se espera exactamente lo que dura;
 *   5. se cierra el contexto — Playwright recién ahí termina de escribir el
 *      `.webm` — y se devuelve la ruta.
 *
 * El único punto delicado es el arranque: Playwright empieza a grabar cuando se
 * crea la página, no cuando arranca la animación. Ese sobrante se mide y se
 * devuelve como `preRollMs` para que la mezcla lo recorte. Además la primera
 * escena abre con la placa quieta durante `ENTRADILLA_MS`, así que un error de
 * algunas decenas de milisegundos cae sobre un cuadro fijo y no se ve.
 */

import { copyFile, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { chromium, type Browser } from 'playwright'

import { cargarRecursos, construirPagina } from './page'
import {
  ALTO,
  ANCHO,
  RenderError,
  type RenderEntrada,
  type RenderSalida,
  type VideoRenderer,
} from '../renderer'

/** Argumentos que evitan las tres cosas que rompen un render headless. */
const ARGS_CHROMIUM = [
  // el <video> tiene que arrancar solo, sin gesto del usuario
  '--autoplay-policy=no-user-gesture-required',
  // la página es file:// y carga un video vecino
  '--allow-file-access-from-files',
  // sin esto el compositor puede tirar cuadros en máquinas sin GPU
  '--disable-gpu-vsync',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
]

export interface OpcionesWeb {
  /** Margen de gracia después de la línea de tiempo, para no cortar el final. */
  colaMs?: number
  /** Techo de espera para que la página quede lista. */
  esperaListoMs?: number
  raizProyecto?: string
}

export function crearRendererWeb(opciones: OpcionesWeb = {}): VideoRenderer {
  const colaMs = opciones.colaMs ?? 400
  const esperaListoMs = opciones.esperaListoMs ?? 60_000

  return {
    id: 'web',

    async render(entrada: RenderEntrada): Promise<RenderSalida> {
      const inicio = Date.now()
      const { workDir, script, ubicaciones, cues, contexto } = entrada
      const avisar = entrada.onProgress ?? (() => {})

      await mkdir(workDir, { recursive: true })
      const dirVideo = path.join(workDir, 'captura')
      await mkdir(dirVideo, { recursive: true })

      // 1. La grabación del agente, al lado de la página.
      avisar('preparando la escena', 5)
      const grabacionSrc = await traerGrabacion(script, workDir)

      // 2. La página.
      const recursos = await cargarRecursos(opciones.raizProyecto)
      const html = construirPagina({
        script,
        ubicaciones,
        cues,
        tono: contexto.tono,
        contexto: contexto.titulo,
        grabacionSrc,
        recursos,
      })
      const paginaPath = path.join(workDir, 'escena.html')
      await writeFile(paginaPath, html, 'utf8')

      // 3. Grabar.
      let navegador: Browser | null = null
      let preRollMs = 0
      try {
        navegador = await chromium.launch({ headless: true, args: ARGS_CHROMIUM })
        const contextoNav = await navegador.newContext({
          viewport: { width: ANCHO, height: ALTO },
          deviceScaleFactor: 1,
          colorScheme: 'light',
          reducedMotion: 'no-preference',
          recordVideo: { dir: dirVideo, size: { width: ANCHO, height: ALTO } },
        })

        // Desde acá Playwright graba: todo lo que tarde se cuenta como preRoll.
        const marcaCero = Date.now()
        const pagina = await contextoNav.newPage()

        const errores: string[] = []
        pagina.on('pageerror', (e) => errores.push(e.message))

        await pagina.goto(`file://${paginaPath}`, { waitUntil: 'load', timeout: 30_000 })
        await pagina.waitForFunction(() => (window as unknown as { __ccListo?: boolean }).__ccListo === true, null, {
          polling: 'raf',
          timeout: esperaListoMs,
        })

        if (errores.length > 0) {
          throw new RenderError(`La escena tiró errores de JavaScript: ${errores.join(' | ')}`, 'web')
        }

        preRollMs = Date.now() - marcaCero
        avisar('grabando', 20)

        await pagina.evaluate(() => (window as unknown as { __ccArrancar: () => void }).__ccArrancar())
        await pagina.waitForTimeout(script.totalDurationMs + colaMs)

        avisar('cerrando la grabación', 80)
        // El .webm se termina de escribir recién cuando cierra el contexto.
        await contextoNav.close()
      } catch (error) {
        if (error instanceof RenderError) throw error
        throw new RenderError(
          `No se pudo grabar la escena: ${error instanceof Error ? error.message : String(error)}`,
          'web',
          error,
        )
      } finally {
        await navegador?.close().catch(() => {})
      }

      // 4. Playwright le pone un nombre aleatorio: lo dejamos con uno estable.
      const archivos = (await readdir(dirVideo)).filter((f) => f.endsWith('.webm'))
      if (archivos.length === 0) {
        throw new RenderError('Playwright no dejó ningún archivo de video.', 'web')
      }
      const videoPath = path.join(workDir, 'escena.webm')
      await rename(path.join(dirVideo, archivos[0]), videoPath)

      avisar('escena grabada', 90)

      return {
        videoPath,
        preRollMs,
        timelineMs: script.totalDurationMs,
        computeMs: Date.now() - inicio,
        origenTokens: recursos.origenTokens,
      }
    },
  }
}

/**
 * Copia la grabación del agente al directorio de trabajo.
 * Se copia en vez de referenciarla en su lugar por dos motivos: Chromium es
 * quisquilloso con `file://` cruzando carpetas, y el render queda autocontenido
 * (se puede reproducir un render viejo abriendo el HTML a mano).
 */
async function traerGrabacion(
  script: RenderEntrada['script'],
  workDir: string,
): Promise<string | null> {
  const escena = script.scenes.find((s) => s.visual.type === 'recording')
  if (!escena || escena.visual.type !== 'recording') return null

  const origen = escena.visual.recordingPath
  if (!origen) return null

  const destino = path.join(workDir, `grabacion${path.extname(origen) || '.webm'}`)
  try {
    await copyFile(origen, destino)
  } catch (error) {
    throw new RenderError(
      `No se pudo leer la grabación del agente en ${origen}: ${error instanceof Error ? error.message : String(error)}`,
      'web',
      error,
    )
  }
  return path.basename(destino)
}
