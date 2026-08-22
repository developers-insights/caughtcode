'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { popIn, veil } from './motion'
import { Button } from './button'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

const SIZES = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
} as const

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Oculta el título visualmente pero lo deja para lectores de pantalla. */
  hideTitle?: boolean
  size?: keyof typeof SIZES
  /**
   * false = no se cierra con Esc ni tocando afuera.
   * Usalo solo cuando cerrar por accidente pierde trabajo del usuario.
   */
  dismissible?: boolean
  /** Fila de botones al pie. La acción principal va última (a la derecha). */
  footer?: ReactNode
  children?: ReactNode
  className?: string
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  hideTitle = false,
  size = 'md',
  dismissible = true,
  footer,
  children,
  className,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  /* Bloqueo de scroll del fondo + foco atrapado + Esc. */
  useEffect(() => {
    if (!open) return

    returnFocusTo.current = document.activeElement as HTMLElement | null

    const { body } = document
    const previousOverflow = body.style.overflow
    const previousPadding = body.style.paddingRight
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`

    // El foco entra al panel. Si hay un campo para completar, va al campo:
    // aterrizar en la "X" de cerrar invita a cerrar, no a completar.
    const focusTimer = window.setTimeout(() => {
      const node = panel.current
      if (!node) return
      const field = node.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled])',
      )
      const first = field ?? node.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? node).focus()
    }, 40)

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation()
        close()
        return
      }

      if (event.key !== 'Tab') return
      const node = panel.current
      if (!node) return

      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (items.length === 0) {
        event.preventDefault()
        node.focus()
        return
      }

      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement

      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown, true)
      body.style.overflow = previousOverflow
      body.style.paddingRight = previousPadding
      returnFocusTo.current?.focus?.()
    }
  }, [open, dismissible, close])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <motion.div
            variants={veil}
            initial="hidden"
            animate="show"
            exit="gone"
            onClick={dismissible ? close : undefined}
            className="absolute inset-0 bg-veil backdrop-blur-[2px]"
          />

          <motion.div
            ref={panel}
            // `<dialog>` no entra acá. El elemento nativo solo es modal si se
            // abre por `showModal()` —imperativo, incompatible con el montaje
            // declarativo de `AnimatePresence`— y al cerrarse sale de la capa
            // superior de inmediato, que se come la animación de salida. Encima
            // trae su propio `::backdrop`, y el velo de acá es un elemento
            // aparte que se anima y se puede clickear para cerrar: serían dos
            // fondos superpuestos. El foco, el `Escape` y el bloqueo del scroll
            // ya están resueltos arriba en este mismo componente.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            variants={popIn}
            initial="hidden"
            animate="show"
            exit="gone"
            className={cn(
              'relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface-raised shadow-float',
              'rounded-t-2xl sm:rounded-xl',
              'pb-[env(safe-area-inset-bottom)] sm:pb-0',
              SIZES[size],
              className,
            )}
          >
            {/* Agarradera visual del sheet en celular. */}
            <span
              aria-hidden="true"
              className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-line-strong sm:hidden"
            />

            <div className="flex items-start gap-4 px-5 pt-4 pb-3 sm:px-6 sm:pt-6">
              <div className="min-w-0 flex-1 space-y-1.5">
                <h2
                  id={titleId}
                  className={cn(
                    'text-xl font-semibold text-balance text-ink',
                    hideTitle && 'sr-only',
                  )}
                >
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="text-base leading-relaxed text-ink-muted">
                    {description}
                  </p>
                )}
              </div>

              {dismissible && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={close}
                  aria-label="Cerrar"
                  icon={<X strokeWidth={2} />}
                  className="-mt-1 -mr-1 shrink-0"
                />
              )}
            </div>

            {children && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>
            )}

            {footer && (
              <div className="flex flex-col-reverse gap-2 border-t border-line bg-canvas-sunken/60 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/** Bloque de contenido dentro del diálogo, con la separación estándar. */
export function DialogSection({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('space-y-4', className)} {...props} />
}
