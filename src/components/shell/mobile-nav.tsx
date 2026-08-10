'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { isActive, type NavItem } from './nav-items'

export interface MobileNavProps {
  items: NavItem[]
  className?: string
}

/**
 * Barra inferior, hasta 5 destinos, siempre con texto.
 * Va abajo porque es donde llega el pulgar. Respeta el área segura del
 * iPhone para no quedar debajo de la barra de gestos.
 */
export function MobileNav({ items, className }: MobileNavProps) {
  const pathname = usePathname()
  const visible = items.slice(0, 5)

  return (
    <nav
      aria-label="Navegación principal"
      data-print-hidden
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/92 backdrop-blur-lg lg:hidden',
        'pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      <ul className="mx-auto flex max-w-2xl">
        {visible.map((item) => {
          const active = isActive(pathname, item)
          const Icon = item.icon

          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex h-16 flex-col items-center justify-center gap-1 px-1',
                  'transition-colors duration-150 ease-firm focus-visible:focus-ring-inset',
                  active ? 'text-ink' : 'text-ink-subtle',
                )}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 h-0.5 w-9 rounded-b-full bg-ink"
                  />
                )}

                <span className="relative">
                  <Icon aria-hidden="true" strokeWidth={active ? 2.1 : 1.7} className="size-5" />
                  {item.badge !== undefined && item.badge > 0 && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -top-1 -right-1.5 min-w-4 rounded-full px-1 text-center text-[0.5625rem]',
                        'font-bold leading-4 tabular',
                        item.badgeTone === 'expuesto'
                          ? 'bg-expuesto text-expuesto-on'
                          : 'bg-ink text-ink-inverse',
                      )}
                    >
                      {item.badge > 9 ? '9+' : item.badge}
                    </span>
                  )}
                </span>

                <span
                  className={cn(
                    'max-w-full truncate text-2xs tracking-normal',
                    active ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {item.label}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
