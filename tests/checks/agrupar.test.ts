/**
 * Agrupación de repeticiones.
 *
 * El caso real que originó esto: una auditoría devolvió 180 hallazgos que eran
 * ~10 problemas repetidos. 36 de ellos eran la misma tabla sin forzar, en 36
 * tablas. Con eso, los seis primeros puestos del ranking los ocupaba el mismo
 * problema seis veces y el usuario no llegaba nunca a los otros nueve.
 *
 * Lo que se prueba acá:
 *   1. N repeticiones del mismo chequeo salen como 1 hallazgo con N ocurrencias
 *   2. **no se pierde la evidencia de ninguna** (regla dura #1)
 *   3. hay chequeos donde cada caso es su propio problema y NO se agrupan
 *   4. el ranking se calcula sobre problemas distintos
 *   5. los tres destacados son tres problemas distintos
 */

import { describe, it, expect } from 'vitest'
import type { Evidence, FindingDraft } from '@/lib/types/domain'
import {
  agrupar,
  claveDeAgrupacion,
  SIEMPRE_INDIVIDUAL,
  type HallazgoUnificado,
} from '@/server/checks/agrupar'
import { deduplicar, rankear } from '@/server/checks/runner'
import { CHEQUEOS_POR_ID } from '@/server/checks/registry'

/* ── Ayudas ───────────────────────────────────────────────────────────── */

function unificado(
  parcial: Partial<HallazgoUnificado> & { checkId: string },
): HallazgoUnificado {
  return {
    pillar: 'security',
    severity: 'high',
    confidence: 'confirmed',
    titlePlain: `Título de ${parcial.checkId}`,
    explanationPlain: 'Explicación.',
    impactPlain: 'Impacto.',
    fixPrompt: 'Arreglalo.',
    evidence: [{ kind: 'code', file: 'app/page.tsx', line: 1 }],
    detectadoPor: [parcial.checkId],
    ...parcial,
  }
}

/** N tablas sin forzar: el caso de los 36. */
function tablasSinForzar(nombres: string[]): HallazgoUnificado[] {
  return nombres.map((tabla) =>
    unificado({
      checkId: 'sec.rls_not_forced',
      titlePlain: `Las reglas de ${tabla} se pueden saltear`,
      explanationPlain: `La tabla ${tabla} tiene reglas activadas pero no forzadas.`,
      fixPrompt: `alter table public.${tabla} force row level security;`,
      evidence: [
        { kind: 'database', object: `public.${tabla}`, detail: `Reglas activadas, sin forzar.` },
      ],
    }),
  )
}

function clavesDeEvidencia(evidence: Evidence[]): string[] {
  return evidence.map((e) => JSON.stringify(e))
}

/* ── 1. Se agrupa lo repetido ─────────────────────────────────────────── */

