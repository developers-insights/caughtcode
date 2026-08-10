'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { DUR, EASE } from './motion'

const ALIGN = {
  start: 'left-0 origin-top-left',
  end: 'right-0 origin-top-right',
} as const

export interface DropdownMenuProps {
  /** El disparador. Recibe `aria-expanded` y `aria-haspopup` automáticamente. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>
    onClick: () => void
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
    'aria-controls': string
  }) => ReactNode
  align?: keyof typeof ALIGN
  /** Ancho mínimo del panel. */
  className?: string
  children: ReactNode
  label?: string
}

/**
 * Menú de acciones. Para elegir un dato usá <Select> (nativo, mejor en celular);
 * esto es para verbos: renombrar, borrar, cerrar sesión.
 */
export function DropdownMenu({
  trigger,
  align = 'end',
  className,
  children,
  label = 'Acciones',
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
      )
      if (items.length === 0) return
      event.preventDefault()

      const index = items.indexOf(document.activeElement as HTMLElement)
      const next =
        event.key === 'ArrowDown'
          ? index < 0
            ? 0
            : (index + 1) % items.length
          : index < 0
            ? items.length - 1
            : (index - 1 + items.length) % items.length
      items[next]?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    const focusTimer = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }, 30)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(focusTimer)
    }
  }, [open])

  return (
    <div ref={root} className="relative inline-flex">
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((v) => !v),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-controls': id,
      })}

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={id}
            role="menu"
            aria-label={label}
            initial={{ opacity: 0, scale: 0.97, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ duration: DUR.fast, ease: EASE.outSoft }}
            onClick={() => setOpen(false)}
            className={cn(
              'absolute top-full z-40 mt-2 min-w-56 rounded-md border border-line',
              'bg-surface-raised p-1.5 shadow-float',
              ALIGN[align],
              className,
            )}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export interface DropdownItemProps extends React.ComponentPropsWithRef<'button'> {
  icon?: ReactNode
  /** Acción peligrosa: se ve distinta y va separada del resto. */
  destructive?: boolean
  /** Detalle en gris a la derecha. Ej. un atajo o un estado. */
  meta?: ReactNode
}

export function DropdownItem({
  icon,
  destructive = false,
  meta,
  className,
  children,
  ...props
}: DropdownItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-base',
        'transition-colors duration-100 ease-firm focus-visible:focus-ring-inset',
        'disabled:pointer-events-none disabled:opacity-45',
        destructive
          ? 'text-expuesto-text hover:bg-expuesto-soft focus-visible:bg-expuesto-soft'
          : 'text-ink hover:bg-surface-hover focus-visible:bg-surface-hover',
        className,
      )}
      {...props}
    >
      {icon && (
        <span aria-hidden="true" className="shrink-0 text-ink-subtle [&_svg]:size-4">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="shrink-0 text-sm text-ink-subtle">{meta}</span>}
    </button>
  )
}

export function DropdownSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn('my-1.5 h-px bg-line', className)} />
}

export function DropdownLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('px-2.5 pt-2 pb-1.5 text-eyebrow uppercase text-ink-subtle', className)}>
      {children}
    </div>
  )
}
