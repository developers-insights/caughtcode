'use client'

import { useState, type ReactNode } from 'react'
import { cn, formatUsd } from '@/lib/utils'
import { Button } from './button'
import { Dialog } from './dialog'
import { Input } from './input'
import { Spinner } from './spinner'

export interface ConfirmCost {
  /** Costo en dólares. Se muestra siempre, aunque sea 0. */
  usd: number
  /**
   * Unidades concretas de lo que se va a gastar.
   * Ej. "1 análisis completo · ~7 min de agente · 3 videos".
   * Nunca "créditos": el usuario no sabe cuánto vale un crédito.
   */
  units?: string
  /**
   * Aclaración sobre cómo salió el número: sobre qué se calculó, si es un
   * techo, cuánto puede moverse. Va debajo, chica, sin competir con la cifra.
   */
  nota?: string
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
  /**
   * El precio todavía se está calculando. El pozo muestra la espera y el botón
   * de confirmar queda bloqueado: no se gasta lo que no se sabe cuánto cuesta.
   */
  costPending?: ReactNode
  /**
   * No se pudo calcular el precio. Se dice por qué y **no se puede confirmar**.
   * Preferimos hacer reintentar a alguien antes que cobrarle sin avisarle.
   */
  costError?: ReactNode
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
  costPending,
  costError,
  destructive = false,
  requireTyping,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  /**
   * Sin precio en pantalla no se confirma. La regla dura vive acá adentro, no
   * en cada pantalla que use el diálogo: si el número está en camino o no se
   * pudo sacar, el botón no habilita.
   */
  const conPrecio = !costPending && !costError
  const unlocked = conPrecio && (!requireTyping || typed.trim() === requireTyping)

  /*
   * Al cerrarse, el diálogo se olvida de lo que había escrito. Se ajusta en el
   * render y no en un `useEffect`: es un cambio de estado que responde a otro
   * estado, no una sincronización con nada de afuera, y React lo rehace antes
   * de pintar. Con el efecto quedaba, por un pintado, un diálogo cerrándose con
   * el texto de confirmación todavía adentro.
   */
  const [eraAbierto, setEraAbierto] = useState(open)
  if (eraAbierto !== open) {
    setEraAbierto(open)
    if (!open) setTyped('')
  }

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

        {/* El pozo del precio. Es lo único que cambia de forma según el estado:
            el número, la espera y la falla ocupan el mismo lugar, así que la
            caja nunca desaparece ni salta de tamaño mientras se resuelve. */}
        {(cost || costPending || costError) && (
          <div
            aria-live="polite"
            className={cn(
              'rounded-md border p-4',
              costError ? 'border-expuesto-border bg-expuesto-soft' : 'border-line bg-canvas-sunken',
            )}
          >
            {costError ? (
              <div className="space-y-1.5 text-sm leading-relaxed text-expuesto-text">
                {costError}
              </div>
            ) : costPending ? (
              <div className="flex items-center gap-3 text-sm text-ink-muted">
                <Spinner size="sm" className="text-ink-subtle" />
                <span>{costPending}</span>
              </div>
            ) : cost ? (
              <>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm text-ink-muted">Lo que vas a gastar</span>
                  <span className="text-xl font-semibold tabular text-ink">
                    {formatUsd(cost.usd)}
                  </span>
                </div>
                {cost.units && <p className="mt-1.5 text-sm text-ink-muted">{cost.units}</p>}
                {cost.nota && (
                  <p className="mt-2 border-t border-line pt-2 text-xs leading-relaxed text-ink-muted">
                    {cost.nota}
                  </p>
                )}
              </>
            ) : null}
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
