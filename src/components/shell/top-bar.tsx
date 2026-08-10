'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChevronsUpDown, CreditCard, LogOut, Plus, User } from 'lucide-react'
import {
  Avatar,
  Button,
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { ThemeToggle } from './theme-toggle'

export interface TopBarProject {
  id: string
  name: string
  /** Nombre del cliente, para quien gestiona proyectos de terceros. */
  clientName?: string | null
}

export interface TopBarUser {
  name: string
  email: string
  avatarUrl?: string | null
}

export interface TopBarProps {
  projects?: TopBarProject[]
  currentProjectId?: string
  /** A dónde lleva elegir un proyecto. */
  projectHref?: (id: string) => string
  user?: TopBarUser
  onSignOut?: () => void
  /** Acciones propias de la pantalla, a la derecha. */
  actions?: ReactNode
  className?: string
}

export function TopBar({
  projects = [],
  currentProjectId,
  projectHref = (id) => `/proyectos/${id}/hallazgos`,
  user,
  onSignOut,
  actions,
  className,
}: TopBarProps) {
  const current = projects.find((p) => p.id === currentProjectId)

  return (
    <header
      data-print-hidden
      className={cn(
        'sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line px-4 sm:px-6',
        'bg-canvas/85 backdrop-blur-lg',
        className,
      )}
    >
      {/* La marca solo en pantallas chicas: en desktop ya está en la barra lateral. */}
      <Link
        href="/proyectos"
        className="cc-wordmark shrink-0 rounded-xs text-xl text-ink focus-visible:focus-ring lg:hidden"
      >
        caughtcode
      </Link>

      {projects.length > 0 && (
        <>
          <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-line sm:block lg:hidden" />

          <DropdownMenu
            align="start"
            label="Elegir proyecto"
            className="min-w-64"
            trigger={(triggerProps) => (
              <button
                type="button"
                {...triggerProps}
                className={cn(
                  'flex h-10 max-w-[15rem] items-center gap-2.5 rounded-sm px-2 text-left',
                  'transition-colors duration-150 ease-firm hover:bg-surface-hover focus-visible:focus-ring',
                )}
              >
                <Avatar name={current?.name ?? 'Sin proyecto'} size="sm" shape="square" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-ink">
                    {current?.name ?? 'Elegí un proyecto'}
                  </span>
                  {current?.clientName && (
                    <span className="block truncate text-xs text-ink-muted">{current.clientName}</span>
                  )}
                </span>
                <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
              </button>
            )}
          >
            <DropdownLabel>Tus proyectos</DropdownLabel>
            {projects.map((project) => (
              <DropdownItem
                key={project.id}
                onClick={() => {
                  window.location.href = projectHref(project.id)
                }}
                meta={project.id === currentProjectId ? 'Abierto' : undefined}
                icon={<Avatar name={project.name} size="xs" shape="square" />}
              >
                {project.name}
              </DropdownItem>
            ))}
            <DropdownSeparator />
            <DropdownItem
              icon={<Plus strokeWidth={2} />}
              onClick={() => {
                window.location.href = '/proyectos'
              }}
            >
              Sumar un proyecto
            </DropdownItem>
          </DropdownMenu>
        </>
      )}

      <div className="flex-1" />

      {actions}
      <ThemeToggle />

      {user && (
        <DropdownMenu
          label="Tu cuenta"
          trigger={(triggerProps) => (
            <button
              type="button"
              {...triggerProps}
              aria-label={`Cuenta de ${user.name}`}
              className="flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-firm hover:bg-surface-hover focus-visible:focus-ring"
            >
              <Avatar name={user.name} src={user.avatarUrl} size="sm" />
            </button>
          )}
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-base font-semibold text-ink">{user.name}</p>
            <p className="truncate text-sm text-ink-muted">{user.email}</p>
          </div>
          <DropdownSeparator />
          <DropdownItem
            icon={<User strokeWidth={1.8} />}
            onClick={() => {
              window.location.href = '/cuenta'
            }}
          >
            Tu cuenta
          </DropdownItem>
          <DropdownItem
            icon={<CreditCard strokeWidth={1.8} />}
            onClick={() => {
              window.location.href = '/facturacion'
            }}
          >
            Plan y pagos
          </DropdownItem>
          {onSignOut && (
            <>
              <DropdownSeparator />
              <DropdownItem icon={<LogOut strokeWidth={1.8} />} onClick={onSignOut} destructive>
                Cerrar sesión
              </DropdownItem>
            </>
          )}
        </DropdownMenu>
      )}

      {!user && (
        <Button variant="secondary" size="sm" onClick={() => (window.location.href = '/ingresar')}>
          Ingresar
        </Button>
      )}
    </header>
  )
}
