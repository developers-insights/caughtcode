'use client'

import { useEffect } from 'react'
import { Button, ErrorState } from '@/components/ui'
import { ESTADOS } from '@/content/copy'

/**
 * Cuando la pantalla se rompe entera.
 *
 * Dice qué pasó y cómo salir, y aclara que no es culpa del usuario ni de su
 * código — que es exactamente lo primero que va a pensar alguien que subió su
 * proyecto a que se lo revisen.
 */
export default function ErrorHallazgos({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[hallazgos]', error)
  }, [error])

  return (
    <ErrorState
      kind="error"
      title={ESTADOS.error.titulo}
      description={ESTADOS.error.texto}
      detail={error.digest ? `Referencia: ${error.digest}` : error.message}
      action={<Button onClick={reset}>{ESTADOS.error.accion}</Button>}
    />
  )
}
