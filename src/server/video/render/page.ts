/**
 * Arma la página que se graba.
 *
 * Lo usa: `render/web.ts`. Se separó del renderer para poder testear el HTML
 * sin levantar un navegador (`tests/video/page.test.ts`).
 *
 * Decisión de fondo: la escena es HTML con CSS, no una composición de un motor
 * de video. Eso permite que el rojo del clip sea literalmente
 * `--cc-expuesto-solid` de `src/styles/tokens.css` — el mismo token que pinta
 * la tarjeta del hallazgo en la app. No es una coincidencia de color: es el
 * mismo valor leído del mismo archivo.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Severity, VideoScene, VideoSceneVisual, VideoScript } from '@/lib/types/domain'

import type { Cue } from '../subtitles'
import type { UbicacionEscena } from '../timing'

/* ── Recursos de la plantilla ─────────────────────────────────────────── */

export interface RecursosPlantilla {
  tokensCss: string
  escenaCss: string
  escenaJs: string
  /** De dónde salieron los tokens. Se reporta para no adivinar después. */
  origenTokens: 'app' | 'fallback'
}

/**
 * Raíz del repo, deducida desde este archivo (src/server/video/render).
 *
 * Se usa `fileURLToPath` y no `new URL('.', import.meta.url)`: ese segundo
 * patrón lo lee el empaquetador de Next como si fuera un import de la carpeta
 * actual, no lo puede resolver, y voltea el build entero.
 */
export function raizProyecto(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
}

/**
 * Lee tokens, estilos y guion de la plantilla.
 *
 * Prioridad de los tokens: primero `src/styles/tokens.css` (la fuente de
 * verdad del frente de diseño), y si no está — caso típico de un worker o de
 * una función serverless donde `src/` no viajó — la copia de
 * `video/template/fallback-tokens.css`.
 */
export async function cargarRecursos(raiz = raizProyecto()): Promise<RecursosPlantilla> {
  const plantilla = path.join(raiz, 'video', 'template')

  let tokensCss: string
  let origenTokens: 'app' | 'fallback' = 'app'
  try {
    tokensCss = await readFile(path.join(raiz, 'src', 'styles', 'tokens.css'), 'utf8')
  } catch {
    tokensCss = await readFile(path.join(plantilla, 'fallback-tokens.css'), 'utf8')
    origenTokens = 'fallback'
  }

  const [escenaCss, escenaJs] = await Promise.all([
    readFile(path.join(plantilla, 'escena.css'), 'utf8'),
    readFile(path.join(plantilla, 'escena.js'), 'utf8'),
  ])

  return { tokensCss, escenaCss, escenaJs, origenTokens }
}

