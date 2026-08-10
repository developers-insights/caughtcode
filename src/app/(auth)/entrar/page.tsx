import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardBody, CardHeader, CardTitle, Callout } from '@/components/ui'
import { SignInForm } from './sign-in-form'

export const metadata: Metadata = { title: 'Entrar' }

interface Props {
  searchParams: Promise<{
    siguiente?: string
    revisaCorreo?: string
    salida?: string
    enlaceInvalido?: string
  }>
}

export default async function EntrarPage({ searchParams }: Props) {
  const { siguiente, revisaCorreo, salida, enlaceInvalido } = await searchParams

  return (
    <div className="space-y-5">
      {revisaCorreo === '1' && (
        <Callout tone="revisar" title="Revisá tu correo">
          Te mandamos un enlace para confirmar tu cuenta. Confirmalo y volvé a entrar acá.
        </Callout>
      )}
      {salida === '1' && (
        <Callout tone="verificado" title="Cerraste sesión">
          Podés entrar de nuevo cuando quieras.
        </Callout>
      )}
      {enlaceInvalido === '1' && (
        <Callout tone="incompleto" title="Ese enlace ya no sirve">
          Puede que haya vencido o que ya lo hayas usado. Si era para confirmar tu cuenta, probá
          entrar directamente.
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle as="h1">Entrar a caughtcode</CardTitle>
        </CardHeader>
        <CardBody>
          <SignInForm siguiente={siguiente ?? '/proyectos'} />
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        ¿Todavía no tenés cuenta?{' '}
        <Link
          href="/registro"
          className="rounded-xs font-medium text-ink underline-offset-4 hover:underline focus-visible:focus-ring"
        >
          Registrate
        </Link>
      </p>
    </div>
  )
}
