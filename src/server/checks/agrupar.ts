/**
 * Agrupación de repeticiones: 36 filas iguales son **un** problema, no 36.
 *
 * ## Por qué existe
 *
 * Una auditoría real devolvió 180 hallazgos. No eran 180 problemas: eran ~10
 * problemas repetidos decenas de veces (40 pantallas sin estado de carga, 36
 * tablas con las reglas sin forzar, 28 formularios con campos sin nombre…).
 *
 * Eso rompe dos cosas a la vez:
 *
 *  - **La regla de los tres** (D15). El 67% de las alertas de seguridad se
 *    ignoran por saturación. Un reporte con 180 filas muere en una planilla.
 *  - **La priorización.** Los seis primeros puestos del ranking los ocupaba el
 *    mismo problema seis veces, así que los otros nueve problemas —distintos—
 *    quedaban abajo de todo.
 *
 * ## Qué NO puede hacer
 *
 * Agrupar no puede perder la prueba de ningún caso (regla dura #1: nada sin
 * evidencia). El hallazgo agrupado se lleva la evidencia de **todas** sus
 * ocurrencias y la lista completa de lugares. Se colapsa la presentación, no la
 * prueba.
 *
 * ## Dónde va en el pipeline
 *
 * Entre `deduplicar()` y `rankear()`, dentro del motor:
 *
 *     chequeos → triaje → deduplicar → **agrupar** → rankear
 *
 * Después de deduplicar, porque si no se contarían como dos ocurrencias los dos
 * chequeos que ven el mismo hecho desde pilares distintos. Antes de rankear,
 * porque el `rank` tiene que calcularse sobre problemas distintos: es lo único
 * que hace que los tres destacados sean tres cosas y no una repetida.
 *
 * No se hace más tarde (ni en el handler, ni en la pantalla) porque `rank` se
 * persiste y se usa para elegir qué se demuestra en video: si la agrupación
 * pasara después, los tres videos podrían ser tres veces el mismo problema.
 */

import type { Evidence, FindingDraft } from '@/lib/types/domain'
import { CATALOGO_POR_ID } from '@/content/catalogo'
import { sujetoDe } from './evidencia'

/* ── Formas ───────────────────────────────────────────────────────────── */

/** Lo que sale de `deduplicar()`: un hallazgo por hecho, sin rank todavía. */
export interface HallazgoUnificado extends FindingDraft {
  /** Ids de los chequeos que detectaron lo mismo, si hubo más de uno. */
  detectadoPor: string[]
}

/** Lo que sale de `agrupar()`. `ocurrencias === 1` es un caso suelto. */
export interface HallazgoAgrupado extends HallazgoUnificado {
  /** En cuántos lugares aparece este mismo problema. Nunca menor a 1. */
  ocurrencias: number
  /**
   * Cada lugar, nombrado y verificable (`archivo:línea`, el objeto de la base,
   * la ruta probada). Es la lista completa: si hay 36 ocurrencias, hay 36
   * lugares. Ordenada alfabéticamente para que dos corridas den lo mismo.
   */
  lugares: string[]
}

/* ── El criterio ──────────────────────────────────────────────────────── */

/**
 * Chequeos donde **cada caso es su propio problema**, aunque se repitan.
 *
 * Son las credenciales expuestas. Tres claves filtradas no son "el mismo
 * problema en tres lugares": son tres claves distintas, cada una con su
 * proveedor, su rotación y su ventana de exposición. El arreglo de una no es el
 * arreglo de la otra, y colapsarlas haría que el usuario rote una y se olvide
 * de las otras dos creyendo que ya está.
 *
 * La lista es corta a propósito. Un chequeo entra acá solo si el arreglo de un
 * caso **no sirve** para los demás. Si el arreglo es el mismo (activar una
 * bandera, agregar un estado de carga, escribir una policy), se agrupa.
 */
export const SIEMPRE_INDIVIDUAL: ReadonlySet<string> = new Set([
  'sec.secret_in_repo',
  'sec.service_role_in_client',
  'sec.public_env_secret',
  'sec.env_committed',
  'sec.comment_secret',
])

/**
 * La clave por la que se agrupa, o `null` si este hallazgo va solo.
 *
 * Se agrupa por **chequeo + severidad + confianza**, y no solo por chequeo:
 *
 *  - **Severidad.** El mismo chequeo puede salir crítico en `/login` y medio en
 *    `/contacto`. Meterlos en una fila obliga a elegir un solo cartel: o se
 *    exagera el menor o se tapa el grave. Los dos resultados son peores que dos
 *    filas.
 *  - **Confianza.** Un hallazgo "a revisar" debajo del título de uno
 *    comprobado le presta una certeza que no tiene. Es exactamente lo que D14
 *    prohíbe: nuestro usuario no puede detectar una alucinación, así que la
 *    frontera entre "lo probamos" y "habría que mirarlo" no se difumina nunca.
 *
 * Y hay dos casos que no se agrupan nunca:
 *
 *  - Los de `SIEMPRE_INDIVIDUAL`, por lo explicado arriba.
 *  - **Todo lo que el agente grabó.** La grabación es la prueba de *ese* caso y
 *    el video se produce por hallazgo. Colapsar dos demostraciones en una fila
 *    esconde uno de los dos videos, que es justo lo que este producto tiene y
 *    los demás no. Además nunca son muchas: el agente corre un puñado de tareas.
 */
export function claveDeAgrupacion(hallazgo: HallazgoUnificado): string | null {
  if (SIEMPRE_INDIVIDUAL.has(hallazgo.checkId)) return null
  if (hallazgo.evidence.some((e) => e.kind === 'recording')) return null
  return `${hallazgo.checkId}|${hallazgo.severity}|${hallazgo.confidence}`
}

