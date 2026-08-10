'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { isActive, type NavGroup } from './nav-items'

export interface SidebarNavProps {
  groups: NavGroup[]
  /** Al navegar, cerrar el panel en pantallas chicas. */
  onNavigate?: () => void
  className?: string
}

/**
 * Navegación principal.
 * Cada ítem lleva ícono Y texto: un ícono solo obliga a adivinar.
 * El activo se marca con una barra de tinta al margen — el mismo recurso que
 * marca un hallazgo, pero acromático.
 */
export function SidebarNav({ groups, onNavigate, className }: SidebarNavProps) {
  const pathname = usePathname()

  return (
    <nav aria-label="Navegación principal" className={cn('flex flex-col gap-6', className)}>
      {groups.map((group, gi) => (
        <div key={group.label ?? gi}>
          {group.label && (
            <p className="mb-2 px-3 text-eyebrow uppercase text-ink-subtle">{group.label}</p>
          )}

          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item)
              const Icon = item.icon

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex h-11 items-center gap-3 rounded-sm pr-2.5 pl-3.5 text-base',
                      'transition-colors duration-150 ease-firm focus-visible:focus-ring',
                      active
                        ? 'bg-surface font-semibold text-ink shadow-support'
                        : 'font-medium text-ink-muted hover:bg-surface-hover hover:text-ink',
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-ink"
                      />
                    )}

                    <Icon
                      aria-hidden="true"
                      strokeWidth={active ? 2 : 1.7}
                      className="size-[1.15rem] shrink-0"
                    />

                    <span className="min-w-0 flex-1 truncate">{item.label}</span>

                    {item.badge !== undefined && item.badge > 0 && (
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular',
                          item.badgeTone === 'expuesto'
                            ? 'bg-expuesto text-expuesto-on'
                            : 'bg-canvas-sunken text-ink-muted',
                        )}
                      >
                        {item.badge > 99 ? '99+' : item.badge}
                        <span className="sr-only"> sin resolver</span>
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
