/**
 * Prohibida la crítica estética generada por IA (D6).
 *
 * No es pudor: es que el juicio estético de un modelo correlaciona 0.194 con la
 * calidad real, contra 0.556 de un humano, y la similitud semántica entre las
 * dos críticas es 0.046 — ni siquiera están mirando lo mismo. El riesgo es de
 * contagio: un hallazgo que suena a opinión genérica hace que el usuario dude
 * también de los de seguridad, que sí son sólidos.
 *
 * Este test corre el detector sobre el catálogo entero y sobre todo hallazgo que
 * los chequeos lleguen a emitir, para que la regla no dependa de que alguien se
 * acuerde al escribir el chequeo número 41.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { CATALOGO } from '@/content/catalogo'
import { detectarCriticaEstetica } from '@/server/checks/lib/estetica'
import { CHEQUEOS } from '@/server/checks/registry'
import type { Check } from '@/server/checks/lib/context'
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

const CAMPOS = ['titlePlain', 'explanationPlain', 'impactPlain', 'fixPrompt'] as const

describe('el detector de crítica estética', () => {
  it('reconoce las frases que no queremos ver nunca', () => {
    const prohibidas = [
      'Mejorá la jerarquía visual de la pantalla',
      'Usá más espacio en blanco entre las secciones',
      'Los colores no combinan bien',
      'El diseño se ve anticuado',
      'La interfaz quedaría mejor si usaras otra tipografía',
      'Falta armonía visual',
      'El sitio necesita un aspecto moderno',
      'La elección de fuente es poco atractiva',
    ]
    for (const frase of prohibidas) {
      expect(detectarCriticaEstetica(frase), `no detectó: "${frase}"`).not.toEqual([])
    }
  })

  it('no confunde con hallazgos objetivos, que sí se reportan', () => {
    const permitidas = [
      // Medible con una revisión automática: es un número, no un gusto.
      'Hay texto que no se distingue del fondo',
      'Arreglalos uno por uno empezando por los de contraste',
      // Consistencia verificable, no preferencia.
      'Que use el mismo diseño que el resto de la app',
      'El banner tiene que tener "Aceptar" y "Rechazar" con el mismo peso visual',
      // Medición pura.
      'La pantalla se puede arrastrar para la derecha: hay contenido que no entra',
      'Agregá un diálogo de confirmación con el botón de confirmar en rojo',
      'Hay campos que solo tienen texto de ejemplo adentro',
      'Quedó un texto de ejemplo que nunca se reemplazó',
    ]
    for (const frase of permitidas) {
      expect(
        detectarCriticaEstetica(frase),
        `marcó como estético algo objetivo: "${frase}"`,
      ).toEqual([])
    }
  })
})

describe('nada del catálogo emite juicio estético', () => {
  it('ningún texto visible del catálogo', () => {
    const problemas: string[] = []

    for (const entrada of CATALOGO) {
      for (const campo of CAMPOS) {
        for (const hallada of detectarCriticaEstetica(entrada[campo])) {
          problemas.push(`${entrada.id} · ${campo} → "${hallada.frase}" (${hallada.porque})`)
        }
      }
    }

    expect(problemas, `hay crítica estética en el catálogo:\n${problemas.join('\n')}`).toEqual([])
  })
})

describe('ningún chequeo emite juicio estético', () => {
  const repos: string[] = []

  afterAll(async () => {
    for (const repo of repos) await borrarProyecto(repo)
  })

  it('ni en los textos ni en la evidencia de lo que emite', async () => {
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

    const problemas: string[] = []
    let emitidos = 0

    for (const check of CHEQUEOS as Check[]) {
      for (const draft of await check.run(ctx)) {
        emitidos++
        for (const campo of CAMPOS) {
          for (const hallada of detectarCriticaEstetica(draft[campo])) {
            problemas.push(`${check.id} · ${campo} → "${hallada.frase}"`)
          }
        }
        for (const evidencia of draft.evidence) {
          const nuestro =
            'detail' in evidencia
              ? evidencia.detail
              : 'caption' in evidencia
                ? evidencia.caption
                : ''
          for (const hallada of detectarCriticaEstetica(nuestro)) {
            problemas.push(`${check.id} · evidencia → "${hallada.frase}"`)
          }
        }
      }
    }

    expect(emitidos, 'no se emitió nada; el test no probaría nada').toBeGreaterThan(5)
    expect(problemas, `hay crítica estética en hallazgos:\n${problemas.join('\n')}`).toEqual([])
  })

  it('ningún chequeo del pilar de completitud es de diseño', () => {
    /**
     * El pilar se llama "Funciona completo" y no "UX/Diseño" justamente por
     * esto. Cada chequeo de acá tiene que ser binario y medible.
     */
    const deCompletitud = (CHEQUEOS as Check[]).filter((c) => c.pillar === 'completeness')
    const objetivos = new Set([
      'cmp.no_account_deletion',
      'cmp.no_password_reset',
      'cmp.no_logout',
      'cmp.no_email_verification',
      'cmp.destructive_no_confirm',
      'cmp.no_loading_state',
      'cmp.no_empty_state',
      'cmp.no_error_state',
      'cmp.form_no_validation',
      'cmp.form_no_labels',
      'cmp.placeholder_left',
      'cmp.broken_links',
      'cmp.no_404_page',
      'cmp.horizontal_overflow',
      'cmp.a11y_axe',
      'cmp.flow_blocked',
    ])

    for (const check of deCompletitud) {
      expect(
        objetivos.has(check.id),
        `${check.id} no está en la lista de chequeos objetivos del pilar`,
      ).toBe(true)
    }
    expect(deCompletitud).toHaveLength(objetivos.size)
  })
})
