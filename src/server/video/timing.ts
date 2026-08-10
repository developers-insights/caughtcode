/**
 * Presupuesto de duración de un clip de hallazgo.
 *
 * Lo usa: `src/server/video/index.ts` (después de medir el audio real) y
 * `src/server/video/script.ts` (para acotar cuánto puede escribir el modelo).
 *
 * D12 fija 60-90 s por clip. La regla del frente es más específica: si el guion
 * se pasa **se recorta la demostración, nunca la explicación**. Este módulo es
 * la implementación literal de esa regla, y es la única pieza que decide
 * duraciones. El renderer no improvisa: recibe números ya cerrados.
 *
 * Módulo puro. Testeado en `tests/video/timing.test.ts`.
 */

/* ── Límites del clip ─────────────────────────────────────────────────── */

export const CLIP_MIN_MS = 60_000
export const CLIP_MAX_MS = 90_000

/** Los cuatro momentos del clip. El orden del array es el orden en pantalla. */
export type SceneRole = 'gancho' | 'demostracion' | 'prueba' | 'accion'

export const ORDEN_ROLES: SceneRole[] = ['gancho', 'demostracion', 'prueba', 'accion']

export interface RangoRol {
  minMs: number
  maxMs: number
  /** Si es elástico, absorbe el sobrante o el faltante del clip. */
  elastico: boolean
}

/** Rangos del brief. Solo la demostración es elástica. */
export const RANGO_ROL: Record<SceneRole, RangoRol> = {
  gancho: { minMs: 5_000, maxMs: 8_000, elastico: false },
  demostracion: { minMs: 25_000, maxMs: 40_000, elastico: true },
  prueba: { minMs: 10_000, maxMs: 15_000, elastico: false },
  accion: { minMs: 10_000, maxMs: 15_000, elastico: false },
}

/** Aire antes de que arranque la voz de cada escena. */
export const ENTRADA_MS = 260
/** Aire después de que la voz termina, para que no se pise con el corte. */
export const COLA_MS = 620
/**
 * Cabecera muda al inicio del clip. Cumple dos funciones: da un beat de lectura
 * de la placa de apertura, y absorbe la variación del arranque de la grabación
 * de Playwright (ver `render/web.ts`).
 */
export const ENTRADILLA_MS = 700

/**
 * Piso absoluto de una demostración cuando hay que recortar. Por debajo de esto
 * el recorte deja de ser evidencia y pasa a ser un parpadeo.
 */
export const DEMO_PISO_MS = 12_000

/* ── Presupuesto de escritura ─────────────────────────────────────────── */

/**
 * Caracteres por segundo efectivos de la locución.
 * `NARRATION_CHARS_PER_SECOND` de `pricing.ts` es 15 al ritmo normal; acá
 * hablamos 12% más lento (ver `tts/ssml.ts`), así que rinde menos.
 * Se deja como constante local a propósito: `pricing.ts` no es de este frente.
 */
export const CARACTERES_POR_SEGUNDO = 13.2

/**
 * Cuánto puede escribir el modelo en cada momento, en caracteres.
 *
 * Los topes NO son de gusto: salen de despejar `RANGO_ROL`. Un gancho de 8 s
 * son 8000 ms menos la entrada y la cola, menos las pausas de puntuación, por
 * 13,2 caracteres por segundo. Si estos números y `RANGO_ROL` se desincronizan,
 * el modelo escribe frases que no entran y `ajustarDuraciones` tiene que elegir
 * entre romper la banda de D12 o cortar la voz. `tests/video/timing.test.ts`
 * verifica que sigan siendo coherentes.
 */
export const PRESUPUESTO_CARACTERES: Record<SceneRole, { min: number; max: number }> = {
  gancho: { min: 45, max: 80 },
  demostracion: { min: 200, max: 440 },
  prueba: { min: 90, max: 170 },
  accion: { min: 90, max: 170 },
}

/** Margen para las pausas de puntuación, que no son caracteres pero ocupan. */
export const HOLGURA_PAUSAS_MS = 800

