/**
 * Cero jerga en lo que lee el usuario.
 *
 * El usuario de caughtcode construyó su app con un asistente y no sabe qué es
 * una regla de acceso a nivel de fila. Si el hallazgo se lo dice en jerga, no
 * puede actuar, y un hallazgo sobre el que no se puede actuar no vale nada.
 *
 * ── La excepción, y por qué existe ───────────────────────────────────────
 * `fixPrompt` **no** es texto explicativo: es el prompt que el usuario copia y
 * pega en Claude Code o Cursor. Su destinatario real es un asistente de código,
 * para el que "RLS" es el término correcto y "las reglas que definen quién puede
 * ver qué" sería ambiguo.
 *
 * Igual no se exime el campo entero: se fija la lista exacta de excepciones que
 * hay hoy. Si alguien mete jerga en un cuarto prompt, este test se pone rojo y
 * hay que justificarlo.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { CATALOGO } from '@/content/catalogo'
import { detectarJerga } from '@/content/lenguaje'
import type { FindingDraft } from '@/lib/types/domain'
import { CHEQUEOS } from '@/server/checks/registry'
import type { Check } from '@/server/checks/lib/context'
import { CATEGORIA_TEXTO, TRACKERS } from '@/server/checks/trackers'
import { INSUMO_BENEFICIO, INSUMO_FALTANTE } from '@/server/checks/registry'
import {
  agenteConProblemas,
  contextoDe,
  ESQUEMA_CON_PROBLEMAS,
  ruta,
  sondaFalsa,
} from '../fixtures/checks/contexto'
import {
  borrarProyecto,
  crearProyecto,
  PROYECTO_BORRAR_SIN_CONFIRMAR,
  PROYECTO_CATCH_VACIO,
  PROYECTO_ENV_VERSIONADO,
  PROYECTO_SERVICE_ROLE_EN_CLIENTE,
} from '../fixtures/checks/proyectos'

/** Campos que el usuario lee como explicación. Sin excepciones. */
const CAMPOS_EXPLICATIVOS = ['titlePlain', 'explanationPlain', 'impactPlain'] as const

/**
 * Jerga aceptada en los prompts de arreglo, con su motivo.
 * Cualquier cosa fuera de esta lista rompe el test a propósito.
 */
const JERGA_ACEPTADA_EN_PROMPTS: Record<string, string[]> = {
  'sec.rls_disabled': ['RLS'],
  'sec.rls_permissive': ['JWT'],
  'sec.rls_not_forced': ['RLS'],
}

describe('el catálogo no le habla al usuario en jerga', () => {
  it('ningún título, explicación ni impacto tiene jerga', () => {
    const problemas: string[] = []

    for (const entrada of CATALOGO) {
      for (const campo of CAMPOS_EXPLICATIVOS) {
        const jerga = detectarJerga(entrada[campo])
        if (jerga.length > 0) {
          problemas.push(`${entrada.id} · ${campo} → ${jerga.join(', ')}`)
        }
      }
    }

    expect(problemas, `hay jerga en texto explicativo:\n${problemas.join('\n')}`).toEqual([])
  })

  it('los prompts de arreglo solo tienen la jerga aceptada, y ninguna más', () => {
    const encontrada: Record<string, string[]> = {}

    for (const entrada of CATALOGO) {
      const jerga = detectarJerga(entrada.fixPrompt)
      if (jerga.length > 0) encontrada[entrada.id] = jerga
    }

    expect(encontrada).toEqual(JERGA_ACEPTADA_EN_PROMPTS)
  })
})

