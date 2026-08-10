'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { MobileNav } from './mobile-nav'
import { ACCOUNT_NAV, GLOBAL_NAV, mobileNav, type NavGroup, type NavItem } from './nav-items'
import { SidebarNav } from './sidebar-nav'
import { TopBar, type TopBarProject, type TopBarUser } from './top-bar'

const WIDTHS = {
  app: 'max-w-app',
  prose: 'max-w-prose',
  full: 'max-w-none',
} as const

export interface AppShellProps {
  /** Grupos de la barra lateral. Por defecto: global + cuenta. */
  navGroups?: NavGroup[]
  /** Ítems de la barra inferior en celular. Máximo 5. */
  mobileItems?: NavItem[]
  projects?: TopBarProject[]
  currentProjectId?: string
  projectHref?: (id: string) => string
  user?: TopBarUser
  /**
   * Cerrar sesión. Como es un callback, quien lo pase tiene que ser un
   * componente cliente (o envolver una server action).
   */
  onSignOut?: () => void
  /** Acciones globales en la barra superior. */
  topBarActions?: ReactNode
  /** Pie de la barra lateral: legales, versión, soporte. */
  sidebarFooter?: ReactNode
  width?: keyof typeof WIDTHS
  className?: string
  children: ReactNode
}

/**
 * Armazón de la aplicación.
 *
 *  ≥1024px  barra lateral fija con texto en cada ítem.
 *  <1024px  barra inferior con hasta 5 destinos, al alcance del pulgar.
 *
 * Un solo patrón de navegación por tamaño de pantalla: no hay hamburguesa
 * escondiendo lo mismo que ya está abajo.
 */
export function AppShell({
  navGroups,
  mobileItems,
  projects,
  currentProjectId,
  projectHref,
  user,
  onSignOut,
  topBarActions,
  sidebarFooter,
  width = 'app',
  className,
  children,
}: AppShellProps) {
  const groups = navGroups ?? [GLOBAL_NAV, ACCOUNT_NAV]
  const bottomItems = mobileItems ?? mobileNav(currentProjectId)

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#contenido"
        className={cn(
          'sr-only-focusable fixed top-3 left-3 z-50 rounded-sm bg-ink px-4 py-2.5',
          'text-base font-medium text-ink-inverse shadow-float',
        )}
      >
        Saltar al contenido
      </a>

      <aside
        data-print-hidden
        className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-canvas lg:flex"
      >
        <div className="flex h-16 shrink-0 items-center px-5">
          <Link
            href="/proyectos"
            className="cc-wordmark rounded-xs text-xl text-ink focus-visible:focus-ring"
          >
            caughtcode
          </Link>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <SidebarNav groups={groups} />
        </div>

        {sidebarFooter && (
          <div className="shrink-0 border-t border-line px-5 py-4 text-sm text-ink-subtle">
            {sidebarFooter}
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          projects={projects}
          currentProjectId={currentProjectId}
          projectHref={projectHref}
          user={user}
          onSignOut={onSignOut}
          actions={topBarActions}
        />

        <main
          id="contenido"
          tabIndex={-1}
          className={cn('flex-1 px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pb-14', className)}
        >
          <div className={cn('mx-auto w-full', WIDTHS[width])}>{children}</div>
        </main>
      </div>

      <MobileNav items={bottomItems} />
    </div>
  )
}