describe('36 repeticiones del mismo chequeo son un hallazgo', () => {
  const nombres = Array.from({ length: 36 }, (_, i) => `tabla_${String(i).padStart(2, '0')}`)

  it('sale una sola fila con 36 ocurrencias', () => {
    const agrupados = agrupar(tablasSinForzar(nombres))

    expect(agrupados).toHaveLength(1)
    expect(agrupados[0]!.ocurrencias).toBe(36)
    expect(agrupados[0]!.lugares).toHaveLength(36)
  })

  it('no se pierde la evidencia de ninguna de las 36', () => {
    const entrada = tablasSinForzar(nombres)
    const esperadas = new Set(entrada.flatMap((h) => clavesDeEvidencia(h.evidence)))

    const [agrupado] = agrupar(entrada)
    const quedaron = new Set(clavesDeEvidencia(agrupado!.evidence))

    expect(quedaron.size).toBe(esperadas.size)
    for (const clave of esperadas) expect(quedaron.has(clave)).toBe(true)
  })

  it('los 36 lugares quedan nombrados, no solo contados', () => {
    const [agrupado] = agrupar(tablasSinForzar(nombres))
    for (const tabla of nombres) {
      expect(agrupado!.lugares).toContain(`public.${tabla}`)
    }
  })

  it('el título dice la magnitud: no puede leerse como un caso suelto', () => {
    const [agrupado] = agrupar(tablasSinForzar(nombres))
    const suelto = tablasSinForzar(['una_sola'])[0]!

    expect(agrupado!.titlePlain).not.toBe(suelto.titlePlain)
    expect(agrupado!.titlePlain).toMatch(/35|36/)
  })

  it('queda un solo prompt de arreglo, y sirve para todos los casos', () => {
    const [agrupado] = agrupar(tablasSinForzar(nombres))
    for (const tabla of nombres) {
      expect(agrupado!.fixPrompt).toContain(`public.${tabla}`)
    }
  })

  it('no inventa marcadores sin completar en el texto que ve el usuario', () => {
    const [agrupado] = agrupar(tablasSinForzar(nombres))
    for (const texto of [
      agrupado!.titlePlain,
      agrupado!.explanationPlain,
      agrupado!.impactPlain,
      agrupado!.fixPrompt,
    ]) {
      expect(texto).not.toMatch(/\{\{\w+\}\}/)
    }
  })

  it('un caso único pasa intacto: mismo título, una ocurrencia', () => {
    const solo = tablasSinForzar(['nada_mas'])
    const [agrupado] = agrupar(solo)

    expect(agrupado!.ocurrencias).toBe(1)
    expect(agrupado!.titlePlain).toBe(solo[0]!.titlePlain)
    expect(agrupado!.fixPrompt).toBe(solo[0]!.fixPrompt)
  })

  it('junta la constancia de qué chequeos lo detectaron', () => {
    const agrupados = agrupar([
      unificado({
        checkId: 'sec.rls_not_forced',
        detectadoPor: ['sec.rls_not_forced'],
        evidence: [{ kind: 'database', object: 'public.a', detail: 'd' }],
      }),
      unificado({
        checkId: 'sec.rls_not_forced',
        detectadoPor: ['sec.rls_not_forced', 'sec.rls_disabled'],
        evidence: [{ kind: 'database', object: 'public.b', detail: 'd' }],
      }),
    ])

    expect(agrupados[0]!.detectadoPor).toEqual(['sec.rls_disabled', 'sec.rls_not_forced'])
  })

  it('el resultado no depende del orden de entrada', () => {
    const entrada = tablasSinForzar(nombres)
    const uno = agrupar(entrada)[0]!
    const dos = agrupar([...entrada].reverse())[0]!

    expect(dos.titlePlain).toBe(uno.titlePlain)
    expect(dos.lugares).toEqual(uno.lugares)
    expect(dos.fixPrompt).toBe(uno.fixPrompt)
  })
})

/* ── 2. Cuándo NO se agrupa ───────────────────────────────────────────── */

describe('hay casos donde cada uno es su propio problema', () => {
  it('dos severidades distintas del mismo chequeo no se mezclan', () => {
    const agrupados = agrupar([
      unificado({
        checkId: 'sec.no_rate_limit',
        severity: 'critical',
        evidence: [{ kind: 'http', url: 'https://x.com/login', status: 200, detail: 'd' }],
      }),
      unificado({
        checkId: 'sec.no_rate_limit',
        severity: 'medium',
        evidence: [{ kind: 'http', url: 'https://x.com/contacto', status: 200, detail: 'd' }],
      }),
    ])

    expect(agrupados).toHaveLength(2)
    expect(agrupados.every((a) => a.ocurrencias === 1)).toBe(true)
  })

  it('no se mete un "a revisar" abajo del título de algo comprobado', () => {
    const agrupados = agrupar([
      unificado({
        checkId: 'cmp.no_empty_state',
        confidence: 'confirmed',
        evidence: [{ kind: 'code', file: 'app/a.tsx', line: 1 }],
      }),
      unificado({
        checkId: 'cmp.no_empty_state',
        confidence: 'to_review',
        evidence: [{ kind: 'code', file: 'app/b.tsx', line: 1 }],
      }),
    ])

    expect(agrupados).toHaveLength(2)
  })

  it('cada credencial expuesta es su propio incidente', () => {
    const agrupados = agrupar([
      unificado({
        checkId: 'sec.secret_in_repo',
        severity: 'critical',
        evidence: [{ kind: 'code', file: 'app/a.ts', line: 3 }],
      }),
      unificado({
        checkId: 'sec.secret_in_repo',
        severity: 'critical',
        evidence: [{ kind: 'code', file: 'app/b.ts', line: 9 }],
      }),
    ])

    expect(agrupados).toHaveLength(2)
    expect(claveDeAgrupacion(agrupados[0]!)).toBeNull()
  })

  it('lo que el agente grabó no se agrupa: la grabación es de ese caso', () => {
    const grabacion = (id: string): Evidence => ({
      kind: 'recording',
      agentSessionId: id,
      startMs: 0,
      endMs: 9000,
      caption: 'c',
    })

    const agrupados = agrupar([
      unificado({ checkId: 'cmp.flow_blocked', evidence: [grabacion('signup')] }),
      unificado({ checkId: 'cmp.flow_blocked', evidence: [grabacion('primary_flow')] }),
    ])

    expect(agrupados).toHaveLength(2)
  })

  it('los chequeos marcados como individuales existen de verdad', () => {
    for (const id of SIEMPRE_INDIVIDUAL) {
      expect(CHEQUEOS_POR_ID.has(id), `${id} no está en el registro`).toBe(true)
    }
  })
})

