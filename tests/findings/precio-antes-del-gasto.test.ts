import { describe, expect, it, vi } from 'vitest'
import {
  dialogoAbierto,
  encolarSiSeConfirmoElPrecio,
  puedeEncolar,
  siguientePaso,
  type PasoDeConfirmacion,
  type PresupuestoDeRevision,
} from '@/components/findings/run-cost'
import { CONFIRMAR_REVISION } from '@/components/findings/copy'
import { detectarJerga } from '@/content/lenguaje'
import { estimate } from '@/server/cost/ledger'
import { formatUsd } from '@/lib/utils'

/**
 * Regla dura #3 del producto: **el costo se muestra en dólares y en unidades
 * concretas antes de gastar. Nunca "créditos".**
 *
 * La pantalla de hallazgos la violaba: el botón de revisar encolaba la corrida
 * en el mismo click. Estos tests son la red que impide que vuelva a pasar.
 */

const PRESUPUESTO: PresupuestoDeRevision = {
  costUsd: 0.87,
  unidades: ['1 auditoría', '3 videos'],
  medido: true,
  archivos: 128,
}

const TODOS_LOS_PASOS: PasoDeConfirmacion[] = [
  { paso: 'cerrado' },
  { paso: 'calculando' },
  { paso: 'listo', presupuesto: PRESUPUESTO },
  { paso: 'sin-presupuesto', mensaje: 'No pudimos sacar la cuenta.', detalle: null },
  { paso: 'encolando', presupuesto: PRESUPUESTO },
]

/* ── Nada se encola antes de mostrar el precio ─────────────────────────── */

describe('puedeEncolar — el precio en pantalla es la única llave', () => {
  it('solo habilita desde el paso en el que el número ya se ve', () => {
    for (const paso of TODOS_LOS_PASOS) {
      expect(puedeEncolar(paso), `paso "${paso.paso}"`).toBe(paso.paso === 'listo')
    }
  })

  it('no habilita mientras se calcula: un número en camino no es un número', () => {
    expect(puedeEncolar({ paso: 'calculando' })).toBe(false)
  })

  it('tampoco habilita si la cuenta falló', () => {
    // Preferimos hacer reintentar a alguien antes que cobrarle sin avisarle.
    // Esta es la decisión de producto que este test protege.
    expect(
      puedeEncolar({ paso: 'sin-presupuesto', mensaje: 'Se cayó el servicio.', detalle: null }),
    ).toBe(false)
  })
})

describe('siguientePaso — el click de confirmar no puede saltear el cartel', () => {
  it('confirmar desde cualquier paso sin precio no mueve nada', () => {
    for (const paso of TODOS_LOS_PASOS.filter((p) => p.paso !== 'listo')) {
      expect(siguientePaso(paso, { tipo: 'confirmar' }), `paso "${paso.paso}"`).toEqual(paso)
    }
  })

  it('confirmar con el precio a la vista sí avanza, y se lleva el presupuesto', () => {
    expect(
      siguientePaso({ paso: 'listo', presupuesto: PRESUPUESTO }, { tipo: 'confirmar' }),
    ).toEqual({ paso: 'encolando', presupuesto: PRESUPUESTO })
  })

  it('abrir siempre vuelve a calcular: un precio viejo es peor que una espera', () => {
    expect(siguientePaso({ paso: 'listo', presupuesto: PRESUPUESTO }, { tipo: 'abrir' })).toEqual({
      paso: 'calculando',
    })
  })

  it('un presupuesto que llega tarde no reabre un cartel que el usuario ya cerró', () => {
    expect(
      siguientePaso({ paso: 'cerrado' }, { tipo: 'presupuesto', presupuesto: PRESUPUESTO }),
    ).toEqual({ paso: 'cerrado' })
  })

  it('mientras se encola, el cartel no se cierra solo', () => {
    const encolando: PasoDeConfirmacion = { paso: 'encolando', presupuesto: PRESUPUESTO }
    expect(siguientePaso(encolando, { tipo: 'cerrar' })).toEqual(encolando)
  })

  it('el cartel está abierto en todo paso que no sea "cerrado"', () => {
    for (const paso of TODOS_LOS_PASOS) {
      expect(dialogoAbierto(paso), `paso "${paso.paso}"`).toBe(paso.paso !== 'cerrado')
    }
  })
})

