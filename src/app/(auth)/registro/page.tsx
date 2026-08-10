import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { SignUpForm } from './sign-up-form'

export const metadata: Metadata = { title: 'Crear cuenta' }

export default function RegistroPage() {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle as="h1">Empecemos por tu app</CardTitle>
        </CardHeader>
        <CardBody>
          <SignUpForm />
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        ¿Ya tenés cuenta?{' '}
        <Link
          href="/entrar"
          className="rounded-xs font-medium text-ink underline-offset-4 hover:underline focus-visible:focus-ring"
        >
          Entrá
        </Link>
      </p>
    </div>
  )
}
