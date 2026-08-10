import { describe, expect, it } from 'vitest'

import { FrenoDeFallas } from '@/server/jobs/circuit'

describe('FrenoDeFallas', () => {
  it('no frena mientras las cosas salen bien', () => {
    const freno = new FrenoDeFallas()
    for (let i = 0; i < 50; i += 1) freno.exito()
    expect(freno.esperaMs()).toBe(0)
    expect(freno.seguidas).toBe(0)
  })

  it('aguanta unas pocas fallas sueltas sin frenar', () => {
    const freno = new FrenoDeFallas({ tolerancia: 3, baseMs: 2000, maxMs: 60_000 })
    freno.falla()
    freno.falla()
    expect(freno.esperaMs()).toBe(0)
  })

  it('a partir de la tolerancia espera cada vez más, con techo', () => {
    const freno = new FrenoDeFallas({ tolerancia: 3, baseMs: 2000, maxMs: 30_000 })
    freno.falla()
    freno.falla()
    freno.falla()
    expect(freno.esperaMs()).toBe(2000)
    freno.falla()
    expect(freno.esperaMs()).toBe(4000)
    freno.falla()
    expect(freno.esperaMs()).toBe(8000)
    for (let i = 0; i < 20; i += 1) freno.falla()
    expect(freno.esperaMs()).toBe(30_000)
  })

  it('un éxito borra la cuenta y suelta el freno', () => {
    const freno = new FrenoDeFallas({ tolerancia: 2, baseMs: 1000 })
    freno.falla()
    freno.falla()
    freno.falla()
    expect(freno.esperaMs()).toBeGreaterThan(0)

    freno.exito()
    expect(freno.seguidas).toBe(0)
    expect(freno.esperaMs()).toBe(0)
  })

  it('avisa una sola vez por tanda de fallas, para no inundar el log', () => {
    const freno = new FrenoDeFallas({ tolerancia: 1, baseMs: 1000 })
    freno.falla()
    expect(freno.debeAvisar()).toBe(true)
    expect(freno.debeAvisar()).toBe(false)

    freno.exito()
    freno.falla()
    expect(freno.debeAvisar()).toBe(true)
  })
})
