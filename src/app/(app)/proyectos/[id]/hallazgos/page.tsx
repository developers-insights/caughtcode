import type { Metadata } from 'next'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { ErrorState, buttonStyles } from '@/components/ui'
import { FindingsBoard, contarSinResolver, findingsCopy, peorGravedad } from '@/components/findings'
import { ESTADOS } from '@/content/copy'
import { MODO_DEMO, cargarHallazgos } from './data'

export const metadata: Metadata = {
  title: findingsCopy.LISTA.titulo,
}

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ estado?: string }>
}

export default async function HallazgosPage({ params, searchParams }: Props) {
  const { id } = await params
  const { estado } = await searchParams

  const resultado = await cargarHallazgos(id, estado)

  if (!resultado.ok) {
    return (
      <>
        <Encabezado projectId={id} nombre={null} bajada={null} />
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
            <Link href="/proyectos" className={buttonStyles({ variant: 'secondary' })}>
              {ESTADOS.sinPermisos.accion}
            </Link>
          }
        />
      </>
    )
  }

  const { proyecto, run, findings, videos, trabajos, ahoraServidorMs } = resultado.datos
  const sinResolver = contarSinResolver(findings)
  const peor = peorGravedad(findings)
  const hayUrgente = peor === 'critical' || peor === 'high'

  return (
    <>
      <Encabezado
        projectId={proyecto.id}
        nombre={proyecto.nombre}
        bajada={
          sinResolver === 0
            ? null
            : hayUrgente
              ? findingsCopy.LISTA.bajadaConUrgentes
              : findingsCopy.LISTA.bajadaSinUrgentes
        }
      />

      <FindingsBoard
        projectId={proyecto.id}
        findingsIniciales={findings}
        runInicial={run}
        trabajos={trabajos}
        ahoraServidorMs={ahoraServidorMs}
        videos={videos}
        live={!MODO_DEMO}
      />
    </>
  )
}

function Encabezado({
  projectId,
  nombre,
  bajada,
}: {
  projectId: string
  nombre: string | null
  bajada: string | null
}) {
  return (
    <PageHeader
      crumbs={[
        { label: 'Proyectos', href: '/proyectos' },
        ...(nombre ? [{ label: nombre, href: `/proyectos/${projectId}` }] : []),
        { label: findingsCopy.LISTA.titulo },
      ]}
      title={findingsCopy.LISTA.titulo}
      description={bajada}
      action={
        <Link href={`/proyectos/${projectId}`} className={buttonStyles({ variant: 'secondary' })}>
          <RefreshCw aria-hidden="true" strokeWidth={1.8} className="size-4" />
          {findingsCopy.LISTA.volverAAnalizar}
        </Link>
      }
    />
  )
}
