'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { cn, formatUsd } from '@/lib/utils'
import { Button } from './button'
import { Dialog } from './dialog'
import { Input } from './input'

export interface ConfirmCost {
  /** Costo en dólares. Se muestra siempre, aunque sea 0. */
  usd: number
  /**
   * Unidades concretas de lo que se va a gastar.
   * Ej. "1 análisis completo · ~7 min de agente · 3 videos".
   * Nunca "créditos": el usuario no sabe cuánto vale un crédito.
   */
  units?: string
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Lo que va a pasar, en viñetas. Concreto y en pasado hipotético. */
  consequences?: ReactNode[]
  /** Costo. Si lo pasás, se muestra ANTES de que el usuario confirme. */
  cost?: ConfirmCost
  /** Acción destructiva: botón rojo y tono de alerta. */
  destructive?: boolean
  /**
   * Exige escribir este texto exacto para habilitar el botón.
   * Reservado para lo que no se puede deshacer: borrar un proyecto o la cuenta.
   */
  requireTyping?: string
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
  onConfirm: () => void
}

/**
 * Confirmación de una acción que no se deshace o que cuesta plata.
 *
 * Dos reglas duras del producto viven acá:
 *  · Nada irreversible sin confirmar.
 *  · Si cuesta plata, se muestra cuánto en dólares y en unidades concretas
 *    antes de ejecutar. Nunca "créditos".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  cost,
  destructive = false,
  requireTyping,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const unlocked = !requireTyping || typed.trim() === requireTyping

  useEffect(() => {
    if (!open) setTyped('')
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      dismissible={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={!unlocked}
            loading={loading}
            loadingLabel="Un momento…"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {consequences && consequences.length > 0 && (
          <ul className="space-y-2">
            {consequences.map((item, i) => (
              <li key={i} className="flex gap-2.5 text-base leading-relaxed text-ink-muted">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-2 size-1.5 shrink-0 rounded-full',
                    destructive ? 'bg-expuesto' : 'bg-ink-subtle',
                  )}
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}

        {cost && (
          <div className="rounded-md border border-line bg-canvas-sunken p-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-ink-muted">Lo que vas a gastar</span>
              <span className="text-xl font-semibold tabular text-ink">{formatUsd(cost.usd)}</span>
            </div>
            {cost.units && <p className="mt-1.5 text-sm text-ink-muted">{cost.units}</p>}
          </div>
        )}

        {requireTyping && (
          <Input
            label={
              <>
                Escribí <span className="font-mono font-semibold text-ink">{requireTyping}</span> para
                confirmar
              </>
            }
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            hint="Lo pedimos porque esto no se puede deshacer."
          />
        )}
      </div>
    </Dialog>
  )
}
