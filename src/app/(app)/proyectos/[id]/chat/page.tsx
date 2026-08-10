import type { Metadata } from 'next'
import Link from 'next/link'
import { MessageSquare } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { buttonStyles, EmptyState, ErrorState } from '@/components/ui'
import { ESTADOS } from '@/content/copy'
import { resolverProyecto } from '../comentarios/repo'

export const metadata: Metadata = { title: 'Preguntar' }

interface Props {
  params: Promise<{ id: string }>
}

export default async function PreguntarPage({ params }: Props) {
  const { id } = await params
  const acceso = await resolverProyecto(id)

  if (acceso.estado !== 'ok') {
    return (
      <ErrorState
        kind="forbidden"
        title={ESTADOS.sinPermisos.titulo}
        description={ESTADOS.sinPermisos.texto}
        action={
          <Link href="/proyectos" className={buttonStyles({ variant: 'secondary' })}>
            {ESTADOS.sinPermisos.accion}
          </Link>
        }
      />
    )
  }

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Proyectos', href: '/proyectos' },
          { label: acceso.nombre, href: `/proyectos/${id}` },
          { label: 'Preguntar' },
        ]}
        title="Preguntar"
      />

      <EmptyState
        icon={<MessageSquare aria-hidden="true" strokeWidth={1.7} className="size-7" />}
        title="Todavía no armamos esto"
        description="La idea es que puedas preguntarle cosas puntuales de tu código y te conteste en base a lo que auditamos, no a una respuesta genérica. Todavía no lo construimos."
        action={
          <Link href={`/proyectos/${id}/hallazgos`} className={buttonStyles({ variant: 'secondary' })}>
            Ver los hallazgos
          </Link>
        }
      />
    </>
  )
}
