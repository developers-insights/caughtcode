/**
 * El precio antes del gasto.
 *
 * Regla dura del producto (`CLAUDE.md` #3, `DECISIONS.md` D16): **el costo se
 * muestra en dólares y en unidades concretas antes de gastar. Nunca créditos.**
 * Hasta ahora el botón de revisar encolaba la corrida en el mismo click, así
 * que el usuario descubría el precio después.
 *
 * Acá vive la máquina de estados de esa confirmación, separada de los
 * componentes para que la regla se pueda testear sin renderizar nada. La
 * invariante que sostiene todo el archivo es una sola:
 *
 * > `encolarSiSeConfirmoElPrecio()` es el **único** camino por el que la
 * > pantalla llama a la acción que cuesta plata, y solo avanza desde el paso
 * > `listo` — el único en el que el número ya está en pantalla.
 *
 * Los precios no viajan al cliente: acá solo llega el número ya calculado del
 * lado del servidor (ver `estimarRevisionAction`).
 */

/** Lo que ve el usuario antes de decidir. Salido de `estimate()` en el servidor. */
export interface PresupuestoDeRevision {
  costUsd: number
  /** Unidades concretas: "1 auditoría", "3 videos". Jamás "créditos". */
  unidades: string[]
  /**
   * `false` cuando todavía no medimos el proyecto y hubo que calcular sobre el
   * tamaño máximo que analizamos. Se dice en pantalla: es la diferencia entre
   * un número y un número honesto.
   */
  medido: boolean
  /** Cuántos archivos entraron en la cuenta. `null` si nunca lo medimos. */
  archivos: number | null
}

export type PasoDeConfirmacion =
  /** Nadie pidió nada todavía. */
  | { paso: 'cerrado' }
  /** El diálogo está abierto y el servidor está sacando la cuenta. */
  | { paso: 'calculando' }
  /** El número está en pantalla. Recién acá se puede confirmar. */
  | { paso: 'listo'; presupuesto: PresupuestoDeRevision }
  /**
   * No pudimos calcular el precio. **No se encola igual**: sin número no hay
   * confirmación posible, y esa es justamente la regla.
   */
  | { paso: 'sin-presupuesto'; mensaje: string; detalle: string | null }
  /** Confirmado y en camino a la cola. */
  | { paso: 'encolando'; presupuesto: PresupuestoDeRevision }

export type EventoDeConfirmacion =
  | { tipo: 'abrir' }
  | { tipo: 'presupuesto'; presupuesto: PresupuestoDeRevision }
  | { tipo: 'sin-presupuesto'; mensaje: string; detalle: string | null }
  | { tipo: 'confirmar' }
  | { tipo: 'cerrar' }

/** ¿El diálogo tiene que estar abierto en este paso? */
export function dialogoAbierto(actual: PasoDeConfirmacion): boolean {
  return actual.paso !== 'cerrado'
}

/**
 * El único paso desde el que se puede gastar plata.
 *
 * Todo lo demás —incluido "no pudimos calcular"— devuelve `false`. Preferimos
 * que alguien tenga que reintentar antes que cobrarle sin haberle dicho cuánto.
 */
export function puedeEncolar(actual: PasoDeConfirmacion): actual is {
  paso: 'listo'
  presupuesto: PresupuestoDeRevision
} {
  return actual.paso === 'listo'
}

export function siguientePaso(
  actual: PasoDeConfirmacion,
  evento: EventoDeConfirmacion,
): PasoDeConfirmacion {
  switch (evento.tipo) {
    case 'abrir':
      // Volver a abrir siempre recalcula: un presupuesto viejo es un precio
      // viejo, y mostrar un precio viejo es peor que hacer esperar dos segundos.
      return { paso: 'calculando' }

    case 'presupuesto':
      // Llegó tarde: el usuario ya cerró. No reabrimos el diálogo por él.
      if (actual.paso === 'cerrado') return actual
      return { paso: 'listo', presupuesto: evento.presupuesto }

    case 'sin-presupuesto':
      if (actual.paso === 'cerrado') return actual
      return { paso: 'sin-presupuesto', mensaje: evento.mensaje, detalle: evento.detalle }

    case 'confirmar':
      // Acá está la regla, hecha código: sin número en pantalla no se avanza.
      return puedeEncolar(actual) ? { paso: 'encolando', presupuesto: actual.presupuesto } : actual

    case 'cerrar':
      // Mientras se encola no se cierra solo: el cierre lo hace quien recibe la
      // respuesta del servidor, para que el diálogo no desaparezca a mitad.
      return actual.paso === 'encolando' ? actual : { paso: 'cerrado' }
  }
}

/**
 * Encola **solo** si el usuario ya vio el precio.
 *
 * `encolar` se inyecta para que esta función no sepa nada de servidores y se
 * pueda testear derecho: el test comprueba que desde cualquier paso que no sea
 * `listo` la acción cara ni siquiera se llama.
 */
export async function encolarSiSeConfirmoElPrecio(
  actual: PasoDeConfirmacion,
  encolar: (presupuesto: PresupuestoDeRevision) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ paso: PasoDeConfirmacion; encolado: boolean; error: string | null }> {
  if (!puedeEncolar(actual)) return { paso: actual, encolado: false, error: null }

  const resultado = await encolar(actual.presupuesto)

  // Falló el encolado. El diálogo se cierra igual y el problema se cuenta en la
  // pantalla: un aviso tapado por una ventana abierta no lo lee nadie, y acá el
  // usuario no perdió nada — no se gastó un peso.
  if (!resultado.ok) {
    return { paso: { paso: 'cerrado' }, encolado: false, error: resultado.error ?? null }
  }

  // Encolada. Se cierra el diálogo: de acá en más lo que informa es la propia
  // pantalla, que pasa a "está en la fila".
  return { paso: { paso: 'cerrado' }, encolado: true, error: null }
}
