'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Check, EllipsisVertical, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownItem,
  DropdownMenu,
  STATUS_LABEL,
  notify,
  visualFor,
} from '@/components/ui'
import { createClient } from '@/lib/supabase/client'
import { F } from '@/lib/db/tablas'
import type { Finding, FindingStatus } from '@/lib/types/domain'
import { ESTADO_HALLAZGO } from './copy'

export interface FindingStatusControlProps {
  finding: Pick<Finding, 'id' | 'severity' | 'confidence' | 'status'>
  /** En modo demostración no hay base a la que escribirle. */
  soloLectura?: boolean
  className?: string
}

/**
 * Cerrar o reabrir un hallazgo.
 *
 * El cambio pasa por `set_finding_status`. Escribir directo en la tabla está
 * bloqueado a propósito desde la base: la única forma de cambiar el estado es
 * esta, y así queda un solo lugar donde auditar quién cerró qué.
 *
 * Descartar pide confirmación y dice qué implica, porque el usuario no tiene
 * cómo saber si "descartar" es "ocultar" o "borrar para siempre".
 */
export function FindingStatusControl({
  finding,
  soloLectura = false,
  className,
}: FindingStatusControlProps) {
  const router = useRouter()
  const [pendiente, empezar] = useTransition()
  const [guardando, setGuardando] = useState<FindingStatus | null>(null)
  const [confirmando, setConfirmando] = useState(false)

  const abierto = finding.status === 'open'
  const { tone } = visualFor(finding)

  async function cambiar(status: FindingStatus, mensaje: string) {
    if (soloLectura) {
      notify.info(mensaje)
      return
    }

    setGuardando(status)
    const supabase = createClient()
    const { error } = await supabase.rpc(F.setFindingStatus, {
      p_finding_id: finding.id,
      p_status: status,
    })
    setGuardando(null)

    if (error) {
      notify.problema(ESTADO_HALLAZGO.fallo)
      return
    }

    notify.ok(mensaje)
    empezar(() => router.refresh())
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', className)}>
      {abierto ? (
        <>
          <Button
            variant="secondary"
            icon={<Check aria-hidden="true" strokeWidth={1.8} className="size-4" />}
            loading={guardando === 'fixed' || pendiente}
            loadingLabel={ESTADO_HALLAZGO.marcandoResuelto}
            onClick={() => void cambiar('fixed', ESTADO_HALLAZGO.resueltoOk)}
          >
            {ESTADO_HALLAZGO.marcarResuelto}
          </Button>

          <DropdownMenu
            label={ESTADO_HALLAZGO.masAcciones}
            align="end"
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                variant="ghost"
                iconOnly
                aria-label={ESTADO_HALLAZGO.masAcciones}
                icon={<EllipsisVertical aria-hidden="true" strokeWidth={1.8} className="size-4" />}
              />
            )}
          >
            <DropdownItem
              destructive
              icon={<Trash2 aria-hidden="true" strokeWidth={1.8} className="size-4" />}
              onClick={() => setConfirmando(true)}
            >
              {ESTADO_HALLAZGO.descartar}
            </DropdownItem>
          </DropdownMenu>
        </>
      ) : (
        <>
          <Badge tone={tone} variant="soft" size="md" dot>
            {STATUS_LABEL[finding.status]}
          </Badge>
          <Button
            variant="ghost"
            icon={<RotateCcw aria-hidden="true" strokeWidth={1.8} className="size-4" />}
            loading={guardando === 'open' || pendiente}
            loadingLabel={ESTADO_HALLAZGO.marcandoResuelto}
            onClick={() => void cambiar('open', ESTADO_HALLAZGO.reabiertoOk)}
          >
            {ESTADO_HALLAZGO.reabrir}
          </Button>
        </>
      )}

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title={ESTADO_HALLAZGO.confirmarDescarte.titulo}
        consequences={ESTADO_HALLAZGO.confirmarDescarte.consecuencias}
        destructive
        confirmLabel={ESTADO_HALLAZGO.confirmarDescarte.confirmar}
        loading={guardando === 'dismissed'}
        onConfirm={() => {
          setConfirmando(false)
          void cambiar('dismissed', ESTADO_HALLAZGO.descartadoOk)
        }}
      />
    </div>
  )
}
