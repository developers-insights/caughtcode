/**
 * Presets de animación de caughtcode.
 *
 * Regla: el movimiento explica una causa y un efecto. Si no explica nada,
 * no va. Nunca animamos algo decorativo al lado de un hallazgo grave —
 * la atención tiene que ir al hallazgo.
 *
 * `prefers-reduced-motion` se respeta globalmente desde <MotionProvider>
 * (src/components/ui/motion-provider.tsx) y desde el CSS base.
 * No hace falta chequearlo en cada componente.
 */

import type { Transition, Variants } from 'motion/react'

/* ── Duraciones (en segundos; espejan --cc-dur-* de tokens.css) ────────── */

export const DUR = {
  instant: 0.09,
  fast: 0.15,
  base: 0.22,
  slow: 0.34,
  deliberate: 0.52,
} as const

/* ── Curvas (espejan --ease-* de tokens.css) ───────────────────────────── */

export const EASE = {
  /** Entra: desacelera fuerte. Es la de casi todo. */
  outSoft: [0.22, 1, 0.36, 1],
  /** Sale: acelera y se va. Siempre más corta que la entrada. */
  inSoft: [0.64, 0, 0.78, 0],
  /** Paneles grandes, sheets, sidebar. */
  glide: [0.32, 0.72, 0, 1],
  /** Cambios de estado chicos: color, opacidad, check. */
  firm: [0.4, 0, 0.2, 1],
} as const

/* ── Transiciones listas ───────────────────────────────────────────────── */

export const enter: Transition = { duration: DUR.base, ease: EASE.outSoft }
export const exit: Transition = { duration: DUR.fast, ease: EASE.inSoft }
export const glide: Transition = { duration: DUR.slow, ease: EASE.glide }
export const stateChange: Transition = { duration: DUR.fast, ease: EASE.firm }

/** Resorte con masa: para cosas que el dedo empuja (sheets, arrastre). */
export const springy: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 38,
  mass: 0.9,
}

/* ── Variantes ─────────────────────────────────────────────────────────── */

/** Aparición estándar de contenido. Sube poco: 8px, no 60px. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: enter },
  gone: { opacity: 0, y: 4, transition: exit },
}

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: enter },
  gone: { opacity: 0, transition: exit },
}

/** Diálogos y popovers: nacen del 96%, no del 0%. */
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 6 },
  show: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.base, ease: EASE.outSoft } },
  gone: { opacity: 0, scale: 0.98, y: 2, transition: { duration: DUR.fast, ease: EASE.inSoft } },
}

/** Velo del modal. */
export const veil: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: DUR.base, ease: EASE.firm } },
  gone: { opacity: 0, transition: { duration: DUR.fast, ease: EASE.firm } },
}

/** Panel lateral / sheet. `custom` = 'left' | 'right' | 'bottom'. */
export const sheet: Variants = {
  hidden: (side: 'left' | 'right' | 'bottom' = 'left') => ({
    opacity: 0,
    x: side === 'left' ? '-100%' : side === 'right' ? '100%' : 0,
    y: side === 'bottom' ? '100%' : 0,
  }),
  show: { opacity: 1, x: 0, y: 0, transition: glide },
  gone: (side: 'left' | 'right' | 'bottom' = 'left') => ({
    opacity: 0,
    x: side === 'left' ? '-100%' : side === 'right' ? '100%' : 0,
    y: side === 'bottom' ? '100%' : 0,
    transition: { duration: DUR.base, ease: EASE.inSoft },
  }),
}

/**
 * Lista que llega de a poco. Se usa cuando los hallazgos aparecen mientras
 * el análisis todavía corre: cada uno entra al aparecer, no todos juntos.
 * Escalonado corto (40ms) — con más, la lista se siente lenta.
 */
export const listContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
}

export const listItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: enter },
  gone: { opacity: 0, y: 4, transition: exit },
}

/** Acordeón / detalle colapsable. */
export const collapse: Variants = {
  hidden: { height: 0, opacity: 0 },
  show: { height: 'auto', opacity: 1, transition: { duration: DUR.base, ease: EASE.glide } },
  gone: { height: 0, opacity: 0, transition: { duration: DUR.fast, ease: EASE.inSoft } },
}

/* ── Gestos ────────────────────────────────────────────────────────────── */

/** Todo lo que se puede apretar se hunde un poco. */
export const pressable = {
  whileTap: { scale: 0.985 },
  transition: stateChange,
} as const