describe('los textos de los chequeos tampoco tienen jerga', () => {
  const repos: string[] = []

  afterAll(async () => {
    for (const repo of repos) await borrarProyecto(repo)
  })

  it('ningún hallazgo emitido le habla al usuario en jerga', async () => {
    const repo = await crearProyecto({
      ...PROYECTO_ENV_VERSIONADO,
      ...PROYECTO_SERVICE_ROLE_EN_CLIENTE,
      ...PROYECTO_CATCH_VACIO,
      ...PROYECTO_BORRAR_SIN_CONFIRMAR,
    })
    repos.push(repo)

    const ctx = contextoDe(repo, {
      dbSchema: ESQUEMA_CON_PROBLEMAS,
      deployedUrl: 'https://miapp.com',
      agent: agenteConProblemas(),
      http: sondaFalsa().probe,
      rutas: [ruta('/', 'app/page.tsx'), ruta('/proyectos', 'app/proyectos/lista.tsx')],
    })

    const emitidos: Array<{ checkId: string; draft: FindingDraft }> = []
    for (const check of CHEQUEOS as Check[]) {
      for (const draft of await check.run(ctx)) emitidos.push({ checkId: check.id, draft })
    }
    expect(emitidos.length, 'no se emitió nada; el test no probaría nada').toBeGreaterThan(5)

    const problemas: string[] = []
    for (const { checkId, draft } of emitidos) {
      for (const campo of CAMPOS_EXPLICATIVOS) {
        const jerga = detectarJerga(draft[campo])
        if (jerga.length > 0) problemas.push(`${checkId} · ${campo} → ${jerga.join(', ')}`)
      }
    }

    expect(problemas, `hay jerga en hallazgos emitidos:\n${problemas.join('\n')}`).toEqual([])
  })

  it('los detalles de la evidencia tampoco', async () => {
    const repo = await crearProyecto({
      ...PROYECTO_ENV_VERSIONADO,
      ...PROYECTO_CATCH_VACIO,
    })
    repos.push(repo)

    const ctx = contextoDe(repo, {
      dbSchema: ESQUEMA_CON_PROBLEMAS,
      deployedUrl: 'https://miapp.com',
      agent: agenteConProblemas(),
      http: sondaFalsa().probe,
    })

    const problemas: string[] = []
    for (const check of CHEQUEOS as Check[]) {
      for (const draft of await check.run(ctx)) {
        for (const evidencia of draft.evidence) {
          // El `snippet` es código del usuario citado tal cual: puede decir lo
          // que quiera. Lo que escribimos nosotros es `detail` y `caption`.
          const nuestro =
            'detail' in evidencia
              ? evidencia.detail
              : 'caption' in evidencia
                ? evidencia.caption
                : ''
          const jerga = detectarJerga(nuestro)
          if (jerga.length > 0) {
            problemas.push(`${check.id} · evidencia ${evidencia.kind} → ${jerga.join(', ')}`)
          }
        }
      }
    }

    expect(problemas, `hay jerga en evidencia:\n${problemas.join('\n')}`).toEqual([])
  })
})

describe('los textos fijos de este frente', () => {
  it('lo que se le dice al usuario sobre lo que no se revisó está en castellano llano', () => {
    for (const texto of [...Object.values(INSUMO_FALTANTE), ...Object.values(INSUMO_BENEFICIO)]) {
      expect(detectarJerga(texto), `"${texto}"`).toEqual([])
    }
  })

  /**
   * Marcas cuyo nombre real **es** un dominio. No es que hayamos puesto el host
   * por vagancia: la empresa se llama así. Escribir "Tawk" sería inventarle un
   * nombre que nadie usa.
   */
  const MARCAS_QUE_SON_DOMINIO = new Set(['Tawk.to'])

  it('los servicios de seguimiento se nombran como los conoce una persona', () => {
    for (const tracker of TRACKERS) {
      // El nombre visible nunca es un dominio, salvo que la marca sea eso.
      if (!MARCAS_QUE_SON_DOMINIO.has(tracker.nombre)) {
        expect(
          /^[a-z0-9-]+\.(com|net|io|ms|to|is|chat|cloud|org)$/i.test(tracker.nombre),
          `"${tracker.nombre}" es un dominio, no un nombre legible`,
        ).toBe(false)
      }
      expect(tracker.nombre.length).toBeGreaterThan(2)
      expect(tracker.hosts.length).toBeGreaterThan(0)
    }

    for (const texto of Object.values(CATEGORIA_TEXTO)) {
      expect(detectarJerga(texto), `"${texto}"`).toEqual([])
    }
  })
})
