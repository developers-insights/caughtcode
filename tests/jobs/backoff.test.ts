import { describe, expect, it } from 'vitest'

import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  computeBackoffMs,
  isLastAttempt,
  nextRunAfter,
} from '@/server/jobs/backoff'

describe('backoff exponencial', () => {
  it('duplica la espera en cada intento', () => {
    expect(computeBackoffMs(0)).toBe(30_000)
    expect(computeBackoffMs(1)).toBe(60_000)
    expect(computeBackoffMs(2)).toBe(120_000)
    expect(computeBackoffMs(3)).toBe(240_000)
    expect(computeBackoffMs(4)).toBe(480_000)
  })

  it('no pasa de 15 minutos', () => {
    expect(computeBackoffMs(5)).toBe(MAX_BACKOFF_MS)
    expect(computeBackoffMs(6)).toBe(MAX_BACKOFF_MS)
    expect(computeBackoffMs(50)).toBe(MAX_BACKOFF_MS)
    // Sin el techo del exponente, 2 ** 5000 daría Infinity.
    expect(Number.isFinite(computeBackoffMs(5000))).toBe(true)
  })

  it('trata valores raros como el primer intento', () => {
    expect(computeBackoffMs(-3)).toBe(BASE_BACKOFF_MS)
    expect(computeBackoffMs(Number.NaN)).toBe(BASE_BACKOFF_MS)
    expect(computeBackoffMs(1.9)).toBe(60_000)
  })

  it('el jitter se mantiene dentro del rango pedido', () => {
    const alto = computeBackoffMs(2, { jitterRatio: 0.2, random: () => 1 })
    const bajo = computeBackoffMs(2, { jitterRatio: 0.2, random: () => 0 })
    const medio = computeBackoffMs(2, { jitterRatio: 0.2, random: () => 0.5 })

    expect(alto).toBe(144_000) // 120s + 20%
    expect(bajo).toBe(96_000) // 120s - 20%
    expect(medio).toBe(120_000)
  })

  it('nextRunAfter devuelve un ISO en el futuro', () => {
    const ahora = new Date('2026-08-09T12:00:00.000Z')
    expect(nextRunAfter(1, {}, ahora)).toBe('2026-08-09T12:01:00.000Z')
  })

  it('sabe cuándo se acabaron los intentos', () => {
    expect(isLastAttempt(2, 3)).toBe(false)
    expect(isLastAttempt(3, 3)).toBe(true)
    expect(isLastAttempt(4, 3)).toBe(true)
  })
})
