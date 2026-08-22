import type { Metadata } from 'next'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { ErrorState, buttonStyles } from '@/components/ui'
import {
  FindingsBoard,
  ReviewRunAction,
  contarSinResolver,
  estadoDeRevision,
  findingsCopy,
  peorGravedad,
} from '@/components/findings'
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
        <Encabezado projectId={id} nombre={null} bajada={null} conAccion={false} />
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

  /**
   * El botón de rehacer la revisión aparece solo cuando la revisión terminó.
   *
   * En cualquier otra fase el tablero ya trae su propia acción —empezar,
   * reintentar— y dos botones que hacen lo mismo en la misma pantalla se
   * anulan entre sí. Mientras corre o espera en la fila, directamente no
   * corresponde: volver a lanzarla ahí sería pagar dos veces lo mismo.
   */
  const revision = estadoDeRevision(run, trabajos, ahoraServidorMs)

  return (
    <>
      <Encabezado
        projectId={proyecto.id}
        nombre={proyecto.nombre}
        conAccion={revision.fase === 'lista'}
        hayResultados={findings.length > 0}
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
  conAccion,
  hayResultados = false,
}: {
  projectId: string
  nombre: string | null
  bajada: string | null
  /** El tablero de abajo ya ofrece la acción en el resto de las fases. */
  conAccion: boolean
  hayResultados?: boolean
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
        conAccion ? (
          <ReviewRunAction
            projectId={projectId}
            hayResultados={hayResultados}
            icon={<RefreshCw aria-hidden="true" strokeWidth={1.8} className="size-4" />}
          >
            {findingsCopy.LISTA.volverAAnalizar}
          </ReviewRunAction>
        ) : undefined
      }
    />
  )
}
