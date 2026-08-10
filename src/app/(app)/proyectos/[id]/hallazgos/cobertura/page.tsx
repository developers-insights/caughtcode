import type { Metadata } from 'next'
import Link from 'next/link'
import { CircleCheckBig } from 'lucide-react'
import { PageHeader } from '@/components/shell'
import { Badge, buttonStyles, Card, CardBody, EmptyState, ErrorState } from '@/components/ui'
import { findingsCopy } from '@/components/findings'
import { ESTADOS } from '@/content/copy'
import { PILLAR_LABEL, type Pillar, type CoverageEntry } from '@/lib/types/domain'
import { cargarCobertura } from '../data'

export const metadata: Metadata = {
  title: findingsCopy.COBERTURA.titulo,
}

interface Props {
  params: Promise<{ id: string }>
}

const ORDEN_PILARES: Pillar[] = ['security', 'completeness', 'store_hygiene']

export default async function CoberturaPage({ params }: Props) {
  const { id } = await params
  const resultado = await cargarCobertura(id)

  if (!resultado.ok) {
    return (
      <ErrorState
        kind={resultado.motivo === 'sin-permisos' ? 'forbidden' : 'error'}
        title={resultado.motivo === 'sin-permisos' ? ESTADOS.sinPermisos.titulo : ESTADOS.error.titulo}
        description={resultado.motivo === 'sin-permisos' ? ESTADOS.sinPermisos.texto : ESTADOS.error.texto}
        detail={resultado.detalle}
        action={
          <Link href="/proyectos" className={buttonStyles({ variant: 'secondary' })}>
            {ESTADOS.sinPermisos.accion}
          </Link>
        }
      />
    )
  }

  const { proyecto, coverage } = resultado

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Proyectos', href: '/proyectos' },
          { label: proyecto.nombre, href: `/proyectos/${proyecto.id}` },
          { label: findingsCopy.LISTA.titulo, href: `/proyectos/${proyecto.id}/hallazgos` },
          { label: findingsCopy.COBERTURA.titulo },
        ]}
        title={findingsCopy.COBERTURA.titulo}
        description={
          coverage ? findingsCopy.COBERTURA.resumen(contarRevisados(coverage.entries), coverage.totalChequeos) : null
        }
        action={
          <Link href={`/proyectos/${proyecto.id}/hallazgos`} className={buttonStyles({ variant: 'secondary' })}>
            {findingsCopy.COBERTURA.volver}
          </Link>
        }
      />

      {!coverage ? (
        <EmptyState
          icon={<CircleCheckBig aria-hidden="true" strokeWidth={1.7} className="size-7" />}
          title={ESTADOS.vacioHallazgos.titulo}
          description="Todavía no terminó ninguna revisión de este proyecto."
        />
      ) : (
        <div className="space-y-5">
          {ORDEN_PILARES.map((pilar) => (
            <AreaCobertura key={pilar} pilar={pilar} entradas={porPilar(coverage.entries, pilar)} />
          ))}
        </div>
      )}
    </>
  )
}

function contarRevisados(entries: CoverageEntry[]): number {
  return entries.filter((e) => e.status !== 'salteado').length
}

function porPilar(entries: CoverageEntry[], pilar: Pillar): CoverageEntry[] {
  return entries.filter((e) => e.pillar === pilar)
}

function AreaCobertura({ pilar, entradas }: { pilar: Pillar; entradas: CoverageEntry[] }) {
  if (entradas.length === 0) return null

  const limpios = entradas.filter((e) => e.status === 'sin_hallazgos').length
  const conHallazgos = entradas.filter((e) => e.status === 'con_hallazgos').length
  const fallados = entradas.filter((e) => e.status === 'fallado').length
  const salteados = entradas.filter((e) => e.status === 'salteado')

  // Un mismo motivo ("falta conectar la base") puede afectar varios chequeos.
  // Se agrupa para no repetir la misma frase cinco veces.
  const motivos = new Map<string, number>()
  for (const s of salteados) {
    if (!s.reasonPlain) continue
    motivos.set(s.reasonPlain, (motivos.get(s.reasonPlain) ?? 0) + 1)
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-ink">{PILLAR_LABEL[pilar]}</h2>
          <div className="flex flex-wrap gap-1.5">
            {conHallazgos > 0 && (
              <Badge size="sm" tone="expuesto">
                {findingsCopy.COBERTURA.conHallazgos(conHallazgos)}
              </Badge>
            )}
            {limpios > 0 && (
              <Badge size="sm" tone="verificado">
                {limpios === 1 ? '1 revisión limpia' : `${limpios} revisiones limpias`}
              </Badge>
            )}
            {fallados > 0 && (
              <Badge size="sm" tone="neutral">
                {fallados === 1 ? '1 sin terminar' : `${fallados} sin terminar`}
              </Badge>
            )}
          </div>
        </div>

        {limpios + conHallazgos === 0 && motivos.size === 0 && (
          <p className="text-sm text-ink-muted">{findingsCopy.COBERTURA.sinNovedadesEnArea}</p>
        )}

        {motivos.size > 0 && (
          <div className="space-y-2 rounded-md border border-dashed border-line-strong bg-canvas-sunken/60 p-3">
            <p className="text-sm font-medium text-ink">{findingsCopy.COBERTURA.faltaConectarTitulo}</p>
            <ul className="space-y-1.5">
              {[...motivos.entries()].map(([motivo, cantidad]) => (
                <li key={motivo} className="text-sm text-ink-muted">
                  {motivo}{' '}
                  <span className="text-ink-subtle">— {findingsCopy.COBERTURA.afecta(cantidad)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
