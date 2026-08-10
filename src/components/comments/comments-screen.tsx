'use client'

import { useRef, useState, useTransition } from 'react'
import { ChevronRight, Eraser, RefreshCw, ScanText, Sparkles } from 'lucide-react'
import { COMENTARIOS, ESTADOS } from '@/content/copy'
import { PageHeader } from '@/components/shell'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  Progress,
  SkeletonCard,
  ConfirmDialog,
  notify,
} from '@/components/ui'
import { CommentScanSummary } from './comment-scan-summary'
import { ReachSection } from './reach-section'
import { FunctionalCommentsPanel } from './functional-comments-panel'
import { CleanModeSelector } from './clean-mode-selector'
import { CleanPreview } from './clean-preview'
import { ApplyPanel } from './apply-panel'
import type { CommentsViewModel } from './model'
import type { CleanMode, CleanPlanView, Resultado } from './model-clean'

const n = (x: number) => x.toLocaleString('es-AR')

export interface CommentsScreenProps {
  proyectoId: string
  proyectoNombre: string
  modelo: CommentsViewModel | null
  /** Mensaje ya escrito para el usuario. Si viene, manda sobre todo lo demás. */
  error?: string | null
  onEscanear?: () => Promise<Resultado<CommentsViewModel>>
  onGenerarPlan?: (input: {
    mode: CleanMode
    excluidos: string[]
  }) => Promise<Resultado<CleanPlanView>>
}

/**
 * Pantalla de comentarios.
 *
 * El pedido original fue "un botón que borre todos los comentarios, sobre todo
 * los del frontend, por seguridad". El botón está y se encuentra solo. Lo que
 * la pantalla agrega es la parte que faltaba: *cuáles* se ven de verdad. Por
 * eso lo primero que se lee no es cuántos comentarios hay, sino cuántos los
 * puede leer cualquiera que entre al sitio.
 */
