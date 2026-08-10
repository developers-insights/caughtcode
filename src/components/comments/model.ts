/**
 * Modelo de vista de la pantalla de comentarios.
 *
 * Acá vive la regla que ordena toda la pantalla:
 *
 *   el ALCANCE decide la posición y el peso · el RIESGO decide el color
 *
 * Es el mismo reparto que usa el resto del producto (`severity` → énfasis,
 * `tone` → color), y es lo que permite enseñar la diferencia entre "esto lo ve
 * cualquiera" y "esto se queda adentro" sin escribir una sola línea de teoría:
 * lo que se ve desde afuera va primero y ocupa más lugar, siempre. Que además
 * esté en rojo depende de si dice algo comprometedor, no de dónde está.
 *
 * Módulo puro: no importa nada del motor ni de Node, así que puede correr
 * también en el navegador. El texto que llega acá ya viene enmascarado por
 * `view-model.ts`, que es quien habla con el motor.
 */

import type { CommentHit, CommentReach, CommentRisk, CommentScanResult } from '@/lib/types/domain'
import { COMENTARIOS } from '@/content/copy'
import type { Tone } from '@/components/ui'

/* ── Fila ──────────────────────────────────────────────────────────────── */

export interface CommentRowModel {
  /** `archivo:línea`. Estable entre corridas, sirve de key. */
  id: string
  file: string
  line: number
  endLine: number
  /** Ya enmascarado. Nunca contiene el valor completo de una clave. */
  text: string
  reach: CommentReach
  risk: CommentRisk
  functional: boolean
  reason?: string
}

/* ── Grupo por alcance ─────────────────────────────────────────────────── */

export interface ReachGroup {
  reach: CommentReach
  /** Nombre del alcance, tal cual lo escribió producto. */
  titulo: string
  /** Quién lo puede leer, en una línea. */
  quienLoLee: string
  total: number
  riesgosos: number
  /** Claves y notas internas: lo que sí importa que alguien lea. */
  sensibles: number
  secretos: number
  archivos: number
  /** Los que importan, ya ordenados. Se muestran abiertos. */
  destacados: CommentRowModel[]
  /** Los que no aportan nada, disponibles pero plegados. */
  resto: CommentRowModel[]
  /** Cuántos ni siquiera se listan. Se dice el número, no se esconde. */
  ocultos: number
}

export interface FileSummary {
  file: string
  total: number
  removibles: number
  expuestos: number
  riesgosos: number
}

export interface CommentsViewModel {
  scannedFiles: number
  total: number
  exposedCount: number
  riskyCount: number
  removableCount: number
  /** Cuántos de los que se ven desde afuera parecen tener una clave. */
  exposedSecrets: number
  /** Cuántos de los que se ven desde afuera dicen algo que no debería leerse. */
  exposedSensitive: number
  /** Cuántos de los que se ven desde afuera tienen alguna marca, incluido el ruido. */
  exposedRisky: number
  grupos: ReachGroup[]
  funcionales: FuncionalesResumen
  archivos: FileSummary[]
}

export interface FuncionalesResumen {
  total: number
  /** Motivos agrupados: cada uno con cuántos comentarios lo tienen. */
  motivos: Array<{ reason: string; count: number }>
  ejemplos: CommentRowModel[]
}

/* ── Orden ─────────────────────────────────────────────────────────────── */

/** Primero lo que tiene consecuencias inmediatas. `none` va último. */
const ORDEN_RIESGO: Record<CommentRisk, number> = {
  secret: 0,
  internal_note: 1,
  disabled_code: 2,
  todo: 3,
  none: 4,
}

/** El de arriba es el que sale del sitio. Es el orden de la pantalla entera. */
const ORDEN_ALCANCE: CommentReach[] = ['ships_to_browser', 'server_only', 'build_only']

/** Cuántas filas comunes se muestran abiertas antes de plegar el resto. */
const ABIERTAS_POR_GRUPO = 4

/**
 * Tope de filas marcadas que se muestran abiertas.
 *
 * Las claves nunca entran en este tope: se muestran todas, siempre. Lo que se
 * limita es el resto —pendientes, código apagado—, porque una lista de
 * doscientas filas no se lee, se cierra. El total sigue estando a la vista y
 * el resto queda a un clic.
 */
const MARCADAS_ABIERTAS = 8

/**
 * Tope de filas que se llegan a dibujar en el pliegue.
 *
 * Un proyecto normal tiene miles de comentarios. Meterlos todos en la página
 * la vuelve lentísima y no le sirve a nadie: nadie lee mil setecientas filas.
 * Se muestra una tanda, se dice cuántas quedaron sin listar, y se aclara que
 * la limpieza igual las incluye a todas.
 */
const RESTO_MAXIMO = 50

const QUIEN_LO_LEE: Record<CommentReach, string> = {
  // Las tres frases son la explicación de producto comprimida a una línea.
  // No agregan ninguna afirmación que no esté en `COMENTARIOS.explicacion`.
  ships_to_browser: 'Se leen apretando «ver código fuente» en cualquier navegador.',
  server_only: 'No salen nunca de tu servidor. Nadie de afuera los puede leer.',
  build_only: 'Se quedan en tu computadora: ni siquiera llegan a publicarse.',
}

