/**
 * Recorrido y lectura del código ya descargado.
 *
 * Un solo paseo por el árbol por corrida, cacheado por contexto: hay treinta y
 * pico de chequeos y todos miran los mismos archivos. Las reglas de qué entra y
 * qué se descarta salen de `@/server/ingest/filters`, que es de otro frente, y
 * es a propósito: si la ingesta ignora `node_modules`, los chequeos también.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { classifyPath, isIgnoredDirName, INGEST_LIMITS } from '@/server/ingest/filters'
import type { CheckRunContext } from './context'

export interface ArchivoFuente {
  /** Ruta relativa a la raíz del proyecto, con `/` siempre. */
  path: string
  text: string
}

const cache = new WeakMap<object, Promise<ArchivoFuente[]>>()

/** Todos los archivos de texto del proyecto. Se calcula una vez por corrida. */
export function archivos(ctx: CheckRunContext): Promise<ArchivoFuente[]> {
  const existente = cache.get(ctx)
  if (existente) return existente
  const promesa = recorrer(ctx)
  cache.set(ctx, promesa)
  return promesa
}

async function recorrer(ctx: CheckRunContext): Promise<ArchivoFuente[]> {
  const encontrados: ArchivoFuente[] = []
  const raiz = ctx.repoPath

  async function bajar(dir: string, relativo: string, profundidad: number): Promise<void> {
    if (profundidad > INGEST_LIMITS.maxPathDepth) return
    if (encontrados.length >= INGEST_LIMITS.maxFiles) return

    let entradas
    try {
      entradas = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entrada of entradas) {
      if (encontrados.length >= INGEST_LIMITS.maxFiles) return
      const rel = relativo ? `${relativo}/${entrada.name}` : entrada.name

      if (entrada.isSymbolicLink()) continue
      if (entrada.isDirectory()) {
        if (isIgnoredDirName(entrada.name)) continue
        await bajar(path.join(dir, entrada.name), rel, profundidad + 1)
        continue
      }
      if (!entrada.isFile()) continue

      let bytes = 0
      try {
        bytes = (await stat(path.join(dir, entrada.name))).size
      } catch {
        continue
      }
      if (classifyPath(rel, bytes).ignore) continue

      try {
        const text = await readFile(path.join(dir, entrada.name), 'utf8')
        encontrados.push({ path: rel, text })
      } catch {
        /* archivo ilegible: no es evidencia de nada */
      }
    }
  }

  await bajar(raiz, '', 0)
  encontrados.sort((a, b) => a.path.localeCompare(b.path))
  return encontrados
}

/* ── Filtros habituales ───────────────────────────────────────────────── */

const EXT_CODIGO = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro'])

export function extension(rutaArchivo: string): string {
  const base = rutaArchivo.slice(rutaArchivo.lastIndexOf('/') + 1)
  const punto = base.lastIndexOf('.')
  return punto <= 0 ? '' : base.slice(punto + 1).toLowerCase()
}

export function esCodigo(rutaArchivo: string): boolean {
  return EXT_CODIGO.has(extension(rutaArchivo))
}

export function esMarcado(rutaArchivo: string): boolean {
  const ext = extension(rutaArchivo)
  return ext === 'html' || ext === 'htm'
}

/** Archivos de test, historias y ejemplos: lo que encuentren no le importa al usuario. */
export function esDePrueba(rutaArchivo: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|playwright|fixtures?|mocks?|examples?|stories)\//i.test(
      rutaArchivo,
    ) || /\.(test|spec|stories|cy|e2e)\.[jt]sx?$/i.test(rutaArchivo)
  )
}

/* ── Posiciones ───────────────────────────────────────────────────────── */

/** Número de línea (base 1) de una posición dentro del texto. */
export function lineaEn(texto: string, indice: number): number {
  let linea = 1
  for (let i = 0; i < indice && i < texto.length; i++) {
    if (texto.charCodeAt(i) === 10) linea++
  }
  return linea
}

export function textoDeLinea(texto: string, linea: number): string {
  return texto.split('\n')[linea - 1] ?? ''
}

/**
 * Recorre las coincidencias de una expresión regular devolviendo ya la línea.
 * Evita que cada chequeo repita el mismo `matchAll` + conteo de saltos.
 */
export function* coincidencias(
  texto: string,
  re: RegExp,
): Generator<{ match: RegExpMatchArray; index: number; linea: number; lineaTexto: string }> {
  const global = re.global ? re : new RegExp(re.source, `${re.flags}g`)
  const lineas = texto.split('\n')
  // Índice de inicio de cada línea, para no recontar saltos en cada coincidencia.
  const inicios: number[] = new Array(lineas.length)
  let acumulado = 0
  for (let i = 0; i < lineas.length; i++) {
    inicios[i] = acumulado
    acumulado += lineas[i]!.length + 1
  }

  for (const match of texto.matchAll(global)) {
    const index = match.index ?? 0
    let bajo = 0
    let alto = inicios.length - 1
    while (bajo < alto) {
      const medio = Math.ceil((bajo + alto) / 2)
      if (inicios[medio]! <= index) bajo = medio
      else alto = medio - 1
    }
    yield { match, index, linea: bajo + 1, lineaTexto: lineas[bajo] ?? '' }
  }
}

/* ── Alcance: ¿esto llega al navegador? ───────────────────────────────── */

const DIRECTIVA_CLIENTE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]/

/**
 * `true` si el archivo se empaqueta y viaja al navegador del visitante.
 *
 * Es deliberadamente conservador: solo dice que sí cuando hay señal concreta
 * (`'use client'`, HTML, CSS, o una ruta que el índice ya marcó como cliente).
 * Un falso positivo acá convierte un archivo de servidor en un hallazgo crítico
 * inventado, que es exactamente lo que D14 prohíbe.
 */
export function llegaAlNavegador(
  archivo: ArchivoFuente,
  ctx?: Pick<CheckRunContext, 'index'>,
): boolean {
  const ext = extension(archivo.path)
  if (ext === 'html' || ext === 'htm' || ext === 'css' || ext === 'scss') return true
  if (DIRECTIVA_CLIENTE.test(archivo.text)) return true

  const ruta = ctx?.index.routes.find((r) => r.file === archivo.path)
  if (ruta?.isClient) return true

  // Convención de Next.js con Pages Router: todo `pages/` salvo `pages/api/`.
  if (/(^|\/)pages\//.test(archivo.path) && !/(^|\/)pages\/api\//.test(archivo.path)) return true
  // Vite / CRA / Flutter web: no hay frontera servidor-cliente, todo se publica.
  if (/(^|\/)src\/(components|pages|views|screens)\//.test(archivo.path)) return true

  return false
}

/** `true` si el archivo corre solo en el servidor (route handler, server action…). */
export function esSoloServidor(archivo: ArchivoFuente): boolean {
  if (/^\s*['"]use server['"]/.test(archivo.text)) return true
  if (/(^|\/)(route|middleware|proxy)\.[jt]sx?$/.test(archivo.path)) return true
  if (/(^|\/)(app|src\/app)\/api\//.test(archivo.path)) return true
  if (/(^|\/)pages\/api\//.test(archivo.path)) return true
  if (/(^|\/)server\//.test(archivo.path)) return true
  return false
}