export function CommentsScreen({
  proyectoId,
  proyectoNombre,
  modelo: modeloInicial,
  error: errorInicial = null,
  onEscanear,
  onGenerarPlan,
}: CommentsScreenProps) {
  const [modelo, setModelo] = useState(modeloInicial)
  const [error, setError] = useState<string | null>(errorInicial)
  const [escaneando, empezarEscaneo] = useTransition()

  const [mode, setMode] = useState<CleanMode>('safe')
  const [excluidos, setExcluidos] = useState<ReadonlySet<string>>(new Set())
  const [plan, setPlan] = useState<CleanPlanView | null>(null)
  const [generando, empezarGeneracion] = useTransition()
  const [confirmando, setConfirmando] = useState(false)

  const panelLimpieza = useRef<HTMLDivElement | null>(null)
  const resultado = useRef<HTMLDivElement | null>(null)

  const archivosLimpiables = modelo?.archivos ?? []
  const incluidos = archivosLimpiables.filter((a) => !excluidos.has(a.file))
  const removiblesIncluidos = incluidos.reduce((t, a) => t + a.removibles, 0)
  const expuestosIncluidos = incluidos.reduce((t, a) => t + a.expuestos, 0)

  function irAlPanel() {
    panelLimpieza.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    panelLimpieza.current?.focus({ preventScroll: true })
  }

  function escanear() {
    if (!onEscanear) return
    setError(null)
    setPlan(null)
    empezarEscaneo(async () => {
      const r = await onEscanear()
      if (r.ok) setModelo(r.data)
      else setError(r.error)
    })
  }

  function generarPlan() {
    if (!onGenerarPlan) return
    setConfirmando(false)
    empezarGeneracion(async () => {
      const r = await onGenerarPlan({ mode, excluidos: [...excluidos] })
      if (!r.ok) {
        notify.problema(r.error)
        return
      }
      setPlan(r.data)
      // El resultado aparece abajo: llevamos la vista y el foco hasta ahí.
      requestAnimationFrame(() => {
        resultado.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        resultado.current?.focus({ preventScroll: true })
      })
    })
  }

  function alternarArchivo(file: string, incluir: boolean) {
    setPlan(null)
    setExcluidos((previos) => {
      const siguiente = new Set(previos)
      if (incluir) siguiente.delete(file)
      else siguiente.add(file)
      return siguiente
    })
  }

  const encabezado = (
    <PageHeader
      crumbs={[
        { label: 'Proyectos', href: '/proyectos' },
        { label: proyectoNombre, href: `/proyectos/${proyectoId}/hallazgos` },
        { label: 'Comentarios' },
      ]}
      title={COMENTARIOS.titulo}
      description={COMENTARIOS.bajada}
      action={
        modelo && modelo.removableCount > 0 ? (
          <Button icon={<Eraser />} iconEnd={<ChevronRight />} onClick={irAlPanel}>
            Sacar los comentarios
          </Button>
        ) : undefined
      }
    />
  )

  const volverARevisar =
    modelo && onEscanear ? (
      <Button
        variant="ghost"
        size="sm"
        icon={<RefreshCw />}
        onClick={escanear}
        loading={escaneando}
        loadingLabel="Revisando…"
      >
        Volver a revisar
      </Button>
    ) : undefined

  /* ── Estados sin datos ───────────────────────────────────────────────── */

  if (error) {
    return (
      <>
        {encabezado}
        <ErrorState
          title={ESTADOS.error.titulo}
          description={ESTADOS.error.texto}
          detail={error}
          action={
            onEscanear ? (
              <Button onClick={escanear} loading={escaneando} loadingLabel="Revisando…">
                {ESTADOS.error.accion}
              </Button>
            ) : undefined
          }
        />
      </>
    )
  }

  if (escaneando && !modelo) {
    return (
      <>
        {encabezado}
        <Card>
          <CardBody className="pt-5 sm:pt-6">
            <Progress label="Leyendo los archivos de tu proyecto" />
            <p className="mt-3 text-base text-ink-muted">
              Buscamos cada comentario y miramos si sale del sitio o se queda adentro. Tarda unos
              segundos.
            </p>
          </CardBody>
        </Card>
        <div className="mt-6 space-y-4" aria-hidden="true">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </>
    )
  }

  if (!modelo) {
    return (
      <>
        {encabezado}
        <EmptyState
          icon={<ScanText strokeWidth={1.6} />}
          title="Todavía no revisamos tus comentarios"
          description="Buscamos todos los comentarios de tu proyecto y te decimos cuáles se ven desde afuera. No modificamos nada."
          action={
            onEscanear ? (
              <Button icon={<ScanText />} onClick={escanear} loading={escaneando} loadingLabel="Revisando…">
                Revisar los comentarios
              </Button>
            ) : undefined
          }
        />
      </>
    )
  }

  /* ── Pantalla con datos ──────────────────────────────────────────────── */

  const sinNadaQueSacar = modelo.removableCount === 0

  return (
    <>
      {encabezado}

      {/* Sin animación de entrada a propósito.
          Todo esto llega armado desde el servidor y es la evidencia: que se
          vea no puede depender de que un script corra bien. El movimiento
          queda para lo que aparece por una acción de la persona. */}
      <div className="space-y-6">
        <CommentScanSummary modelo={modelo} action={volverARevisar} />

        {/* La respuesta a "¿pero se ven o no?", disponible sin ocupar la
            pantalla de quien ya lo sabe. */}
        <details className="group rounded-lg border border-line bg-canvas-sunken/50">
          <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg p-4 select-none hover:bg-surface-hover focus-visible:focus-ring">
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-subtle transition-transform duration-200 ease-out-soft group-open:rotate-90"
              strokeWidth={2}
            />
            <span className="text-base font-medium text-ink">{COMENTARIOS.explicacion.titulo}</span>
          </summary>
          <div className="border-t border-line px-4 py-4 sm:px-5">
            <p className="prose-lectura max-w-prose text-lg text-ink-muted">
              {COMENTARIOS.explicacion.texto}
            </p>
          </div>
        </details>

        {modelo.grupos.map((grupo) => (
          <ReachSection key={grupo.reach} grupo={grupo} />
        ))}

        <FunctionalCommentsPanel funcionales={modelo.funcionales} mode={mode} />
      </div>

      {/* ── El botón ─────────────────────────────────────────────────── */}

      <Card
        as="section"
        ref={panelLimpieza}
        tabIndex={-1}
        id="limpiar"
        className="mt-10 scroll-mt-6 focus:outline-none"
      >
        <CardHeader className="gap-2">
          <CardTitle as="h2">Sacar los comentarios</CardTitle>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">
            {sinNadaQueSacar
              ? 'No hay ninguno que se pueda sacar sin afectar tu proyecto. Los que quedan hacen falta.'
              : `Podemos sacar ${n(modelo.removableCount)} de los ${n(modelo.total)} comentarios de tu proyecto. Elegís cuánto y mirás el resultado antes de aplicar nada.`}
          </p>
        </CardHeader>

        {!sinNadaQueSacar && (
          <CardBody className="space-y-6">
            <CleanModeSelector value={mode} onChange={(m) => { setMode(m); setPlan(null) }} disabled={generando} />

            {archivosLimpiables.length > 1 && (
              <details className="group rounded-md border border-line">
                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md p-4 select-none hover:bg-surface-hover focus-visible:focus-ring">
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-ink-subtle transition-transform duration-200 ease-out-soft group-open:rotate-90"
                    strokeWidth={2}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-medium text-ink">Elegir archivos</span>
                    <span className="block text-sm text-ink-muted">
                      {excluidos.size === 0
                        ? `Entran los ${n(archivosLimpiables.length)} archivos con comentarios que se pueden sacar.`
                        : `Dejaste ${n(excluidos.size)} afuera de ${n(archivosLimpiables.length)}.`}
                    </span>
                  </span>
                </summary>

                <div className="border-t border-line">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                    <Button size="sm" variant="secondary" onClick={() => { setPlan(null); setExcluidos(new Set()) }}>
                      Incluir todos
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPlan(null)
                        setExcluidos(new Set(archivosLimpiables.map((a) => a.file)))
                      }}
                    >
                      Ninguno
                    </Button>
                  </div>

                  <ul className="max-h-80 overflow-y-auto p-2">
                    {archivosLimpiables.map((a) => (
                      <li key={a.file} className="min-w-0 px-2 py-1.5">
                        <Checkbox
                          checked={!excluidos.has(a.file)}
                          onChange={(e) => alternarArchivo(a.file, e.target.checked)}
                          label={
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                              <span className="font-mono text-xs break-all text-ink-muted">{a.file}</span>
                              <span className="text-2xs tabular text-ink-subtle">
                                {a.removibles} {a.removibles === 1 ? 'comentario' : 'comentarios'}
                                {a.expuestos > 0 && ` · ${a.expuestos} a la vista`}
                              </span>
                            </span>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            )}

            <Callout tone="verificado" title="Verificamos que tu app siga funcionando igual">
              {COMENTARIOS.garantia}
            </Callout>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                icon={<Sparkles />}
                onClick={() => setConfirmando(true)}
                loading={generando}
                loadingLabel="Preparando el cambio…"
                disabled={incluidos.length === 0}
              >
                Ver qué cambiaría
              </Button>
              <p className="text-sm text-ink-muted">
                {incluidos.length === 0
                  ? 'Elegí al menos un archivo.'
                  : `${n(removiblesIncluidos)} ${removiblesIncluidos === 1 ? 'comentario' : 'comentarios'} en ${n(incluidos.length)} ${incluidos.length === 1 ? 'archivo' : 'archivos'}.`}
              </p>
            </div>
          </CardBody>
        )}
      </Card>

      {/* ── Resultado ────────────────────────────────────────────────── */}

      <div ref={resultado} tabIndex={-1} className="scroll-mt-6 focus:outline-none">
        {plan && (
          <div className="mt-6 space-y-6">
            <CleanPreview plan={plan} />
            <ApplyPanel plan={plan} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title="¿Preparamos el cambio?"
        description="Todavía no se toca nada. Vas a poder mirarlo antes de aplicarlo."
        consequences={[
          `Vamos a sacar ${n(removiblesIncluidos)} ${removiblesIncluidos === 1 ? 'comentario' : 'comentarios'} de ${n(incluidos.length)} ${incluidos.length === 1 ? 'archivo' : 'archivos'}${expuestosIncluidos > 0 ? `, ${n(expuestosIncluidos)} de ellos a la vista de cualquiera` : ''}.`,
          'Antes de proponerte cada archivo comprobamos que siga funcionando exactamente igual. El que no dé idéntico queda afuera.',
          'No tocamos tu repositorio: te damos los cambios en un archivo para que los apliques vos.',
        ]}
        confirmLabel="Preparar el cambio"
        cancelLabel="Volver"
        loading={generando}
        onConfirm={generarPlan}
      />
    </>
  )
}
