'use client'

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { DUR, EASE } from './motion'

const SIDES = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
} as const

export interface TooltipProps {
  /** Texto corto. Si necesitás un párrafo, no es un tooltip: es un Callout. */
  content: ReactNode
  side?: keyof typeof SIDES
  /** Milisegundos antes de aparecer. Evita que parpadee al pasar de largo. */
  delay?: number
  children: ReactElement
}

/**
 * Aclaración al pasar el mouse o al llegar con el teclado.
 *
 * Nunca guarda información que el usuario necesita para decidir: en celular
 * no hay hover. Lo importante va en pantalla; acá va solo el detalle.
 */
export function Tooltip({ content, side = 'top', delay = 350, children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()

  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-describedby': open ? id : undefined,
      })
    : children

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={hide}
    >
      {trigger}

      <AnimatePresence>
        {open && (
          <motion.span
            role="tooltip"
            id={id}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: DUR.fast, ease: EASE.outSoft }}
            className={cn(
              'pointer-events-none absolute z-40 w-max max-w-64 rounded-sm px-2.5 py-1.5',
              'bg-ink text-xs leading-snug text-balance text-ink-inverse shadow-raised',
              SIDES[side],
            )}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}
