/**
 * Un hallazgo nunca puede filtrar el secreto que denuncia.
 *
 * La evidencia viaja a la base, a la pantalla y a la narración del video. Si el
 * valor crudo entra ahí, lo acabamos de publicar en tres lugares más que el
 * repositorio donde estaba. Este test recorre TODO el texto que sale de un
 * hallazgo y exige que el valor no aparezca en ninguna parte.
 *
 * El otro lado de la misma moneda: la llave pública de Supabase (`anon`) es
 * pública a propósito. Denunciarla sería el falso positivo de manual, y en un
 * producto cuyo usuario no puede contrastar, un falso positivo de seguridad
 * cuesta más que un hallazgo perdido.
 */

import { describe, it, expect } from 'vitest'
import { CHEQUEOS } from '@/server/checks/registry'
import type { Check } from '@/server/checks/lib/context'
import {
  enmascarar,
  entropiaShannon,
  esJwtAnon,
  esJwtServiceRole,
  leerClaimsJwt,
  pareceSecreto,
} from '@/server/checks/lib/mask'
import { contextoDe } from '../fixtures/checks/contexto'
import {
  borrarProyecto,
  CLAVE_STRIPE,
  crearProyecto,
  jwtFalso,
  LLAVE_MAESTRA,
  LLAVE_PUBLICA,
  PROYECTO_ENV_VERSIONADO,
  PROYECTO_SERVICE_ROLE_EN_CLIENTE,
} from '../fixtures/checks/proyectos'

/** Todo el texto que un hallazgo puede llegar a mostrarle a alguien. */
function textoCompletoDe(draft: {
  titlePlain: string
  explanationPlain: string
  impactPlain: string
  fixPrompt: string
  evidence: Array<Record<string, unknown>>
}): string {
  const evidencia = draft.evidence
    .map((e) => Object.values(e).filter((v) => typeof v === 'string').join(' '))
    .join(' ')
  return [
    draft.titlePlain,
    draft.explanationPlain,
    draft.impactPlain,
    draft.fixPrompt,
    evidencia,
  ].join('\n')
}

