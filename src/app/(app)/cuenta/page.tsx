import type { Metadata } from 'next'
import { LogOut } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import {
  Button,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { signOutAction } from '@/app/(auth)/actions'
import { requireSession } from '../current-org'
import { DeleteAccountDialog } from './delete-account-dialog'
import { ProfileForm } from './profile-form'

export const metadata: Metadata = { title: 'Tu cuenta' }
export const dynamic = 'force-dynamic'

export default async function CuentaPage() {
  const { user } = await requireSession()

  return (
    <>
      <PageHeader title="Tu cuenta" />

      <div className="max-w-prose space-y-6">
        <Card>
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              Perfil
            </CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </CardHeader>
          <CardBody>
            <ProfileForm name={user.name} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              Sesión
            </CardTitle>
            <CardDescription>Cerrás sesión en este dispositivo. Podés volver a entrar cuando quieras.</CardDescription>
          </CardHeader>
          <CardFooter className="justify-start">
            <form action={signOutAction}>
              <Button type="submit" variant="secondary" icon={<LogOut strokeWidth={1.9} />}>
                Cerrar sesión
              </Button>
            </form>
          </CardFooter>
        </Card>

        <Card tone="expuesto" emphasis="marked">
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              Borrar tu cuenta
            </CardTitle>
            <CardDescription>
              Borra todos tus proyectos, su código y tu acceso a caughtcode. No hay vuelta atrás.
            </CardDescription>
          </CardHeader>
          <CardFooter className="justify-end">
            <DeleteAccountDialog email={user.email} />
          </CardFooter>
        </Card>
      </div>
    </>
  )
}