/* ── Utilidades ───────────────────────────────────────────────────────── */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function esc(texto: string): string {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

/**
 * Serializa datos para incrustar en un <script> sin poder cerrarlo desde adentro.
 *
 * U+2028 y U+2029 van escritos como secuencia de escape y no como caracteres
 * literales: literales, esbuild los lee como fin de linea dentro de la expresion
 * regular y el archivo entero deja de compilar. TypeScript los acepta sin chistar,
 * asi que el error solo aparece al ejecutar con tsx.
 */
export function jsonSeguro(valor: unknown): string {
  return JSON.stringify(valor)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export type Tono = 'alarm' | 'neutral' | 'ok' | 'revisar'

/** El tono del clip sale de la gravedad y de la confianza, no del gusto. */
export function tonoDeSeveridad(severity: Severity, confianzaBaja = false): Tono {
  if (confianzaBaja) return 'revisar'
  return severity === 'critical' || severity === 'high' ? 'alarm' : 'neutral'
}

function recortar(texto: string, max: number): string {
  const limpio = String(texto ?? '')
  return limpio.length <= max ? limpio : `${limpio.slice(0, max - 1)}…`
}

/* ── Escenas ──────────────────────────────────────────────────────────── */

function escenaDeclaracion(visual: Extract<VideoSceneVisual, { type: 'statement' }>, ojal: string): string {
  return `<div class="declaracion">
  <div class="declaracion__regla"></div>
  <div class="declaracion__cuerpo">
    <p class="declaracion__ojal">${esc(ojal)}</p>
    <h1 class="declaracion__titular">${esc(visual.headline)}</h1>
    ${visual.sub ? `<p class="declaracion__sub">${esc(visual.sub)}</p>` : ''}
  </div>
</div>`
}

function escenaGrabacion(rotulo: string): string {
  return `<div class="rotulo"><span class="rotulo__punto"></span><span class="rotulo__texto">${esc(
    recortar(rotulo, 86),
  )}</span></div>`
}

/** Cuántas líneas de código entran en el escenario sin apretar. */
const MAX_LINEAS_CODIGO = 11
const MAX_ANCHO_LINEA = 74

export function recorteDeCodigo(
  snippet: string,
  primeraLinea: number,
  marcadas: number[],
): Array<{ n: number; texto: string; marcada: boolean }> {
  const crudas = snippet.replace(/\t/g, '  ').split('\n')
  // Se saca la sangría común: en pantalla grande, 12 espacios a la izquierda
  // son 12 espacios de nada.
  const sangrias = crudas
    .filter((l) => l.trim().length > 0)
    .map((l) => l.length - l.trimStart().length)
  const comun = sangrias.length > 0 ? Math.min(...sangrias) : 0

  let lineas = crudas.map((texto, i) => ({
    n: primeraLinea + i,
    texto: recortar(texto.slice(comun), MAX_ANCHO_LINEA),
    marcada: marcadas.includes(primeraLinea + i),
  }))

  if (lineas.length > MAX_LINEAS_CODIGO) {
    const centro = Math.max(
      0,
      lineas.findIndex((l) => l.marcada),
    )
    const desde = Math.max(0, Math.min(centro - 4, lineas.length - MAX_LINEAS_CODIGO))
    lineas = lineas.slice(desde, desde + MAX_LINEAS_CODIGO)
  }
  return lineas
}

function escenaCodigo(visual: Extract<VideoSceneVisual, { type: 'code' }>): string {
  const marcadas = visual.highlight?.length ? visual.highlight : [visual.line]
  const lineas = recorteDeCodigo(visual.snippet || '', visual.line, marcadas)

  const filas = lineas
    .map(
      (l) =>
        `<div class="codigo__linea" data-marcada="${l.marcada ? '1' : '0'}"><span class="codigo__n">${
          l.n
        }</span><span class="codigo__txt">${esc(l.texto) || '&nbsp;'}</span></div>`,
    )
    .join('\n      ')

  const archivo = esc(recortar(visual.file, 70))
  return `<div class="codigo">
  <p class="codigo__ruta">Está acá: <b>${archivo}</b> <span class="codigo__chip">línea ${visual.line}</span></p>
  <div class="codigo__pozo">
      ${filas || '<div class="codigo__linea"><span class="codigo__n"></span><span class="codigo__txt">&nbsp;</span></div>'}
  </div>
</div>`
}

const FLECHA = `<defs><marker id="punta" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--tono)"/></marker></defs>`

function dibujoFugaEntreInquilinos(): string {
  return `<svg viewBox="0 0 760 300" role="img" aria-label="Una cuenta pudo leer los datos de otra">
  ${FLECHA}
  <rect class="dib-caja--tono dib-caja" x="34" y="96" width="256" height="112" rx="16"/>
  <text class="dib-texto dib-texto--tono" x="162" y="142">Una cuenta cualquiera</text>
  <text class="dib-texto dib-texto--chico" x="162" y="170">la que se crea en 30 segundos</text>

  <rect class="dib-caja" x="470" y="96" width="256" height="112" rx="16"/>
  <text class="dib-texto" x="598" y="142">Los datos privados</text>
  <text class="dib-texto dib-texto--chico" x="598" y="170">de otra persona</text>

  <path class="dib-fuga" d="M296,152 C356,108 404,108 462,152" marker-end="url(#punta)"/>
  <text class="dib-texto dib-texto--tono" x="380" y="96">los pudo leer</text>

  <path class="dib-punteada" d="M34,244 H726"/>
  <text class="dib-texto dib-texto--chico" x="380" y="272">las dos cosas viven en la misma base de datos</text>
</svg>`
}

function dibujoFlujoFaltante(): string {
  const pasos = ['Se registra', 'Entra', 'Usa la app', 'Se va']
  const cajas = pasos
    .map((paso, i) => {
      const x = 24 + i * 182
      const ultimo = i === pasos.length - 1
      return `<g>
    <rect class="${ultimo ? 'dib-caja' : 'dib-caja'}" x="${x}" y="106" width="152" height="88" rx="14"${
      ultimo ? ' stroke-dasharray="7 7" fill="none"' : ''
    }/>
    <text class="dib-texto${ultimo ? ' dib-texto--chico' : ''}" x="${x + 76}" y="152">${paso}</text>
  </g>`
    })
    .join('\n  ')

  const flechas = [0, 1, 2]
    .map((i) => {
      const x = 24 + i * 182 + 152
      return `<path class="${i === 2 ? 'dib-fuga' : 'dib-linea'}" d="M${x},150 H${x + 26}"${
        i === 2 ? ' marker-end="url(#punta)"' : ''
      }/>`
    })
    .join('\n  ')

  return `<svg viewBox="0 0 760 300" role="img" aria-label="Falta un paso del recorrido">
  ${FLECHA}
  ${cajas}
  ${flechas}
  <text class="dib-texto dib-texto--tono" x="662" y="228">esto no está</text>
</svg>`
}

function dibujoLlaveExpuesta(): string {
  return `<svg viewBox="0 0 760 300" role="img" aria-label="La llave de tu app queda a la vista">
  ${FLECHA}
  <rect class="dib-caja" x="34" y="70" width="330" height="176" rx="14"/>
  <path class="dib-linea" d="M34,104 H364"/>
  <circle cx="58" cy="87" r="5" fill="var(--cc-line-strong)"/>
  <circle cx="76" cy="87" r="5" fill="var(--cc-line-strong)"/>
  <circle cx="94" cy="87" r="5" fill="var(--cc-line-strong)"/>
  <text class="dib-texto dib-texto--chico" x="199" y="150">tu sitio, abierto en</text>
  <text class="dib-texto dib-texto--chico" x="199" y="176">cualquier navegador</text>

  <g transform="translate(430,124)">
    <circle class="dib-caja--tono dib-caja" cx="26" cy="26" r="24"/>
    <path class="dib-fuga" d="M50,26 H124 M104,26 V46 M124,26 V52" stroke-dasharray="200" />
  </g>

  <path class="dib-fuga" d="M372,158 H420" marker-end="url(#punta)"/>
  <text class="dib-texto dib-texto--tono" x="516" y="212">la llave queda a la vista</text>
</svg>`
}

function escenaEsquema(visual: Extract<VideoSceneVisual, { type: 'diagram' }>): string {
  const dibujo =
    visual.kind === 'missing-flow'
      ? dibujoFlujoFaltante()
      : visual.kind === 'exposed-key'
        ? dibujoLlaveExpuesta()
        : dibujoFugaEntreInquilinos()

  return `<div class="esquema">
  ${dibujo}
  ${visual.caption ? `<p class="esquema__pie">${esc(visual.caption)}</p>` : ''}
</div>`
}

/**
 * Etiqueta chiquita arriba del titular. Nunca puede repetir lo que dice el
 * titular: si el ojal dice "qué hacer" y abajo se lee "Qué hacer ahora", el
 * cuadro parece un error de armado.
 */
export function ojalDeEscena(escenaId: string): string {
  if (escenaId === 'accion') return 'tu próximo paso'
  return 'lo comprobamos'
}

function cuerpoDeEscena(escena: VideoScene): string {
  switch (escena.visual.type) {
    case 'statement':
      return escenaDeclaracion(escena.visual, ojalDeEscena(escena.id))
    case 'recording':
      return escenaGrabacion(escena.caption ?? '')
    case 'code':
      return escenaCodigo(escena.visual)
    case 'diagram':
      return escenaEsquema(escena.visual)
  }
}

/* ── Página ───────────────────────────────────────────────────────────── */

export interface DatosPagina {
  script: VideoScript
  ubicaciones: UbicacionEscena[]
  cues: Cue[]
  tono: Tono
  /** Título corto del hallazgo para la cinta superior. */
  contexto: string
  /** Nombre del archivo de grabación, relativo a la página. */
  grabacionSrc?: string | null
  recursos: RecursosPlantilla
}

export function construirPagina(datos: DatosPagina): string {
  const { script, ubicaciones, cues, tono, recursos } = datos

  const escenas = script.scenes
    .map((escena, i) => {
      const ubic = ubicaciones[i]
      return `<section class="escena" data-id="${esc(escena.id)}" data-tipo="${escena.visual.type}" data-activa="0" data-inicio="${
        ubic?.startMs ?? 0
      }">
${cuerpoDeEscena(escena)}
</section>`
    })
    .join('\n')

  const capa = datos.grabacionSrc
    ? `<div class="capaGrabacion" data-activa="0">
  <div class="encuadre">
    <div class="moviola"><video id="grabacion" src="${esc(datos.grabacionSrc)}" muted playsinline preload="auto"></video></div>
    <div class="marca" data-visible="0"></div>
  </div>
</div>`
    : ''

  const guion = {
    totalMs: script.totalDurationMs,
    escenas: script.scenes.map((escena, i) => ({
      id: escena.id,
      tipo: escena.visual.type,
      startMs: ubicaciones[i]?.startMs ?? 0,
      durationMs: ubicaciones[i]?.durationMs ?? escena.durationMs,
      recording:
        escena.visual.type === 'recording'
          ? {
              startMs: escena.visual.startMs,
              endMs: escena.visual.endMs,
              zoom: escena.visual.zoom ?? null,
            }
          : null,
    })),
    cues,
  }

  return `<!doctype html>
<html lang="es-AR" data-theme="light">
<head>
<meta charset="utf-8">
<title>${esc(script.title)}</title>
<style>${recursos.tokensCss}</style>
<style>${recursos.escenaCss}</style>
</head>
<body data-tono="${tono}">
<div class="marco">
  <header class="cinta">
    <span class="cinta__sello"></span>
    <span class="cinta__marca">caughtcode</span>
    <span class="cinta__titulo">${esc(recortar(datos.contexto, 96))}</span>
  </header>

  <main class="escenario">
${capa}
${escenas}
  </main>

  <footer class="estante"><p class="subtitulo" id="subtitulo" data-visible="0"></p></footer>
  <div class="progreso"><i id="progresoBarra"></i></div>
</div>
<script>window.__GUION__ = ${jsonSeguro(guion)};</script>
<script>${recursos.escenaJs}</script>
</body>
</html>`
}
