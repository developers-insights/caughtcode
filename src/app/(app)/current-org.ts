import 'server-only'

/**
 * Sesión y espacio de trabajo actuales, para toda la zona autenticada.
 *
 * `caughtcode` no tiene proyecto propio de Supabase: comparte la base con otro
 * producto (ver `supabase/migrations/0007_auth_bootstrap.sql`). Por eso no hay
 * trigger que arme la organización al registrarse — la creamos nosotros acá,
 * llamando a `ensure_org_caughtcode()`, apenas alguien entra a una pantalla de
 * la app. Es idempotente: si ya existe, no escribe nada.
 */

import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { F, T } from '@/lib/db/tablas'
import type { Database } from '@/lib/types/database'
import { DEMO_ORG, DEMO_USER, MODO_DEMO, type SessionOrg, type SessionUser } from './demo'

export type { SessionOrg, SessionUser } from './demo'

export interface CurrentSession {
  /** `null` en modo demo: no hay cliente real de Supabase. */
  supabase: SupabaseClient<Database> | null
  user: SessionUser
  org: SessionOrg
}

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== 'object') return null
  const value = (meta as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Exige sesión y organización. Redirige a `/entrar` si no hay usuario.
 * Es el punto de entrada que usan el layout de `(app)` y las pantallas que
 * necesitan saber a qué organización pertenece quien mira.
 *
 * `cache()` de React deduplica dentro del mismo pedido: el layout y la
 * página que renderiza adentro llaman a esto por separado, pero solo se
 * ejecuta una vez.
 */
export const requireSession = cache(async (): Promise<CurrentSession> => {
  if (MODO_DEMO) {
    return { supabase: null, user: DEMO_USER, org: DEMO_ORG }
  }

  const supabase = await createClient()

  // No metas nada entre crear el cliente y llamar a getClaims(): misma regla
  // que en proxy.ts.
  const { data: claimsData } = await supabase.auth.getClaims()
  const claims = claimsData?.claims

  if (!claims || !claims.sub) {
    redirect('/entrar')
  }

  const user: SessionUser = {
    id: claims.sub,
    name:
      metaString(claims.user_metadata, 'full_name') ??
      metaString(claims.user_metadata, 'name') ??
      (claims.email ? claims.email.split('@')[0]! : 'Tu cuenta'),
    email: claims.email ?? '',
    avatarUrl: metaString(claims.user_metadata, 'avatar_url'),
  }

  const { data: orgId, error: ensureError } = await supabase.rpc(F.ensureOrg, {})
  if (ensureError || !orgId) {
    throw new Error(
      `No pudimos preparar tu espacio de trabajo. ${ensureError?.message ?? 'Probá de nuevo en un minuto.'}`,
    )
  }

  const { data: orgRow, error: orgError } = await supabase
    .from(T.organizations)
    .select('id, name, plan')
    .eq('id', orgId)
    .maybeSingle()

  if (orgError || !orgRow) {
    throw new Error('No encontramos tu espacio de trabajo. Probá de nuevo en un minuto.')
  }

  return {
    supabase,
    user,
    org: { id: orgRow.id, name: orgRow.name, plan: orgRow.plan },
  }
})