export function esRiesgoso(risk: CommentRisk): boolean {
  return risk !== 'none'
}

/**
 * Riesgos que justifican levantar la voz: los que le dicen algo a un
 * desconocido. Un pendiente o un pedazo de código apagado son ruido, no una
 * filtración — se listan, pero no cambian el color de la pantalla ni el
 * veredicto. Si gritáramos por un "pendiente", el día que aparezca una clave
 * de verdad nadie nos va a creer.
 */
export function esSensible(risk: CommentRisk): boolean {
  return risk === 'secret' || risk === 'internal_note'
}

export function nombreDeRiesgo(risk: CommentRisk): string {
  return COMENTARIOS.riesgo[risk]
}

export function nombreDeAlcance(reach: CommentReach): string {
  return COMENTARIOS.alcance[reach]
}

/**
 * Color de un riesgo. Un comentario común no lleva color: si todo estuviera
 * teñido, el que sí importa no se vería.
 */
export function tonoDeRiesgo(risk: CommentRisk): Tone {
  switch (risk) {
    case 'secret':
      return 'expuesto'
    case 'internal_note':
      return 'incompleto'
    case 'disabled_code':
    case 'todo':
      return 'revisar'
    case 'none':
      return 'neutral'
  }
}

/**
 * Color de un grupo de alcance.
 *
 * Solo el grupo que sale del sitio puede tomar color, y lo toma por lo que
 * dice, no por dónde está. Los otros dos son neutros a propósito: un
 * comentario de servidor no es un problema y la pantalla no puede insinuar
 * que lo sea.
 */
export function tonoDelGrupo(g: ReachGroup): Tone {
  if (g.reach !== 'ships_to_browser') return 'neutral'
  if (g.secretos > 0) return 'expuesto'
  if (g.sensibles > 0) return 'incompleto'
  return 'verificado'
}

function ordenar(a: CommentRowModel, b: CommentRowModel): number {
  const porRiesgo = ORDEN_RIESGO[a.risk] - ORDEN_RIESGO[b.risk]
  if (porRiesgo !== 0) return porRiesgo
  // Entre iguales, primero el que se puede sacar: es sobre el que se puede actuar.
  if (a.functional !== b.functional) return a.functional ? 1 : -1
  const porArchivo = a.file.localeCompare(b.file)
  return porArchivo !== 0 ? porArchivo : a.line - b.line
}

export function filaDesdeHit(hit: CommentHit): CommentRowModel {
  return {
    id: `${hit.file}:${hit.line}`,
    file: hit.file,
    line: hit.line,
    endLine: hit.endLine,
    text: hit.text,
    reach: hit.reach,
    risk: hit.risk,
    functional: hit.functional,
    reason: hit.reason,
  }
}

function armarGrupo(reach: CommentReach, filas: CommentRowModel[]): ReachGroup {
  const ordenadas = [...filas].sort(ordenar)
  const claves = ordenadas.filter((f) => f.risk === 'secret')
  const otrasMarcadas = ordenadas.filter((f) => esRiesgoso(f.risk) && f.risk !== 'secret')
  const comunes = ordenadas.filter((f) => !esRiesgoso(f.risk))

  // Las claves van todas. Del resto se abre una tanda y lo demás se pliega:
  // el objetivo es que se pueda actuar, no que esté todo desplegado.
  const destacados = [
    ...claves,
    ...otrasMarcadas.slice(0, MARCADAS_ABIERTAS),
    ...comunes.slice(0, ABIERTAS_POR_GRUPO),
  ]
  const restoCompleto = [
    ...otrasMarcadas.slice(MARCADAS_ABIERTAS),
    ...comunes.slice(ABIERTAS_POR_GRUPO),
  ]
  const resto = restoCompleto.slice(0, RESTO_MAXIMO)
  const ocultos = restoCompleto.length - resto.length

  return {
    reach,
    titulo: nombreDeAlcance(reach),
    quienLoLee: QUIEN_LO_LEE[reach],
    total: ordenadas.length,
    riesgosos: claves.length + otrasMarcadas.length,
    sensibles: ordenadas.filter((f) => esSensible(f.risk)).length,
    secretos: ordenadas.filter((f) => f.risk === 'secret').length,
    archivos: new Set(ordenadas.map((f) => f.file)).size,
    destacados,
    resto,
    ocultos,
  }
}

function armarFuncionales(filas: CommentRowModel[]): FuncionalesResumen {
  const conteo = new Map<string, number>()
  for (const f of filas) {
    if (!f.reason) continue
    conteo.set(f.reason, (conteo.get(f.reason) ?? 0) + 1)
  }

  const motivos = [...conteo.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)

  // Un ejemplo por motivo: alcanza para que se entienda de qué habla cada uno.
  const vistos = new Set<string>()
  const ejemplos: CommentRowModel[] = []
  for (const f of [...filas].sort(ordenar)) {
    if (!f.reason || vistos.has(f.reason)) continue
    vistos.add(f.reason)
    ejemplos.push(f)
  }

  return { total: filas.length, motivos, ejemplos }
}

