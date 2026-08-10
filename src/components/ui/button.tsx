import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from './spinner'

/**
 * El botón principal es tinta (casi negro), no un color de marca.
 * Es a propósito: en caughtcode el color significa gravedad. Si el botón
 * de "Analizar" fuera azul o violeta, el rojo de un hallazgo grave perdería
 * fuerza. Ver docs/DESIGN.md → "Interfaz acromática".
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BASE =
  'relative inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap ' +
  'select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'ease-firm focus-visible:focus-ring active:scale-[0.985] ' +
  'disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 ' +
  // Cargando no es lo mismo que deshabilitado: no se puede tocar, pero se ve
  // encendido. Un botón gris mientras trabaja parece un botón roto.
  '[&[aria-busy="true"]]:opacity-100!'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-ink-inverse shadow-support hover:bg-ink/90',
  secondary:
    'border border-field bg-surface text-ink shadow-support hover:bg-surface-hover hover:border-ink-subtle',
  ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink',
  danger: 'bg-expuesto text-expuesto-on shadow-stamp hover:bg-expuesto/90',
  link: 'h-auto! p-0! text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink rounded-xs',
}

/** md = 44px: es el mínimo táctil. Es el default por eso. */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-base',
  lg: 'h-13 px-6 text-base',
}

const ICON_ONLY: Record<ButtonSize, string> = {
  sm: 'size-9 p-0',
  md: 'size-11 p-0',
  lg: 'size-13 p-0',
}

export function buttonStyles({
  variant = 'primary',
  size = 'md',
  iconOnly = false,
  fullWidth = false,
  className,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  iconOnly?: boolean
  fullWidth?: boolean
  className?: string
} = {}) {
  return cn(
    BASE,
    VARIANTS[variant],
    iconOnly ? ICON_ONLY[size] : SIZES[size],
    fullWidth && 'w-full',
    className,
  )
}

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Ícono a la izquierda del texto. */
  icon?: ReactNode
  /** Ícono a la derecha. En `primary` se anida en su propio círculo. */
  iconEnd?: ReactNode
  /** Solo ícono: exige `aria-label`. */
  iconOnly?: boolean
  fullWidth?: boolean
  /** Bloquea el botón y muestra que está trabajando. */
  loading?: boolean
  /** Texto que reemplaza al normal mientras carga. Ej. "Analizando…" */
  loadingLabel?: string
  children?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconEnd,
  iconOnly = false,
  fullWidth = false,
  loading = false,
  loadingLabel,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  const busy = loading === true
  const showNestedChip = variant === 'primary' && !!iconEnd && !iconOnly

  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-variant={variant}
      className={buttonStyles({
        variant,
        size,
        iconOnly,
        fullWidth,
        className: cn(showNestedChip && 'group pr-1.5', className),
      })}
      {...props}
    >
      {busy ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} />
      ) : icon ? (
        <span aria-hidden="true" className="shrink-0 [&_svg]:size-[1.15em]">
          {icon}
        </span>
      ) : null}

      {!iconOnly && <span className="truncate">{busy && loadingLabel ? loadingLabel : children}</span>}
      {iconOnly && !busy && !icon ? (
        <span aria-hidden="true" className="[&_svg]:size-[1.25em]">
          {children}
        </span>
      ) : null}

      {/* Ícono anidado en su propio círculo: da tensión interna al hover
          sin mover el botón entero. */}
      {!busy && iconEnd && showNestedChip ? (
        <span
          aria-hidden="true"
          className={cn(
            'ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
            'bg-ink-inverse/12 transition-transform duration-200 ease-out-soft',
            'group-hover:translate-x-0.5 group-hover:scale-105',
            '[&_svg]:size-4',
          )}
        >
          {iconEnd}
        </span>
      ) : !busy && iconEnd ? (
        <span aria-hidden="true" className="shrink-0 [&_svg]:size-[1.15em]">
          {iconEnd}
        </span>
      ) : null}
    </button>
  )
}
