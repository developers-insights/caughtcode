'use client'

import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'

interface TabsCtx {
  value: string
  setValue: (v: string) => void
  baseId: string
}

const Ctx = createContext<TabsCtx | null>(null)

function useTabs(component: string): TabsCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error(`<${component}> tiene que estar dentro de <Tabs>`)
  return ctx
}

export interface TabsProps {
  /** Modo controlado. */
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  className?: string
  children: ReactNode
}

export function Tabs({ value, defaultValue, onValueChange, className, children }: TabsProps) {
  const baseId = useId()
  const [internal, setInternal] = useState(defaultValue ?? '')
  const current = value ?? internal

  const setValue = (next: string) => {
    if (value === undefined) setInternal(next)
    onValueChange?.(next)
  }

  return (
    <Ctx.Provider value={{ value: current, setValue, baseId }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  )
}

export function TabsList({
  className,
  children,
  'aria-label': ariaLabel,
  ...props
}: ComponentPropsWithRef<'div'>) {
  const list = useRef<HTMLDivElement>(null)

  /* Flechas mueven el foco entre pestañas, como manda el patrón de tablist. */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return

    const tabs = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? [],
    )
    if (tabs.length === 0) return

    const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault()

    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : (index - 1 + tabs.length) % tabs.length

    tabs[next]?.focus()
    tabs[next]?.click()
  }

  return (
    // El `tablist` **no** se enfoca: el foco vive en las pestañas, con tabindex
    // rotativo (`tabIndex={selected ? 0 : -1}` en `TabsTrigger`), que es lo que
    // manda el patrón ARIA de pestañas. Hacer enfocable también al contenedor
    // agregaría una parada de tabulación que no lleva a ningún lado. El
    // `onKeyDown` está acá porque las flechas llegan burbujeando desde la
    // pestaña enfocada, no porque el contenedor sea un control.
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      ref={list}
      role="tablist"
      aria-label={ariaLabel ?? 'Secciones'}
      onKeyDown={onKeyDown}
      className={cn(
        'flex gap-1 overflow-x-auto border-b border-line',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export interface TabsTriggerProps extends Omit<ComponentPropsWithRef<'button'>, 'value'> {
  value: string
  /** Contador al costado. Ej. cuántos hallazgos hay en esa pestaña. */
  count?: number
}

export function TabsTrigger({ value, count, className, children, ...props }: TabsTriggerProps) {
  const { value: active, setValue, baseId } = useTabs('TabsTrigger')
  const selected = active === value

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => setValue(value)}
      className={cn(
        'relative -mb-px flex h-11 shrink-0 items-center gap-2 rounded-t-sm px-3.5 text-base font-medium',
        'transition-colors duration-150 ease-firm focus-visible:focus-ring-inset',
        selected
          ? 'text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-ink'
          : 'text-ink-muted hover:text-ink',
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular',
            selected ? 'bg-ink text-ink-inverse' : 'bg-canvas-sunken text-ink-muted',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

export interface TabsPanelProps extends ComponentPropsWithRef<'div'> {
  value: string
}

export function TabsPanel({ value, className, children, ...props }: TabsPanelProps) {
  const { value: active, baseId } = useTabs('TabsPanel')
  if (active !== value) return null

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      tabIndex={0}
      className={cn('pt-5 focus-visible:focus-ring', className)}
      {...props}
    >
      {children}
    </div>
  )
}