function armarArchivos(filas: CommentRowModel[]): FileSummary[] {
  const porArchivo = new Map<string, FileSummary>()

  for (const f of filas) {
    const actual = porArchivo.get(f.file) ?? {
      file: f.file,
      total: 0,
      removibles: 0,
      expuestos: 0,
      riesgosos: 0,
    }
    actual.total += 1
    if (!f.functional) actual.removibles += 1
    if (f.reach === 'ships_to_browser') actual.expuestos += 1
    if (esRiesgoso(f.risk)) actual.riesgosos += 1
    porArchivo.set(f.file, actual)
  }

  return [...porArchivo.values()]
    .filter((a) => a.removibles > 0)
    .sort(
      (a, b) =>
        b.riesgosos - a.riesgosos ||
        b.expuestos - a.expuestos ||
        b.removibles - a.removibles ||
        a.file.localeCompare(b.file),
    )
}

/**
 * Convierte el resultado del motor en lo que la pantalla necesita.
 * No decide nada de estilo: solo ordena, agrupa y cuenta.
 */
export function construirModelo(scan: CommentScanResult): CommentsViewModel {
  const filas = scan.hits.map(filaDesdeHit)
  const expuestas = filas.filter((f) => f.reach === 'ships_to_browser')

  return {
    scannedFiles: scan.scannedFiles,
    total: filas.length,
    exposedCount: scan.exposedCount,
    riskyCount: scan.riskyCount,
    removableCount: scan.removableCount,
    exposedSecrets: expuestas.filter((f) => f.risk === 'secret').length,
    exposedSensitive: expuestas.filter((f) => esSensible(f.risk)).length,
    exposedRisky: expuestas.filter((f) => esRiesgoso(f.risk)).length,
    grupos: ORDEN_ALCANCE.map((reach) =>
      armarGrupo(
        reach,
        filas.filter((f) => f.reach === reach),
      ),
    ),
    funcionales: armarFuncionales(filas.filter((f) => f.functional)),
    archivos: armarArchivos(filas),
  }
}

/* ── El veredicto ──────────────────────────────────────────────────────── */

export interface Veredicto {
  tone: Tone
  /** La frase grande. Es lo único que hay que leer para saber cómo estás. */
  titular: string
  /** El número que respalda al titular. */
  apoyo: string
}

/**
 * Una sola frase que resuelve la pantalla.
 *
 * El eje es el alcance —cuántos salen a la vista—, y el riesgo lo modifica.
 * Cuando no hay nada comprometedor lo decimos como lo que es: una buena
 * noticia, no un "sin resultados".
 */
export function veredicto(m: CommentsViewModel): Veredicto {
  const n = (x: number) => x.toLocaleString('es-AR')

  if (m.total === 0) {
    return {
      tone: 'verificado',
      titular: 'Tu código no tiene comentarios.',
      apoyo: `Revisamos ${n(m.scannedFiles)} archivos y no encontramos ninguno.`,
    }
  }

  if (m.exposedCount === 0) {
    return {
      tone: 'verificado',
      titular: 'Ningún comentario tuyo se ve desde afuera.',
      apoyo: `Los ${n(m.total)} que encontramos se quedan adentro de tu proyecto.`,
    }
  }

  if (m.exposedSecrets > 0) {
    return {
      tone: 'expuesto',
      titular:
        m.exposedSecrets === 1
          ? 'Un comentario a la vista de cualquiera tiene algo que parece una clave.'
          : `${n(m.exposedSecrets)} comentarios a la vista de cualquiera tienen algo que parece una clave.`,
      apoyo: `Están entre los ${n(m.exposedCount)} que se leen desde el navegador. Sacalos hoy.`,
    }
  }

  if (m.exposedSensitive > 0) {
    return {
      tone: 'incompleto',
      titular:
        m.exposedSensitive === 1
          ? 'Un comentario que se ve desde afuera dice más de lo que conviene.'
          : `${n(m.exposedSensitive)} comentarios que se ven desde afuera dicen más de lo que conviene.`,
      apoyo: `Ninguno parece tener una clave, pero están a la vista junto con otros ${n(m.exposedCount - m.exposedSensitive)}.`,
    }
  }

  return {
    tone: 'verificado',
    titular: `${n(m.exposedCount)} comentarios se ven desde afuera, y ninguno dice nada comprometedor.`,
    apoyo: `Los miramos uno por uno: no hay claves ni notas internas entre los ${n(m.total)} de tu proyecto.`,
  }
}

/** Proporción de cada alcance sobre el total. Para la barra de una sola mirada. */
export function repartoPorAlcance(m: CommentsViewModel): Array<{
  reach: CommentReach
  titulo: string
  total: number
  porcentaje: number
}> {
  const total = m.total || 1
  return m.grupos.map((g) => ({
    reach: g.reach,
    titulo: g.titulo,
    total: g.total,
    porcentaje: (g.total / total) * 100,
  }))
}
