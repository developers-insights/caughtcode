/**
 * El invariante que sostiene el producto entero: **nada sin evidencia** (D14).
 *
 * No alcanza con probar que los chequeos detectan cosas. Hay que probar las dos
 * mitades, y la segunda es la que importa:
 *
 *   1. con un proyecto roto, los chequeos disparan **y todo lo que sale trae
 *      evidencia** — si no, el test sería vacío (cero hallazgos también cumple
 *      "ninguno sin evidencia")
 *   2. con un proyecto sano, no se inventa nada
 *
 * Se corre `check.run()` directo, salteando el filtro de insumos del motor, para
 * exigirle a cada chequeo que aguante que le falte lo que necesita: con contexto
 * pelado tiene que devolver `[]`, no explotar.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FindingDraft } from '@/lib/types/domain'
import { CHEQUEOS } from '@/server/checks/registry'
import type { Check, CheckRunContext } from '@/server/checks/lib/context'
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
  PROYECTO_SANO,
  PROYECTO_SERVICE_ROLE_EN_CLIENTE,
} from '../fixtures/checks/proyectos'

const MARCADOR = /\{\{\w+\}\}/

/** Revisa el invariante sobre un hallazgo suelto y explica bien si falla. */
function exigirEvidencia(checkId: string, draft: FindingDraft): void {
  expect(
    draft.evidence?.length ?? 0,
    `${checkId} emitió "${draft.titlePlain}" sin ninguna evidencia`,
  ).toBeGreaterThan(0)

  for (const campo of ['titlePlain', 'explanationPlain', 'impactPlain', 'fixPrompt'] as const) {
    expect(
      MARCADOR.test(draft[campo]),
      `${checkId} dejó un hueco sin completar en ${campo}: ${draft[campo].slice(0, 120)}`,
    ).toBe(false)
  }
}

async function correrTodos(ctx: CheckRunContext): Promise<Map<string, FindingDraft[]>> {
  const salida = new Map<string, FindingDraft[]>()
  for (const check of CHEQUEOS as Check[]) {
    const drafts = await check.run(ctx)
    salida.set(check.id, drafts)
  }
  return salida
}

describe('invariante: ningún hallazgo sale sin evidencia', () => {
  let repoRoto: string
  let repoSano: string

  beforeAll(async () => {
    repoRoto = await crearProyecto({
      ...PROYECTO_ENV_VERSIONADO,
      ...PROYECTO_SERVICE_ROLE_EN_CLIENTE,
      ...PROYECTO_CATCH_VACIO,
      ...PROYECTO_BORRAR_SIN_CONFIRMAR,
    })
    repoSano = await crearProyecto(PROYECTO_SANO)
  })

  afterAll(async () => {
    await borrarProyecto(repoRoto)
    await borrarProyecto(repoSano)
  })

  it('con un proyecto roto y todos los insumos, dispara y todo trae evidencia', async () => {
    const ctx = contextoDe(repoRoto, {
      dbSchema: ESQUEMA_CON_PROBLEMAS,
      deployedUrl: 'https://miapp.com',
      agent: agenteConProblemas(),
      http: sondaFalsa().probe,
      rutas: [
        ruta('/', 'app/page.tsx'),
        ruta('/panel', 'app/panel/tabla.tsx'),
        ruta('/proyectos', 'app/proyectos/lista.tsx'),
      ],
    })

    const porChequeo = await correrTodos(ctx)
    const todos = [...porChequeo.values()].flat()

    // Si no disparó nada, el invariante se cumple por vacío y no probamos nada.
    expect(todos.length, 'el proyecto roto no disparó ningún chequeo').toBeGreaterThan(5)

    const queDispararon = [...porChequeo].filter(([, d]) => d.length > 0).map(([id]) => id)
    expect(queDispararon.length, 'muy pocos chequeos distintos dispararon').toBeGreaterThan(5)

    for (const [checkId, drafts] of porChequeo) {
      for (const draft of drafts) exigirEvidencia(checkId, draft)
    }
  })

  it('con un proyecto sano, lo poco que salga también trae evidencia', async () => {
    const ctx = contextoDe(repoSano, {
      rutas: [
        ruta('/', 'app/page.tsx'),
        ruta('/privacidad', 'app/privacidad/page.tsx'),
        ruta('/terminos', 'app/terminos/page.tsx'),
        ruta('/proyectos', 'app/proyectos/lista.tsx'),
      ],
    })

    const porChequeo = await correrTodos(ctx)
    for (const [checkId, drafts] of porChequeo) {
      for (const draft of drafts) exigirEvidencia(checkId, draft)
    }
  })

  it('con el contexto pelado, ningún chequeo explota ni inventa hallazgos', async () => {
    const vacio = await crearProyecto({ 'README.md': '# nada\n' })
    try {
      const ctx = contextoDe(vacio)
      for (const check of CHEQUEOS as Check[]) {
        const drafts = await check.run(ctx)
        for (const draft of drafts) exigirEvidencia(check.id, draft)
      }
    } finally {
      await borrarProyecto(vacio)
    }
  })

  it('los chequeos que necesitan la base no inventan nada sin base', async () => {
    const ctx = contextoDe(repoRoto) // dbSchema queda en 'none'
    const deBase = (CHEQUEOS as Check[]).filter((c) => c.requires.includes('database'))
    expect(deBase.length).toBeGreaterThan(0)

    for (const check of deBase) {
      const drafts = await check.run(ctx)
      expect(drafts, `${check.id} inventó hallazgos sin base conectada`).toHaveLength(0)
    }
  })

  it('los chequeos que necesitan la app desplegada no inventan nada sin agente', async () => {
    const ctx = contextoDe(repoRoto) // sin deployedUrl, sin agent, sin http
    const deApp = (CHEQUEOS as Check[]).filter(
      (c) => c.requires.includes('deployed_app') && !c.requires.includes('code'),
    )
    expect(deApp.length).toBeGreaterThan(0)

    for (const check of deApp) {
      const drafts = await check.run(ctx)
      expect(drafts, `${check.id} inventó hallazgos sin app desplegada`).toHaveLength(0)
    }
  })
})

