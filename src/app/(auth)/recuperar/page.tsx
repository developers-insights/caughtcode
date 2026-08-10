import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardBody, CardHeader, CardDescription, CardTitle } from '@/components/ui'
import { RecoverForm } from './recover-form'

export const metadata: Metadata = { title: 'Recuperar contraseña' }

export default function RecuperarPage() {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle as="h1">Recuperar tu contraseña</CardTitle>
          <CardDescription>Escribí el correo con el que te registraste.</CardDescription>
        </CardHeader>
        <CardBody>
          <RecoverForm />
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        <Link
          href="/entrar"
          className="rounded-xs font-medium text-ink underline-offset-4 hover:underline focus-visible:focus-ring"
        >
          Volver a entrar
        </Link>
      </p>
    </div>
  )
}
