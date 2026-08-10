import { describe, expect, it } from 'vitest'

import {
  ajustarDuraciones,
  CARACTERES_POR_SEGUNDO,
  CLIP_MAX_MS,
  CLIP_MIN_MS,
  COLA_MS,
  DEMO_PISO_MS,
  dentroDeBanda,
  duracionTotal,
  ENTRADA_MS,
  ENTRADILLA_MS,
  HOLGURA_PAUSAS_MS,
  ORDEN_ROLES,
  pisoDeTramo,
  PRESUPUESTO_CARACTERES,
  RANGO_ROL,
  ubicarEscenas,
  type SceneRole,
  type TramoEntrada,
} from '@/server/video/timing'

/** Un clip típico: cuatro momentos con voz de duración razonable. */
function clipTipico(): TramoEntrada[] {
  return [
    { role: 'gancho', audioMs: 5_200 },
    { role: 'demostracion', audioMs: 26_000, materialMaxMs: 60_000 },
    { role: 'prueba', audioMs: 11_000 },
    { role: 'accion', audioMs: 11_500 },
  ]
}

describe('la banda de 60-90 segundos (D12)', () => {
  it('un clip típico cae adentro', () => {
    const { totalMs, avisos } = ajustarDuraciones(clipTipico())
    expect(totalMs).toBeGreaterThanOrEqual(CLIP_MIN_MS)
    expect(totalMs).toBeLessThanOrEqual(CLIP_MAX_MS)
    expect(avisos).toHaveLength(0)
  })

  it('estira la demostración cuando el clip queda corto', () => {
    const corto: TramoEntrada[] = [
      { role: 'gancho', audioMs: 3_000 },
      { role: 'demostracion', audioMs: 8_000, materialMaxMs: 90_000 },
      { role: 'prueba', audioMs: 5_000 },
      { role: 'accion', audioMs: 5_000 },
    ]
    const { tramos, totalMs } = ajustarDuraciones(corto)
    expect(totalMs).toBeGreaterThanOrEqual(CLIP_MIN_MS)
    // Solo creció la demostración.
    expect(tramos[0].durationMs).toBeLessThanOrEqual(8_000)
    expect(tramos[1].durationMs).toBeGreaterThan(25_000)
  })

  it('llega a 60 s sosteniendo el cuadro final si la grabación es corta', () => {
    const sinMaterial: TramoEntrada[] = [
      { role: 'gancho', audioMs: 3_000 },
      { role: 'demostracion', audioMs: 6_000, materialMaxMs: 9_000 },
      { role: 'prueba', audioMs: 5_000 },
      { role: 'accion', audioMs: 5_000 },
    ]
    const { totalMs, avisos } = ajustarDuraciones(sinMaterial)
    expect(totalMs).toBeGreaterThanOrEqual(CLIP_MIN_MS)
    expect(avisos.join(' ')).toMatch(/cuadro final/i)
  })
})

describe('qué se recorta cuando sobra', () => {
  it('recorta la demostración, nunca la explicación', () => {
    const largo: TramoEntrada[] = [
      { role: 'gancho', audioMs: 7_000 },
      { role: 'demostracion', audioMs: 20_000, materialMaxMs: 120_000 },
      { role: 'prueba', audioMs: 14_000 },
      { role: 'accion', audioMs: 14_000 },
    ]
    const base = ajustarDuraciones(largo)

    const conDemoLarga = ajustarDuraciones([
      ...largo.slice(0, 1),
      { role: 'demostracion', audioMs: 60_000, materialMaxMs: 200_000 },
      ...largo.slice(2),
    ])

    // La explicación mantiene su tiempo aunque la demostración se haya ido al techo.
    expect(conDemoLarga.tramos[0].durationMs).toBe(base.tramos[0].durationMs)
    expect(conDemoLarga.tramos[2].durationMs).toBe(base.tramos[2].durationMs)
    expect(conDemoLarga.tramos[3].durationMs).toBe(base.tramos[3].durationMs)
  })

  it('nunca corta una escena por debajo de lo que dura su voz', () => {
    const entrada: TramoEntrada[] = [
      { role: 'gancho', audioMs: 20_000 },
      { role: 'demostracion', audioMs: 40_000, materialMaxMs: 200_000 },
      { role: 'prueba', audioMs: 30_000 },
      { role: 'accion', audioMs: 30_000 },
    ]
    const { tramos, avisos } = ajustarDuraciones(entrada)
    tramos.forEach((t, i) => {
      expect(t.durationMs).toBeGreaterThanOrEqual(pisoDeTramo(entrada[i]))
    })
    // Se pasa de 90 s y lo dice en vez de esconderlo.
    expect(avisos.join(' ')).toMatch(/acortar la narración/i)
  })

  it('la demostración no baja del piso que la vuelve ilegible', () => {
    const entrada: TramoEntrada[] = [
      { role: 'gancho', audioMs: 7_000 },
      { role: 'demostracion', audioMs: 2_000, materialMaxMs: 200_000 },
      { role: 'prueba', audioMs: 40_000 },
      { role: 'accion', audioMs: 40_000 },
    ]
    const { tramos } = ajustarDuraciones(entrada)
    expect(tramos[1].durationMs).toBeGreaterThanOrEqual(DEMO_PISO_MS)
  })
})

