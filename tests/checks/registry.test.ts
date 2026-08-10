/**
 * El registro tiene que corresponderse exactamente con el catálogo.
 *
 * Un chequeo con un id que no existe en el catálogo explota recién cuando
 * dispara, o sea en producción y sobre el proyecto de alguien. Acá se detecta
 * al escribirlo.
 */

import { describe, it, expect } from 'vitest'
import { CATALOGO, CATALOGO_POR_ID } from '@/content/catalogo'
import {
  CHEQUEOS,
  CHEQUEOS_COMPLETITUD,
  CHEQUEOS_SEGURIDAD,
  CHEQUEOS_TIENDA,
  esAplicable,
  faltantes,
} from '@/server/checks/registry'
import type { Check } from '@/server/checks/lib/context'

describe('registro de chequeos', () => {
  it('no hay ids repetidos', () => {
    const ids = (CHEQUEOS as Check[]).map((c) => c.id)
    expect(new Set(ids).size, `hay ids repetidos en ${ids.join(', ')}`).toBe(ids.length)
  })

  it('todo chequeo existe en el catálogo, con el mismo pilar y los mismos insumos', () => {
    for (const check of CHEQUEOS as Check[]) {
      const entrada = CATALOGO_POR_ID.get(check.id)
      expect(entrada, `el chequeo "${check.id}" no existe en el catálogo`).toBeDefined()
      expect(check.pillar, `${check.id}: pilar distinto al del catálogo`).toBe(entrada!.pillar)
      expect(
        [...check.requires].sort(),
        `${check.id}: insumos distintos a los del catálogo`,
      ).toEqual([...entrada!.requires].sort())
    }
  })

  it('todo el catálogo está implementado: ninguna entrada quedó sin chequeo', () => {
    const implementados = new Set((CHEQUEOS as Check[]).map((c) => c.id))
    const sinImplementar = CATALOGO.filter((e) => !implementados.has(e.id)).map((e) => e.id)
    expect(sinImplementar, `faltan chequeos para: ${sinImplementar.join(', ')}`).toEqual([])
  })

  it('los tres pilares suman el total y ninguno se solapa', () => {
    expect(CHEQUEOS_SEGURIDAD).toHaveLength(17)
    expect(CHEQUEOS_COMPLETITUD).toHaveLength(16)
    expect(CHEQUEOS_TIENDA).toHaveLength(7)
    expect(CHEQUEOS).toHaveLength(40)
    expect(CHEQUEOS).toHaveLength(CATALOGO.length)

    for (const check of CHEQUEOS_SEGURIDAD) expect(check.pillar).toBe('security')
    for (const check of CHEQUEOS_COMPLETITUD) expect(check.pillar).toBe('completeness')
    for (const check of CHEQUEOS_TIENDA) expect(check.pillar).toBe('store_hygiene')
  })

  it('cada chequeo declara al menos un insumo y ninguno inventado', () => {
    const validos = new Set(['code', 'database', 'deployed_app'])
    for (const check of CHEQUEOS as Check[]) {
      expect(check.requires.length, `${check.id} no declara insumos`).toBeGreaterThan(0)
      for (const insumo of check.requires) {
        expect(validos.has(insumo), `${check.id} pide un insumo inventado: ${insumo}`).toBe(true)
      }
      expect(typeof check.run, `${check.id} no tiene run`).toBe('function')
      expect(check.name.length, `${check.id} no tiene nombre interno`).toBeGreaterThan(0)
    }
  })
})

describe('filtro de insumos', () => {
  const soloCodigo = { code: true, database: false, deployed_app: false }
  const todo = { code: true, database: true, deployed_app: true }

  it('con solo el código, los de base quedan afuera y se sabe qué falta', () => {
    const deBase = (CHEQUEOS as Check[]).filter((c) => c.requires.includes('database'))
    expect(deBase.length).toBeGreaterThan(0)

    for (const check of deBase) {
      expect(esAplicable(check, soloCodigo)).toBe(false)
      expect(faltantes(check, soloCodigo)).toContain('database')
    }
  })

  it('con todo conectado, corren los cuarenta', () => {
    for (const check of CHEQUEOS as Check[]) {
      expect(esAplicable(check, todo), `${check.id} no es aplicable con todo conectado`).toBe(true)
      expect(faltantes(check, todo)).toEqual([])
    }
  })

  it('sin nada, no corre ninguno', () => {
    const nada = { code: false, database: false, deployed_app: false }
    for (const check of CHEQUEOS as Check[]) {
      expect(esAplicable(check, nada)).toBe(false)
    }
  })
})
