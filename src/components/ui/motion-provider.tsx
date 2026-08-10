'use client'

import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Envuelve toda la app. `reducedMotion="user"` hace que motion desactive
 * transform y layout cuando el sistema pide menos movimiento, dejando solo
 * los cambios de opacidad. No hay que chequearlo componente por componente.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
