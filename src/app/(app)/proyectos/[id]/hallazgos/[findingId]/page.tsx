import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { CopyButton, ErrorState, buttonStyles } from '@/components/ui'
import { FindingDetail, SeverityIndicator, findingsCopy } from '@/components/findings'
import { ESTADOS } from '@/content/copy'
import { PILLAR_LABEL } from '@/lib/types/domain'
import { MODO_DEMO, cargarHallazgo } from '../data'

interface Props {
  params: Promise<{ id: string; findingId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, findingId } = await params
  const resultado = await cargarHallazgo(id, findingId)
  return { title: resultado.ok ? resultado.finding.titlePlain : findingsCopy.LISTA.titulo }
}

export default async function HallazgoPage({ params }: Props) {
  const { id, findingId } = await params
  const resultado = await cargarHallazgo(id, findingId)

  if (!resultado.ok) {
    if (resultado.motivo === 'no-existe') notFound()

    return (
      <>
        <PageHeader
          crumbs={[
            { label: 'Proyectos', href: '/proyectos' },
            { label: findingsCopy.LISTA.titulo, href: `/proyectos/${id}/hallazgos` },
          ]}
          title={ESTADOS.error.titulo}
        />
        <ErrorState
          kind={resultado.motivo === 'sin-permisos' ? 'forbidden' : 'error'}
          title={
            resultado.motivo === 'sin-permisos' ? ESTADOS.sinPermisos.titulo : ESTADOS.error.titulo
          }
          description={
            resultado.motivo === 'sin-permisos' ? ESTADOS.sinPermisos.texto : ESTADOS.error.texto
          }
          detail={resultado.detalle}
          action={
            <Link
              href={`/proyectos/${id}/hallazgos`}
              className={buttonStyles({ variant: 'secondary' })}
            >
              {findingsCopy.DETALLE.volver}
            </Link>
          }
        />
      </>
    )
  }

  const { proyecto, finding, video } = resultado

  return (
    <>
      <PageHeader
        display
        crumbs={[
          { label: 'Proyectos', href: '/proyectos' },
          { label: proyecto.nombre, href: `/proyectos/${proyecto.id}` },
          { label: findingsCopy.LISTA.titulo, href: `/proyectos/${proyecto.id}/hallazgos` },
        ]}
        eyebrow={PILLAR_LABEL[finding.pillar]}
        title={finding.titlePlain}
        meta={
          <SeverityIndicator
            severity={finding.severity}
            confidence={finding.confidence}
            status={finding.status}
            variante="suave"
          />
        }
        action={
          <CopyButton
            value={finding.fixPrompt}
            label={findingsCopy.ARREGLO.copiar}
            copiedLabel={findingsCopy.ARREGLO.copiado}
            failedLabel={findingsCopy.ARREGLO.fallo}
            variant="primary"
            size="md"
          />
        }
        secondaryActions={
          <Link
            href={`/proyectos/${proyecto.id}/hallazgos`}
            className={buttonStyles({ variant: 'ghost' })}
          >
            <ArrowLeft aria-hidden="true" strokeWidth={1.8} className="size-4" />
            {findingsCopy.DETALLE.volver}
          </Link>
        }
      />

      <FindingDetail finding={finding} video={video} soloLectura={MODO_DEMO} />
    </>
  )
}
