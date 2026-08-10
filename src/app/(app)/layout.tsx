import type { ReactNode } from 'react'
import { T } from '@/lib/db/tablas'
import { signOutAction } from '@/app/(auth)/actions'
import type { TopBarProject } from '@/components/shell'
import { DEMO_PROJECTS } from '@/components/projects/fixtures'
import { requireSession } from './current-org'
import { MODO_DEMO } from './demo'
import { AppShellClient } from './shell'

// Esta zona lee sesión y organización en cada pedido: nunca se cachea.
export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { supabase, user, org } = await requireSession()

  let projects: TopBarProject[] = []

  if (MODO_DEMO) {
    projects = DEMO_PROJECTS.map((p) => ({ id: p.id, name: p.name, clientName: p.clientName }))
  } else if (supabase) {
    const { data } = await supabase
      .from(T.projects)
      .select('id, name, client_name')
      .eq('org_id', org.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(50)

    projects = (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      clientName: row.client_name,
    }))
  }

  return (
    <AppShellClient
      projects={projects}
      user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
      onSignOut={signOutAction}
    >
      {children}
    </AppShellClient>
  )
}