describe('encolarSiSeConfirmoElPrecio — la acción cara ni se llama sin confirmar', () => {
  it('no toca la acción que cuesta plata desde ningún paso sin precio confirmado', async () => {
    for (const paso of TODOS_LOS_PASOS.filter((p) => p.paso !== 'listo')) {
      const encolar = vi.fn().mockResolvedValue({ ok: true })
      const salida = await encolarSiSeConfirmoElPrecio(paso, encolar)

      expect(encolar, `paso "${paso.paso}"`).not.toHaveBeenCalled()
      expect(salida.encolado).toBe(false)
      expect(salida.paso).toEqual(paso)
    }
  })

  it('con el precio confirmado encola una sola vez y cierra el cartel', async () => {
    const encolar = vi.fn().mockResolvedValue({ ok: true })
    const salida = await encolarSiSeConfirmoElPrecio(
      { paso: 'listo', presupuesto: PRESUPUESTO },
      encolar,
    )

    expect(encolar).toHaveBeenCalledTimes(1)
    expect(encolar).toHaveBeenCalledWith(PRESUPUESTO)
    expect(salida).toEqual({ paso: { paso: 'cerrado' }, encolado: true, error: null })
  })

  it('si el servidor no la pudo poner en la fila, cierra y devuelve el motivo', async () => {
    const encolar = vi.fn().mockResolvedValue({ ok: false, error: 'La cola no responde.' })
    const salida = await encolarSiSeConfirmoElPrecio(
      { paso: 'listo', presupuesto: PRESUPUESTO },
      encolar,
    )

    expect(salida.encolado).toBe(false)
    expect(salida.error).toBe('La cola no responde.')
    // Se cierra: un aviso tapado por una ventana abierta no lo lee nadie.
    expect(salida.paso).toEqual({ paso: 'cerrado' })
  })
})

/* ── El número que se muestra ──────────────────────────────────────────── */

describe('el presupuesto que baja al navegador', () => {
  it('viene en dólares y en unidades concretas, nunca en créditos', () => {
    // `estimate()` es la misma función que usa la acción de servidor. Acá se
    // comprueba la forma del dato que efectivamente ve el usuario.
    const calculado = estimate('full_audit', { files: 128 })

    expect(calculado.costUsd).toBeGreaterThan(0)
    expect(calculado.unitsPlain.length).toBeGreaterThan(0)
    for (const unidad of calculado.unitsPlain) {
      expect(unidad).not.toMatch(/cr[ée]dito/i)
      expect(detectarJerga(unidad), `jerga en "${unidad}"`).toEqual([])
    }

    // Y se puede escribir como plata de verdad, no como un puntaje.
    expect(formatUsd(calculado.costUsd)).toMatch(/US\$|menos de/)
  })

  it('un proyecto más grande no sale más barato', () => {
    const chico = estimate('full_audit', { files: 20 })
    const grande = estimate('full_audit', { files: 140 })
    expect(grande.costUsd).toBeGreaterThan(chico.costUsd)
  })
})

/* ── El texto del cartel ───────────────────────────────────────────────── */

describe('el cartel de confirmación dice lo que tiene que decir', () => {
  it('cuenta qué va a pasar antes de que el usuario decida', () => {
    expect(CONFIRMAR_REVISION.consecuencias.length).toBeGreaterThanOrEqual(2)
    // No escribimos en la base del usuario, y eso hay que decirlo: es la duda
    // número uno de alguien que nos está por dar acceso a su proyecto.
    expect(CONFIRMAR_REVISION.consecuencias.join(' ')).toMatch(/no escribimos nada/i)
  })

  it('avisa que los resultados de ahora se reemplazan', () => {
    expect(CONFIRMAR_REVISION.consecuenciaReemplazo).toMatch(/reemplaza/i)
  })

  it('cuando no medimos el proyecto, lo dice en vez de inventar precisión', () => {
    expect(CONFIRMAR_REVISION.costo.sinMedir).toMatch(/todavía no medimos/i)
  })

  it('cuando sí lo medimos, dice sobre cuántos archivos sacó la cuenta', () => {
    expect(CONFIRMAR_REVISION.costo.medido(128)).toContain('128')
    expect(CONFIRMAR_REVISION.costo.medido(1)).not.toContain('1 archivos')
  })

  it('si no se pudo calcular, explica por qué no arrancamos igual', () => {
    const texto = `${CONFIRMAR_REVISION.falla.titulo} ${CONFIRMAR_REVISION.falla.texto}`
    expect(texto).toMatch(/precio|cuánto sale/i)
  })

  it('nada del cartel tiene jerga ni habla de créditos', () => {
    const textos = [
      CONFIRMAR_REVISION.primeraVez.titulo,
      CONFIRMAR_REVISION.primeraVez.accion,
      CONFIRMAR_REVISION.otraVez.titulo,
      CONFIRMAR_REVISION.otraVez.accion,
      CONFIRMAR_REVISION.cancelar,
      CONFIRMAR_REVISION.consecuenciaReemplazo,
      CONFIRMAR_REVISION.costo.calculando,
      CONFIRMAR_REVISION.costo.sinMedir,
      CONFIRMAR_REVISION.costo.medido(42),
      CONFIRMAR_REVISION.falla.titulo,
      CONFIRMAR_REVISION.falla.texto,
      CONFIRMAR_REVISION.noArranco,
      ...CONFIRMAR_REVISION.consecuencias,
    ]

    for (const texto of textos) {
      expect(detectarJerga(texto), `jerga en: "${texto}"`).toEqual([])
      expect(texto, `créditos en: "${texto}"`).not.toMatch(/cr[ée]dito/i)
    }
  })
})
