/**
 * Qué cambia exactamente en un archivo, y dónde mirarlo.
 *
 * El motor devuelve el archivo entero de los dos lados. Mostrarlo completo
 * sería pedirle a alguien que compare dos textos de cuatrocientas líneas para
 * encontrar la diferencia; marcar todo lo que hay entre el primer y el último
 * cambio sería peor, porque señalaría veinte líneas cuando cambiaron tres.
 *
 * Así que se alinean las dos versiones línea por línea y se marca únicamente
 * lo que sale o se modifica. La limpieza casi siempre solo **borra**, y para
 * ese caso la alineación es exacta.
 */

const CONTEXTO = 3
const MAX_LINEAS = 26
/** Hasta dónde se busca para reengancharse cuando las dos versiones se separan. */
const RESINCRONIZAR = 40

export type EstadoLinea = 'igual' | 'sale' | 'cambia'

export interface Ventana {
  code: string
  /** Número de la primera línea mostrada, en el archivo real. */
  startLine: number
  /** Líneas a marcar, en numeración del archivo real. */
  highlightLines: number[]
  /** Cuántas líneas del tramo no entraron por el tope. */
  recortadas: number
}

export interface VentanaDeCambio {
  antes: Ventana
  despues: Ventana
  /** Cuántos tramos separados cambian en el archivo. */
  tramos: number
  sinCambios: boolean
}

function partir(text: string): string[] {
  return text.replace(/\n$/, '').split('\n')
}

/**
 * Alinea las dos versiones y dice qué le pasó a cada línea del original.
 *
 * Avanza en paralelo mientras las líneas coinciden. Cuando dejan de coincidir
 * mira una línea más adelante: si el original se reengancha, la línea se fue;
 * si se reenganchan los dos, la línea se modificó. Si nada de eso alcanza,
 * busca el próximo punto en común dentro de una ventana acotada.
 */
export function alinear(antes: string[], despues: string[]): EstadoLinea[] {
  const estado: EstadoLinea[] = new Array(antes.length).fill('igual')
  let i = 0
  let j = 0

  while (i < antes.length && j < despues.length) {
    if (antes[i] === despues[j]) {
      i++
      j++
      continue
    }

    if (antes[i + 1] === despues[j]) {
      estado[i] = 'sale'
      i++
      continue
    }

    if (antes[i + 1] === despues[j + 1]) {
      estado[i] = 'cambia'
      i++
      j++
      continue
    }

    // Buscar el próximo punto en común: cuántas líneas del original hay que
    // descartar para volver a encontrarse con el resultado.
    let salto = -1
    for (let k = 2; k <= RESINCRONIZAR && i + k < antes.length; k++) {
      if (antes[i + k] === despues[j]) {
        salto = k
        break
      }
    }

    if (salto > 0) {
      for (let k = 0; k < salto; k++) estado[i + k] = 'sale'
      i += salto
      continue
    }

    estado[i] = 'cambia'
    i++
    j++
  }

  // Lo que sobra al final del original ya no está en el resultado.
  for (; i < antes.length; i++) estado[i] = 'sale'

  return estado
}

/** Índices de los tramos contiguos que cambian. */
function tramosDe(estado: EstadoLinea[]): Array<{ desde: number; hasta: number }> {
  const tramos: Array<{ desde: number; hasta: number }> = []
  let desde = -1

  for (let i = 0; i < estado.length; i++) {
    const cambia = estado[i] !== 'igual'
    if (cambia && desde === -1) desde = i
    if (!cambia && desde !== -1) {
      tramos.push({ desde, hasta: i - 1 })
      desde = -1
    }
  }
  if (desde !== -1) tramos.push({ desde, hasta: estado.length - 1 })

  return tramos
}

function ventana(
  lineas: string[],
  desde: number,
  hasta: number,
  marcadas: number[],
): Ventana {
  const inicio = Math.max(0, desde - CONTEXTO)
  const finCompleto = Math.min(lineas.length - 1, hasta + CONTEXTO)
  const fin = Math.min(finCompleto, inicio + MAX_LINEAS - 1)

  return {
    code: lineas.slice(inicio, fin + 1).join('\n'),
    startLine: inicio + 1,
    highlightLines: marcadas.filter((n) => n >= inicio + 1 && n <= fin + 1),
    recortadas: finCompleto - fin,
  }
}

/**
 * Recorte del primer tramo que cambia, de los dos lados.
 *
 * Se muestra el primero y se dice cuántos más hay: alcanza para entender qué
 * clase de cambio es, que es lo que hace falta para decidir si aplicarlo.
 */
export function ventanaDeCambio(before: string, after: string): VentanaDeCambio {
  const a = partir(before)
  const b = partir(after)

  if (before === after) {
    const hasta = Math.min(a.length - 1, CONTEXTO)
    return {
      antes: ventana(a, 0, hasta, []),
      despues: ventana(b, 0, Math.min(b.length - 1, CONTEXTO), []),
      tramos: 0,
      sinCambios: true,
    }
  }

  const estado = alinear(a, b)
  const tramos = tramosDe(estado)

  if (tramos.length === 0) {
    const hasta = Math.min(a.length - 1, CONTEXTO)
    return {
      antes: ventana(a, 0, hasta, []),
      despues: ventana(b, 0, Math.min(b.length - 1, CONTEXTO), []),
      tramos: 0,
      sinCambios: true,
    }
  }

  const primero = tramos[0]!
  const marcadas: number[] = []
  for (let i = primero.desde; i <= primero.hasta; i++) marcadas.push(i + 1)

  // El resultado se muestra desde la misma altura: arriba del cambio las dos
  // versiones son idénticas, así que la línea de inicio coincide.
  const inicioDespues = Math.max(0, primero.desde - CONTEXTO)
  const finDespues = Math.min(b.length - 1, inicioDespues + (MAX_LINEAS - 1))

  return {
    antes: ventana(a, primero.desde, primero.hasta, marcadas),
    despues: {
      code: b.slice(inicioDespues, finDespues + 1).join('\n'),
      startLine: inicioDespues + 1,
      highlightLines: [],
      recortadas: 0,
    },
    tramos: tramos.length,
    sinCambios: false,
  }
}