/** Estimación de duración hablada, para cuando todavía no hay audio real. */
export function estimarVozMs(texto: string, pausasMs = 0): number {
  const caracteres = texto.trim().length
  return Math.round((caracteres / CARACTERES_POR_SEGUNDO) * 1000 + pausasMs)
}

/* ── Ajuste de duraciones ─────────────────────────────────────────────── */

export interface TramoEntrada {
  role: SceneRole
  /** Duración real del audio de esta escena. 0 si es muda. */
  audioMs: number
  /**
   * Techo del material disponible. En una demostración es cuánto dura el
   * recorte de grabación: no tiene sentido estirar más allá de eso.
   */
  materialMaxMs?: number
}

export interface TramoSalida {
  role: SceneRole
  /** Duración final de la escena. */
  durationMs: number
  /** Cuándo arranca la voz dentro de la escena. */
  vozOffsetMs: number
  audioMs: number
}

export interface AjusteDuraciones {
  tramos: TramoSalida[]
  /** Duración total del clip, incluida la entradilla muda. */
  totalMs: number
  /** Problemas que hay que reportar, no esconder. */
  avisos: string[]
}

/** Lo mínimo que puede durar una escena sin cortar la voz. */
export function pisoDeTramo(t: TramoEntrada): number {
  return ENTRADA_MS + Math.max(0, t.audioMs) + COLA_MS
}

/**
 * Cierra las duraciones para que el clip caiga en 60-90 s.
 *
 * Orden de las decisiones, y el porqué de cada una:
 *  1. Ninguna escena baja de lo que dura su voz. Cortar una palabra sería
 *     mentirle al usuario a mitad de una frase.
 *  2. Si sobra tiempo, se estira la demostración: mirar al agente unos segundos
 *     más en silencio es contenido, no relleno.
 *  3. Si falta, se recorta la demostración hasta `DEMO_PISO_MS`. La explicación
 *     no se toca nunca.
 *  4. Si aun así no entra, se devuelve el número real y un aviso. Preferimos un
 *     clip de 93 s declarado que uno de 90 s con la última frase cortada.
 */
export function ajustarDuraciones(entrada: TramoEntrada[]): AjusteDuraciones {
  const avisos: string[] = []
  if (entrada.length === 0) {
    return { tramos: [], totalMs: ENTRADILLA_MS, avisos: ['El guion no tiene escenas.'] }
  }

  const pisos = entrada.map(pisoDeTramo)

  // 1. Punto de partida: el piso de voz, elevado al mínimo del rol.
  //
  // El piso manda sobre cualquier techo. Un techo que se aplicara por debajo
  // del piso cortaría la voz a mitad de una frase, y eso es lo único que este
  // módulo tiene prohibido hacer: preferimos un clip de 93 s con un aviso antes
  // que uno de 90 s donde la última oración se corta por la mitad.
  const duraciones = entrada.map((t, i) => {
    const rango = RANGO_ROL[t.role]
    let d = Math.max(pisos[i], rango.minMs)

    if (pisos[i] > rango.maxMs) {
      avisos.push(
        `La narración de "${t.role}" dura ${Math.round(pisos[i] / 1000)} s y el tramo admite ${Math.round(rango.maxMs / 1000)} s. Se respeta la voz.`,
      )
    }

    // Techo del rol: solo puede bajar hasta el piso, nunca por debajo.
    d = Math.min(d, Math.max(rango.maxMs, pisos[i]))

    // Techo del material grabado: misma regla.
    if (t.materialMaxMs && t.materialMaxMs > 0) {
      d = Math.min(d, Math.max(pisos[i], t.materialMaxMs))
    }
    return d
  })

  const indicesElasticos = entrada
    .map((t, i) => (RANGO_ROL[t.role].elastico ? i : -1))
    .filter((i) => i >= 0)

  const total = () => duraciones.reduce((a, b) => a + b, 0) + ENTRADILLA_MS

  // 2. Falta tiempo: estirar la demostración.
  if (total() < CLIP_MIN_MS) {
    const objetivo = indicesElasticos.length > 0 ? indicesElasticos : [duraciones.length - 1]

    // Primera pasada: se estira solo hasta donde llega el material grabado.
    let faltante = CLIP_MIN_MS - total()
    for (const i of objetivo) {
      if (faltante <= 0) break
      const material = entrada[i].materialMaxMs
      const techo =
        material && material > 0 ? Math.max(material, duraciones[i]) : Number.POSITIVE_INFINITY
      const suma = Math.min(faltante, techo - duraciones[i])
      duraciones[i] += suma
      faltante -= suma
    }

    // Segunda pasada: si la grabación se quedó corta, se sostiene el último
    // cuadro. Cumplir los 60 s de D12 pesa más que evitar una imagen quieta —
    // y una imagen quieta con voz encima se lee como una pausa, no como un error.
    if (faltante > 0) {
      const ultimo = objetivo[objetivo.length - 1]
      duraciones[ultimo] += faltante
      avisos.push(
        `La grabación no daba para 60 s: los últimos ${Math.round(faltante / 1000)} s sostienen el cuadro final.`,
      )
    }
  }

  // 3. Sobra tiempo: recortar la demostración, nunca la explicación.
  if (total() > CLIP_MAX_MS) {
    let sobrante = total() - CLIP_MAX_MS
    for (const i of indicesElasticos) {
      if (sobrante <= 0) break
      const piso = Math.max(pisos[i], DEMO_PISO_MS)
      const puedeCeder = Math.max(0, duraciones[i] - piso)
      const cede = Math.min(sobrante, puedeCeder)
      duraciones[i] -= cede
      sobrante -= cede
    }
    if (sobrante > 0) {
      avisos.push(
        `El clip queda en ${Math.round(total() / 1000)} s. La explicación sola ya se pasa de 90 s: hay que acortar la narración, no el video.`,
      )
    }
  }

  const tramos: TramoSalida[] = entrada.map((t, i) => ({
    role: t.role,
    durationMs: Math.round(duraciones[i]),
    vozOffsetMs: ENTRADA_MS,
    audioMs: Math.max(0, Math.round(t.audioMs)),
  }))

  return { tramos, totalMs: Math.round(total()), avisos }
}

