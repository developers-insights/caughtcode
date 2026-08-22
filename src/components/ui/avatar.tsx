import type { ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

const SIZES = {
  xs: 'size-6 text-2xs',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-lg',
} as const

/**
 * Cuatro tintes neutros. No hay arcoíris de avatares: el color en este
 * producto significa gravedad, y un avatar rojo diría algo que no es.
 */
const TINTS = [
  'bg-canvas-sunken text-ink-muted',
  'bg-ink/8 text-ink',
  'bg-ink/[0.14] text-ink',
  'bg-ink text-ink-inverse',
] as const

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

function tintFor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return TINTS[hash % TINTS.length]!
}

export interface AvatarProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  name: string
  src?: string | null
  size?: keyof typeof SIZES
  /** Cuadrado con esquinas suaves. Para proyectos y organizaciones. */
  shape?: 'circle' | 'square'
}

export function Avatar({
  name,
  src,
  size = 'md',
  shape = 'circle',
  className,
  ...props
}: AvatarProps) {
  return (
    <span
      // No puede ser un `<img>`: es un elemento vacío y acá adentro va texto
      // —las iniciales— cuando no hay foto. `role="img"` con `aria-label` sobre
      // un contenedor es justo la técnica que ARIA recomienda para un dibujo
      // hecho de texto: el lector de pantalla anuncia el nombre una sola vez y
      // no deletrea las iniciales.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold select-none',
        shape === 'circle' ? 'rounded-full' : 'rounded-sm',
        SIZES[size],
        !src && tintFor(name),
        className,
      )}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="size-full object-cover" loading="lazy" decoding="async" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  )
}
