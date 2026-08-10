'use client'

import { usePathname } from 'next/navigation'
import {
  AppShell,
  ACCOUNT_NAV,
  GLOBAL_NAV,
  mobileNav,
  projectNav,
  type TopBarProject,
  type TopBarUser,
} from '@/components/shell'

export interface AppShellClientProps {
  projects: TopBarProject[]
  user: TopBarUser
  /** Server action de `src/app/(auth)/actions.ts`. */
  onSignOut: () => void
  children: React.ReactNode
}

const PROJECT_ID_RE = /^\/proyectos\/([^/]+)(?:\/|$)/

/**
 * Envoltorio cliente de `AppShell`: decide, a partir de la URL, si hay un
 * proyecto abierto y arma la navegación correspondiente. `AppShell` en sí es
 * agnóstico de ruta — esta es la única pieza que necesita `usePathname()`.
 */
export function AppShellClient({ projects, user, onSignOut, children }: AppShellClientProps) {
  const pathname = usePathname()
  const match = pathname.match(PROJECT_ID_RE)
  const currentProjectId = match?.[1] && match[1] !== 'nuevo' ? match[1] : undefined

  const navGroups = currentProjectId
    ? [GLOBAL_NAV, projectNav(currentProjectId), ACCOUNT_NAV]
    : [GLOBAL_NAV, ACCOUNT_NAV]

  return (
    <AppShell
      navGroups={navGroups}
      mobileItems={mobileNav(currentProjectId)}
      projects={projects}
      currentProjectId={currentProjectId}
      user={user}
      onSignOut={onSignOut}
    >
      {children}
    </AppShell>
  )
}
