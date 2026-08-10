import type { Metadata } from 'next'
import Link from 'next/link'
import { CircleCheck } from 'lucide-react'
import { buttonStyles } from '@/components/ui'

export const metadata: Metadata = { title: 'Tu cuenta se borró' }

/**
 * Pantalla de confirmación después de `delete_account`. Para cuando se llega
 * acá el usuario ya está deslogueado — por eso vive en `(auth)`, no en `(app)`.
 */
export default function CuentaBorradaPage() {
  return (
    <div className="flex flex-col items-center space-y-5 text-center">
      <span
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-full bg-verificado-soft text-verificado-text"
      >
        <CircleCheck className="size-6" strokeWidth={1.8} />
      </span>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-ink">Tu cuenta se borró</h1>
        <p className="text-base leading-relaxed text-ink-muted">
          Borramos tus proyectos, tu código y todo lo que habíamos guardado. Cerramos tu sesión.
          Gracias por haber probado caughtcode.
        </p>
      </div>

      <Link href="/" className={buttonStyles({ variant: 'secondary' })}>
        Volver al inicio
      </Link>
    </div>
  )
}
