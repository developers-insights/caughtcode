import type { Metadata } from 'next'
import { Card, CardBody, CardHeader, CardDescription, CardTitle, ErrorState } from '@/components/ui'
import { createClient } from '@/lib/supabase/server'
import { UpdatePasswordForm } from './update-password-form'

export const metadata: Metadata = { title: 'Elegir nueva contraseña' }

const MODO_DEMO = process.env.CAUGHTCODE_DEMO === '1'

export default async function NuevaContrasenaPage() {
  // Llegar acá sin haber pasado por el enlace de recuperación (o con uno ya
  // vencido) no debería dejar elegir una contraseña nueva.
  if (!MODO_DEMO) {
    const supabase = await createClient()
    const { data } = await supabase.auth.getClaims()

    if (!data?.claims?.sub) {
      return (
        <Card>
          <CardBody className="pt-6">
            <ErrorState
              kind="forbidden"
              title="Este enlace ya no sirve"
              description="Puede que haya vencido o que ya lo hayas usado. Pedí uno nuevo desde “Recuperar contraseña”."
            />
          </CardBody>
        </Card>
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Elegí una contraseña nueva</CardTitle>
        <CardDescription>Esta va a reemplazar la anterior.</CardDescription>
      </CardHeader>
      <CardBody>
        <UpdatePasswordForm />
      </CardBody>
    </Card>
  )
}