/* ── 3. El ranking se calcula sobre problemas distintos ───────────────── */

describe('el ranking deja de estar tomado por una repetición', () => {
  /**
   * El caso real, en miniatura. En la auditoría de verdad los seis primeros
   * puestos los ocupaba `sec.rls_permissive` seis veces: era el único chequeo
   * crítico, y tenía seis tablas.
   */
  function corridaReal(): HallazgoUnificado[] {
    const repetido = Array.from({ length: 6 }, (_, i) =>
      unificado({
        checkId: 'sec.rls_permissive',
        severity: 'critical',
        titlePlain: 'Un usuario puede ver los datos de otro',
        evidence: [{ kind: 'database', object: `public.tabla_${i}`, detail: 'd' }],
      }),
    )
    const otros = [
      unificado({
        checkId: 'sec.public_bucket',
        severity: 'high',
        titlePlain: 'Tus archivos están abiertos',
        evidence: [{ kind: 'database', object: 'storage.avatars', detail: 'd' }],
      }),
      unificado({
        checkId: 'sec.pii_in_logs',
        severity: 'high',
        titlePlain: 'Guardás datos personales en los registros',
        evidence: [{ kind: 'code', file: 'app/api/x/route.ts', line: 4 }],
      }),
      unificado({
        checkId: 'cmp.destructive_no_confirm',
        pillar: 'completeness',
        severity: 'high',
        titlePlain: 'El botón Eliminar borra sin preguntar',
        evidence: [{ kind: 'code', file: 'app/lista.tsx', line: 20 }],
      }),
    ]
    return [...repetido, ...otros]
  }

  it('los tres destacados son tres problemas distintos', () => {
    const findings = rankear(agrupar(corridaReal()))
    const destacados = findings.filter((f) => f.rank <= 3)

    expect(destacados).toHaveLength(3)
    expect(new Set(destacados.map((f) => f.checkId)).size).toBe(3)
  })

  it('sin agrupar, los tres destacados eran el mismo problema tres veces', () => {
    // La prueba de que esto hacía falta.
    const sinAgrupar = rankear(
      corridaReal().map((h) => ({ ...h, ocurrencias: 1, lugares: ['x'] })),
    )
    const destacados = sinAgrupar.filter((f) => f.rank <= 3)
    expect(new Set(destacados.map((f) => f.checkId)).size).toBe(1)
  })

  it('a igualdad de todo lo demás, primero el que aparece en más lugares', () => {
    const findings = rankear([
      { ...unificado({ checkId: 'sec.aa' }), ocurrencias: 1, lugares: ['a'] },
      { ...unificado({ checkId: 'sec.zz' }), ocurrencias: 12, lugares: ['b'] },
    ])
    expect(findings[0]!.checkId).toBe('sec.zz')
  })

  it('la agrupación va después de la deduplicación, no antes', () => {
    // Dos chequeos equivalentes sobre el mismo hecho: primero se unifican en
    // uno, y recién entonces se cuenta como una sola ocurrencia.
    const grabacion: Evidence = {
      kind: 'recording',
      agentSessionId: 'delete_account',
      startMs: 0,
      endMs: 1,
      caption: 'c',
    }
    const agrupados = agrupar(
      deduplicar([
        unificado({ checkId: 'cmp.no_account_deletion', evidence: [grabacion] }),
        unificado({ checkId: 'sto.no_account_deletion', evidence: [grabacion] }),
      ]),
    )

    expect(agrupados).toHaveLength(1)
    expect(agrupados[0]!.ocurrencias).toBe(1)
  })
})