/* ── Copy ─────────────────────────────────────────────────────────────── */

/**
 * El texto de un hallazgo que pasa en muchos lugares.
 *
 * El título sale del catálogo (`titlePlainAgrupado`), que es donde vive todo el
 * copy del producto. La cantidad va **adelante**: "Las reglas de 36 tablas
 * tuyas se pueden saltear" dice de entrada cuán grande es el problema, mientras
 * que "Las reglas de admin_audit_log se pueden saltear — y en 35 lugares más"
 * hace pensar que el problema es esa tabla y esconde la magnitud al final.
 *
 * Las otras dos frases se arman acá porque son estructurales —el mismo remate
 * sirve para cualquier chequeo— y no aportan nada teniéndolas cuarenta veces
 * repetidas en el catálogo.
 */
export const COPY_AGRUPACION = {
  /**
   * Título del hallazgo agrupado.
   *
   * `agrupado` es el `titlePlainAgrupado` del catálogo, ya elegido por el
   * chequeo. Si ese chequeo no tiene uno escrito —porque no se esperaba que se
   * repitiera— se cae a una forma genérica que dice la cantidad igual, sin
   * fingir que el caso de ejemplo es el problema entero.
   */
  titulo: (base: string, ocurrencias: number, agrupado?: string): string =>
    agrupado
      ? agrupado.replaceAll('{{n}}', String(ocurrencias))
      : `Esto pasa en ${ocurrencias} lugares de tu proyecto: ${base}`,

  /** Se agrega al final de la explicación del caso que se usa como ejemplo. */
  explicacion: (base: string, ocurrencias: number): string =>
    `${base}\n\nNo pasa solo ahí: el mismo problema aparece en ${ocurrencias} lugares de tu proyecto.`,

  /** Un solo prompt para todos los casos: el del ejemplo, más la lista entera. */
  prompt: (base: string, lugares: string[]): string =>
    `${base}\n\nEl mismo arreglo hace falta en estos ${lugares.length} lugares:\n${lugares
      .map((lugar) => `- ${lugar}`)
      .join('\n')}`,
} as const

/* ── Motor de agrupación ──────────────────────────────────────────────── */

export function agrupar(unificados: HallazgoUnificado[]): HallazgoAgrupado[] {
  const grupos = new Map<string, HallazgoUnificado[]>()
  const salida: HallazgoAgrupado[] = []

  for (const hallazgo of unificados) {
    const clave = claveDeAgrupacion(hallazgo)
    if (clave === null) {
      salida.push(solo(hallazgo))
      continue
    }
    const existente = grupos.get(clave)
    if (existente) existente.push(hallazgo)
    else grupos.set(clave, [hallazgo])
  }

  for (const miembros of grupos.values()) {
    salida.push(miembros.length === 1 ? solo(miembros[0]!) : fusionar(miembros))
  }

  return salida
}

/** Un caso único sale tal cual: no se le toca ni una palabra. */
function solo(hallazgo: HallazgoUnificado): HallazgoAgrupado {
  return { ...hallazgo, ocurrencias: 1, lugares: [sujetoDe(hallazgo)] }
}

/**
 * Funde N repeticiones en una.
 *
 * El caso que se usa de ejemplo es el **primero por orden alfabético de lugar**,
 * no el primero que llegó. La entrada depende del orden en que el sistema de
 * archivos devolvió las rutas, y un reporte que se reordena solo entre corridas
 * parece roto.
 */
function fusionar(miembros: HallazgoUnificado[]): HallazgoAgrupado {
  const ordenados = [...miembros].sort((a, b) => sujetoDe(a).localeCompare(sujetoDe(b)))
  const ejemplo = ordenados[0]!

  const lugares = unicos(ordenados.map(sujetoDe))
  const ocurrencias = ordenados.length

  return {
    ...ejemplo,
    titlePlain: COPY_AGRUPACION.titulo(
      ejemplo.titlePlain,
      ocurrencias,
      CATALOGO_POR_ID.get(ejemplo.checkId)?.titlePlainAgrupado,
    ),
    explanationPlain: COPY_AGRUPACION.explicacion(ejemplo.explanationPlain, ocurrencias),
    // El impacto del catálogo no se toca: ya está escrito sin números y sigue
    // siendo cierto para el conjunto. Inventarle una versión "por N" sería
    // redactar copy nuevo acá, que es justo lo que no corresponde.
    fixPrompt: COPY_AGRUPACION.prompt(ejemplo.fixPrompt, lugares),
    // Toda la evidencia de todas las ocurrencias. Es la regla dura #1: agrupar
    // colapsa la presentación, nunca la prueba.
    evidence: evidenciaUnica(ordenados.flatMap((m) => m.evidence)),
    detectadoPor: [...new Set(ordenados.flatMap((m) => m.detectadoPor))].sort(),
    ocurrencias,
    lugares,
  }
}

function unicos(valores: string[]): string[] {
  return [...new Set(valores)]
}

/**
 * Junta la evidencia sin repetir la idéntica. Dos ocurrencias distintas nunca
 * traen la misma pieza; si la traen, es la misma prueba dos veces y mostrarla
 * duplicada solo hace ruido.
 */
function evidenciaUnica(evidence: Evidence[]): Evidence[] {
  const vistas = new Set<string>()
  const salida: Evidence[] = []
  for (const pieza of evidence) {
    const clave = JSON.stringify(pieza)
    if (vistas.has(clave)) continue
    vistas.add(clave)
    salida.push(pieza)
  }
  return salida
}