describe('los chequeos que sí tienen que disparar, disparan', () => {
  /**
   * Un chequeo que nunca dispara pasa el invariante de evidencia sin aportar
   * nada. Esto ancla los cinco casos de las fixtures a su chequeo.
   */
  const casos: Array<{
    fixture: Record<string, string>
    checkId: string
    porque: string
  }> = [
    {
      fixture: PROYECTO_ENV_VERSIONADO,
      checkId: 'sec.env_committed',
      porque: 'el .env está versionado con valores reales',
    },
    {
      fixture: PROYECTO_ENV_VERSIONADO,
      checkId: 'sec.secret_in_repo',
      porque: 'hay una clave de Stripe escrita en el .env',
    },
    {
      fixture: PROYECTO_SERVICE_ROLE_EN_CLIENTE,
      checkId: 'sec.service_role_in_client',
      porque: "la llave maestra está en un archivo con 'use client'",
    },
    {
      fixture: PROYECTO_CATCH_VACIO,
      checkId: 'cmp.no_error_state',
      porque: 'hay un catch vacío y otro que solo escribe en consola',
    },
    {
      fixture: PROYECTO_BORRAR_SIN_CONFIRMAR,
      checkId: 'cmp.destructive_no_confirm',
      porque: 'el botón Eliminar no pide confirmación',
    },
  ]

  for (const caso of casos) {
    it(`${caso.checkId} dispara porque ${caso.porque}`, async () => {
      const repo = await crearProyecto(caso.fixture)
      try {
        const check = (CHEQUEOS as Check[]).find((c) => c.id === caso.checkId)
        expect(check, `no existe el chequeo ${caso.checkId}`).toBeDefined()

        const drafts = await check!.run(contextoDe(repo))
        expect(drafts.length, `${caso.checkId} no disparó`).toBeGreaterThan(0)
        for (const draft of drafts) exigirEvidencia(caso.checkId, draft)
      } finally {
        await borrarProyecto(repo)
      }
    })
  }

  it('la tabla sin reglas y la tabla con regla abierta disparan lo suyo', async () => {
    const repo = await crearProyecto({ 'README.md': '# app\n' })
    try {
      const ctx = contextoDe(repo, { dbSchema: ESQUEMA_CON_PROBLEMAS })

      const sinReglas = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.rls_disabled')!
      const abiertas = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.rls_permissive')!
      const noForzadas = (CHEQUEOS as Check[]).find((c) => c.id === 'sec.rls_not_forced')!

      const a = await sinReglas.run(ctx)
      const b = await abiertas.run(ctx)
      const c = await noForzadas.run(ctx)

      // `notas` no tiene reglas. `auth.users` tampoco, pero no es del usuario.
      expect(a).toHaveLength(1)
      expect(a[0]!.titlePlain).toContain('notas')

      // `mensajes` tiene una regla escrita como "using (true)".
      expect(b).toHaveLength(1)
      expect(b[0]!.explanationPlain).toContain('mensajes')

      // `perfiles` tiene reglas activadas pero no forzadas.
      expect(c).toHaveLength(1)
      expect(c[0]!.titlePlain).toContain('perfiles')

      for (const draft of [...a, ...b, ...c]) exigirEvidencia('rls', draft)
    } finally {
      await borrarProyecto(repo)
    }
  })

  it('no se reporta el .env.example ni la llave pública', async () => {
    const repo = await crearProyecto({
      '.env.example': 'STRIPE_SECRET_KEY=sk_live_reemplazame\n',
      '.gitignore': '.env\n.env*.local\n',
      'app/cliente.tsx': "'use client'\nexport const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY\n",
    })
    try {
      const ctx = contextoDe(repo)
      for (const id of ['sec.env_committed', 'sec.secret_in_repo', 'sec.service_role_in_client', 'sec.public_env_secret']) {
        const check = (CHEQUEOS as Check[]).find((c) => c.id === id)!
        const drafts = await check.run(ctx)
        expect(drafts, `${id} reportó algo que es correcto`).toHaveLength(0)
      }
    } finally {
      await borrarProyecto(repo)
    }
  })
})
