/**
 * Datos de ejemplo para poder mirar la zona autenticada sin un proyecto de
 * Supabase conectado.
 *
 * Mismo patrón que ya usa el frente de hallazgos
 * (`src/app/(app)/proyectos/[id]/hallazgos/data.ts`): `CAUGHTCODE_DEMO=1`
 * sirve fixtures propias en vez de pegarle a la base.
 */

export const MODO_DEMO = process.env.CAUGHTCODE_DEMO === '1'

/** Además del modo demo general, permite ver el estado vacío de proyectos. */
export const MODO_DEMO_VACIO = process.env.CAUGHTCODE_DEMO_VACIO === '1'

export interface SessionUser {
  id: string
  name: string
  email: string
  avatarUrl: string | null
}

export interface SessionOrg {
  id: string
  name: string
  plan: string
}

export const DEMO_USER: SessionUser = {
  id: 'demo-user-0001',
  name: 'Manu Navarro',
  email: 'manu@ejemplo.com',
  avatarUrl: null,
}

export const DEMO_ORG: SessionOrg = {
  id: 'demo-org-0001',
  name: 'Espacio de Manu',
  plan: 'free',
}