/** ¿El clip cae dentro de lo que promete D12? */
export function dentroDeBanda(totalMs: number): boolean {
  return totalMs >= CLIP_MIN_MS && totalMs <= CLIP_MAX_MS
}

export interface UbicacionEscena {
  /** Cuándo entra la escena, en ms desde el inicio del clip. */
  startMs: number
  /** Cuánto está en pantalla. La primera se queda la entradilla de más. */
  durationMs: number
  /** Cuándo arranca su frase. Es el offset que usa la pista de audio. */
  vozStartMs: number
  audioMs: number
}

/**
 * Convierte duraciones en posiciones absolutas.
 *
 * La entradilla muda se le suma a la **primera** escena en vez de dejar un
 * hueco vacío al principio: así el clip abre con la placa de apertura quieta en
 * pantalla y no con medio segundo de nada. Ese cuadro fijo es además lo que
 * absorbe la variación del arranque de la grabación de Playwright.
 *
 * Es la única función que traduce duraciones a offsets. La usan la pista de
 * audio, los subtítulos y la línea de tiempo de la página: los tres leen la
 * misma tabla, que es lo que hace que el clip quede sincronizado.
 */
export function ubicarEscenas(
  tramos: Array<{ durationMs: number; audioMs?: number }>,
): UbicacionEscena[] {
  const salida: UbicacionEscena[] = []
  let cursor = 0

  tramos.forEach((t, i) => {
    const extra = i === 0 ? ENTRADILLA_MS : 0
    const durationMs = t.durationMs + extra
    salida.push({
      startMs: cursor,
      durationMs,
      vozStartMs: cursor + extra + ENTRADA_MS,
      audioMs: Math.max(0, t.audioMs ?? 0),
    })
    cursor += durationMs
  })

  return salida
}

/** Duración total del clip a partir de las ubicaciones ya calculadas. */
export function duracionTotal(ubicaciones: UbicacionEscena[]): number {
  if (ubicaciones.length === 0) return 0
  const ultima = ubicaciones[ubicaciones.length - 1]
  return ultima.startMs + ultima.durationMs
}
