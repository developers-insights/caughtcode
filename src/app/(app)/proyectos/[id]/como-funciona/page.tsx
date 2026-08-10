import type { Metadata } from 'next'
import Link from 'next/link'
import { Film } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { buttonStyles, EmptyState, ErrorState } from '@/components/ui'
import { ESTADOS } from '@/content/copy'
import { resolverProyecto } from '../comentarios/repo'

export const metadata: Metadata = { title: 'Cómo funciona' }

interface Props {
  params: Promise<{ id: string }>
}

export default async function ComoFuncionaPage({ params }: Props) {
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
          { label: 'Cómo funciona' },
        ]}
        title="Cómo funciona"
      />

      <EmptyState
        icon={<Film aria-hidden="true" strokeWidth={1.7} className="size-7" />}
        title="Todavía no armamos esto"
        description="La idea es un video corto que recorra tu proyecto y te muestre cómo está armado, para que lo entiendas sin leer código. Todavía no lo construimos: por ahora, la revisión de seguridad y experiencia ya la tenés lista en Hallazgos."
        action={
          <Link href={`/proyectos/${id}/hallazgos`} className={buttonStyles({ variant: 'secondary' })}>
            Ver los hallazgos
          </Link>
        }
      />
    </>
  )
}