describe('ubicación de escenas', () => {
  it('la primera escena absorbe la entradilla y la voz arranca después', () => {
    const ubic = ubicarEscenas([{ durationMs: 8_000 }, { durationMs: 30_000 }])
    expect(ubic[0].startMs).toBe(0)
    expect(ubic[0].durationMs).toBe(8_000 + ENTRADILLA_MS)
    expect(ubic[0].vozStartMs).toBe(ENTRADILLA_MS + ENTRADA_MS)
    expect(ubic[1].startMs).toBe(8_000 + ENTRADILLA_MS)
    expect(ubic[1].vozStartMs).toBe(8_000 + ENTRADILLA_MS + ENTRADA_MS)
  })

  it('el total coincide con lo que dijo el ajuste', () => {
    const ajuste = ajustarDuraciones(clipTipico())
    const ubic = ubicarEscenas(ajuste.tramos)
    expect(duracionTotal(ubic)).toBe(ajuste.totalMs)
  })

  it('las escenas no se pisan ni dejan huecos', () => {
    const ubic = ubicarEscenas(ajustarDuraciones(clipTipico()).tramos)
    for (let i = 1; i < ubic.length; i++) {
      expect(ubic[i].startMs).toBe(ubic[i - 1].startMs + ubic[i - 1].durationMs)
    }
  })
})

describe('el presupuesto de escritura tiene que caber en el rango del rol', () => {
  // Esta invariante existe porque ya se rompió una vez: el gancho admitía 120
  // caracteres pero el tramo dura 8 s, así que toda narración larga generaba un
  // aviso de "se pasa" en cada clip. Si alguien toca un número y no el otro,
  // este test avisa antes de que se note en un video.
  const ROLES_FIJOS: SceneRole[] = ['gancho', 'prueba', 'accion']

  it.each(ROLES_FIJOS)('el máximo de "%s" entra en su ventana', (role) => {
    const msDeVoz = (PRESUPUESTO_CARACTERES[role].max / CARACTERES_POR_SEGUNDO) * 1000
    const necesario = ENTRADA_MS + msDeVoz + HOLGURA_PAUSAS_MS + COLA_MS
    expect(necesario).toBeLessThanOrEqual(RANGO_ROL[role].maxMs)
  })

  it.each(ROLES_FIJOS)('el mínimo de "%s" no obliga a estirar', (role) => {
    const msDeVoz = (PRESUPUESTO_CARACTERES[role].min / CARACTERES_POR_SEGUNDO) * 1000
    expect(ENTRADA_MS + msDeVoz + COLA_MS).toBeLessThanOrEqual(RANGO_ROL[role].maxMs)
  })

  it('la demostración al máximo entra en sus 40 segundos', () => {
    const msDeVoz = (PRESUPUESTO_CARACTERES.demostracion.max / CARACTERES_POR_SEGUNDO) * 1000
    expect(ENTRADA_MS + msDeVoz + HOLGURA_PAUSAS_MS + COLA_MS).toBeLessThanOrEqual(
      RANGO_ROL.demostracion.maxMs,
    )
  })

  it('los cuatro tramos al máximo no se pasan de 90 segundos', () => {
    const suma = ORDEN_ROLES.reduce((a, role) => a + RANGO_ROL[role].maxMs, 0)
    expect(suma + ENTRADILLA_MS).toBeLessThanOrEqual(CLIP_MAX_MS)
  })
})

describe('dentroDeBanda', () => {
  it('marca los bordes correctos', () => {
    expect(dentroDeBanda(CLIP_MIN_MS)).toBe(true)
    expect(dentroDeBanda(CLIP_MAX_MS)).toBe(true)
    expect(dentroDeBanda(CLIP_MIN_MS - 1)).toBe(false)
    expect(dentroDeBanda(CLIP_MAX_MS + 1)).toBe(false)
  })
})