describe('enmascarado', () => {
  it('deja ver el proveedor y los últimos cuatro, nada más', () => {
    expect(enmascarar(CLAVE_STRIPE)).toBe('sk_live_••••3456')
    expect(enmascarar(CLAVE_STRIPE)).not.toContain('51QwErTyUiOpAsDfGhJkLzXcVbNm')
  })

  it('un valor corto queda completamente tapado', () => {
    // Mostrar 4 de 12 caracteres es regalar un tercio de la clave.
    expect(enmascarar('sk_live_abc')).toBe('sk_live_••••')
    expect(enmascarar('corta')).toBe('••••')
    expect(enmascarar('')).toBe('••••')
  })

  it('nunca devuelve el valor original', () => {
    for (const valor of [CLAVE_STRIPE, LLAVE_MAESTRA, 'AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36)]) {
      expect(enmascarar(valor)).not.toBe(valor)
      expect(enmascarar(valor).length).toBeLessThan(valor.length)
    }
  })
})

describe('lectura de JWT', () => {
  it('distingue la llave maestra de la pública sin validar firma', () => {
    expect(esJwtServiceRole(LLAVE_MAESTRA)).toBe(true)
    expect(esJwtAnon(LLAVE_MAESTRA)).toBe(false)

    expect(esJwtAnon(LLAVE_PUBLICA)).toBe(true)
    expect(esJwtServiceRole(LLAVE_PUBLICA)).toBe(false)
  })

  it('no explota con basura', () => {
    for (const basura of ['', 'no.es.un.jwt', 'eyJ', 'a.b.c', 'eyJhbGciOiJIUzI1NiJ9']) {
      expect(() => leerClaimsJwt(basura)).not.toThrow()
    }
    expect(esJwtServiceRole('no.es.un.jwt')).toBe(false)
  })

  it('lee los claims de uno bien armado', () => {
    expect(leerClaimsJwt(jwtFalso({ role: 'authenticated', sub: 'abc' }))).toMatchObject({
      role: 'authenticated',
      sub: 'abc',
    })
  })
})

describe('heurística de entropía', () => {
  it('no marca como secreto lo que claramente no lo es', () => {
    const noSecretos = [
      'tu_clave_aca',
      'change_me',
      'localhost:5432',
      'https://abcdefgh.supabase.co',
      'este es un texto normal',
      'mi-variable-de-configuracion',
      'password123',
      'xxxxxxxxxxxxxxxxxx',
      '',
      'corto',
    ]
    for (const valor of noSecretos) {
      expect(pareceSecreto(valor), `marcó como secreto: "${valor}"`).toBe(false)
    }
  })

  it('sí marca lo que tiene forma de clave', () => {
    expect(pareceSecreto('Xk9mQz2LpR7vWn4TjB8sYd3FgH6cA1eU')).toBe(true)
    expect(entropiaShannon('aaaaaaaa')).toBe(0)
    expect(entropiaShannon('Xk9mQz2LpR7v')).toBeGreaterThan(3)
  })
})

describe('ningún hallazgo filtra el secreto que denuncia', () => {
  it('ni el valor completo ni un pedazo largo aparecen en el hallazgo', async () => {
    const repo = await crearProyecto({
      ...PROYECTO_ENV_VERSIONADO,
      ...PROYECTO_SERVICE_ROLE_EN_CLIENTE,
    })

    try {
      const ctx = contextoDe(repo)
      const emitidos: Array<{ checkId: string; texto: string }> = []

      for (const check of CHEQUEOS as Check[]) {
        for (const draft of await check.run(ctx)) {
          emitidos.push({
            checkId: check.id,
            texto: textoCompletoDe(draft as never),
          })
        }
      }

      expect(emitidos.length, 'no se emitió nada; el test no probaría nada').toBeGreaterThan(0)

      const secretos = [
        CLAVE_STRIPE,
        LLAVE_MAESTRA,
        'UnaClaveLargaDeVerdad9',
      ]

      for (const { checkId, texto } of emitidos) {
        for (const secreto of secretos) {
          expect(texto.includes(secreto), `${checkId} filtró un secreto entero`).toBe(false)

          // Tampoco un pedazo largo: 16 caracteres seguidos ya alcanzan para
          // reconstruir demasiado.
          const pedazo = secreto.slice(8, 24)
          if (pedazo.length >= 16) {
            expect(
              texto.includes(pedazo),
              `${checkId} filtró un pedazo de un secreto: "${pedazo}"`,
            ).toBe(false)
          }
        }
      }
    } finally {
      await borrarProyecto(repo)
    }
  })

  it('el hallazgo de clave en el código nombra el proveedor y muestra el valor tapado', async () => {
    const repo = await crearProyecto({
      'app/pagos.ts': `export const stripe = new Stripe('${CLAVE_STRIPE}')\n`,
    })

    try {
      const check = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.secret_in_repo')!
      const drafts = await check.run(contextoDe(repo))

      expect(drafts).toHaveLength(1)
      const draft = drafts[0]!

      expect(draft.explanationPlain).toContain('Stripe')
      expect(draft.explanationPlain).toContain('sk_live_••••3456')
      expect(draft.explanationPlain).not.toContain(CLAVE_STRIPE)

      // Y el fragmento de código citado también viene tapado.
      const snippet = draft.evidence.find((e) => e.kind === 'code') as { snippet?: string }
      expect(snippet.snippet).toBeDefined()
      expect(snippet.snippet).not.toContain(CLAVE_STRIPE)
      expect(snippet.snippet).toContain('••••')
    } finally {
      await borrarProyecto(repo)
    }
  })

  it('la llave pública de Supabase no se denuncia nunca', async () => {
    const repo = await crearProyecto({
      'app/cliente.tsx': [
        "'use client'",
        "import { createClient } from '@supabase/supabase-js'",
        `export const db = createClient('https://abcdefgh.supabase.co', '${LLAVE_PUBLICA}')`,
        '',
      ].join('\n'),
    })

    try {
      const ctx = contextoDe(repo)
      for (const id of ['sec.secret_in_repo', 'sec.service_role_in_client', 'sec.public_env_secret']) {
        const check = (CHEQUEOS as Check[]).find((c) => c.id === id)!
        const drafts = await check.run(ctx)
        expect(drafts, `${id} denunció la llave pública, que es pública a propósito`).toHaveLength(0)
      }
    } finally {
      await borrarProyecto(repo)
    }
  })

  it('la llave maestra en un archivo de navegador sí se denuncia', async () => {
    const repo = await crearProyecto(PROYECTO_SERVICE_ROLE_EN_CLIENTE)

    try {
      const check = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.service_role_in_client')!
      const drafts = await check.run(contextoDe(repo))

      expect(drafts.length).toBeGreaterThan(0)
      expect(drafts[0]!.severity).toBe('critical')
      expect(drafts[0]!.explanationPlain).toContain('app/panel/tabla.tsx')
      expect(textoCompletoDe(drafts[0]! as never)).not.toContain(LLAVE_MAESTRA)
    } finally {
      await borrarProyecto(repo)
    }
  })
})
