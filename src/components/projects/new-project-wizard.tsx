'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, FileArchive, FolderCode, GitBranch, Link2, Rocket, ScanSearch } from 'lucide-react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Input,
  Progress,
  Select,
  Spinner,
  notify,
} from '@/components/ui'
import { ONBOARDING, COSTO } from '@/content/copy'
import { formatUsd } from '@/lib/utils'
import { SourceDropZone } from './source-drop-zone'
import { frameworkLabel } from './stack-label'
import {
  createProjectFromGithubAction,
  createProjectFromPublicUrlAction,
  createProjectFromZipAction,
  listGithubInstallationsAction,
  listGithubReposAction,
  startAuditAction,
  validatePublicRepoUrlAction,
  type CreateProjectResult,
  type GithubStatusResult,
} from '@/app/(app)/proyectos/nuevo/actions'
import type { GithubInstallation, GithubRepo } from '@/server/ingest/github'

type Fuente = 'zip' | 'github' | 'publico' | null

interface CreatedProject {
  projectId: string
  name: string
  fileCount: number
  routeCount: number
  frameworkLabel: string | undefined
  backends: string[]
  warnings: string[]
  costUsd: number
  costSummary: string
  costUnits: string[]
}

function fromResult(name: string, result: Extract<CreateProjectResult, { ok: true }>): CreatedProject {
  return {
    projectId: result.projectId,
    name,
    fileCount: result.preview.fileCount,
    routeCount: result.preview.routeCount,
    frameworkLabel: frameworkLabel(result.preview.stack.framework),
    backends: result.preview.stack.backends.filter((b) => b !== 'none'),
    warnings: result.preview.warnings,
    costUsd: result.cost.costUsd,
    costSummary: result.cost.summaryPlain,
    costUnits: result.cost.unitsPlain,
  }
}

export function NewProjectWizard({ githubStatus }: { githubStatus: GithubStatusResult }) {
  const router = useRouter()

  const [fuente, setFuente] = useState<Fuente>(null)
  const [nombre, setNombre] = useState('')
  const [creando, startCreacion] = useTransition()
  const [errorCreacion, setErrorCreacion] = useState<string | null>(null)
  const [creado, setCreado] = useState<CreatedProject | null>(null)

  // GitHub
  const [instalaciones, setInstalaciones] = useState<GithubInstallation[] | null>(null)
  const [cargandoInstalaciones, startCargaInstalaciones] = useTransition()
  const [installationId, setInstallationId] = useState<number | null>(null)
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [cargandoRepos, startCargaRepos] = useTransition()
  const [repoElegido, setRepoElegido] = useState<string>('')

  // Repositorio público (pegar la dirección, sin GitHub App)
  const [repoUrl, setRepoUrl] = useState('')
  const [repoPublico, setRepoPublico] = useState<{ owner: string; repo: string } | null>(null)
  const [repoUrlInvalido, setRepoUrlInvalido] = useState(false)
  const [, startValidacionUrl] = useTransition()
  const repoUrlRef = useRef('')

  // Paso 2
  const [deployedUrl, setDeployedUrl] = useState('')
  const [databaseUrl, setDatabaseUrl] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [iniciando, startInicio] = useTransition()

  function subirZip(file: File) {
    setErrorCreacion(null)
    const nombreFinal = nombre.trim() || file.name.replace(/\.zip$/i, '')
    startCreacion(async () => {
      const formData = new FormData()
      formData.set('archivo', file)
      formData.set('nombre', nombreFinal)
      const result = await createProjectFromZipAction(formData)
      if (!result.ok) {
        setErrorCreacion(result.error)
        return
      }
      setCreado(fromResult(nombreFinal, result))
    })
  }

  function buscarInstalaciones() {
    startCargaInstalaciones(async () => {
      const result = await listGithubInstallationsAction()
      if (!result.ok) {
        setErrorCreacion(result.error)
        return
      }
      setInstalaciones(result.installations)
      if (result.installations.length === 1) {
        elegirInstalacion(result.installations[0]!.id)
      }
    })
  }

  function elegirInstalacion(id: number) {
    setInstallationId(id)
    setRepos(null)
    setRepoElegido('')
    startCargaRepos(async () => {
      const result = await listGithubReposAction(id)
      if (!result.ok) {
        setErrorCreacion(result.error)
        return
      }
      setRepos(result.repos)
    })
  }

  function usarRepo() {
    if (!installationId || !repoElegido) return
    const [owner, repo] = repoElegido.split('/')
    if (!owner || !repo) return
    setErrorCreacion(null)
    startCreacion(async () => {
      const result = await createProjectFromGithubAction({ installationId, owner, repo })
      if (!result.ok) {
        setErrorCreacion(result.error)
        return
      }
      setCreado(fromResult(nombre.trim() || repo, result))
    })
  }

  // Valida en vivo con el mismo parser que usa el alta real (`parseGithubUrl`,
  // vía server action: es server-only, no se puede importar acá) — así no
  // dejamos que el usuario mande una dirección que ya sabemos que va a fallar.
  useEffect(() => {
    const value = repoUrl.trim()
    repoUrlRef.current = value
    setRepoPublico(null)
    setRepoUrlInvalido(false)
    if (!value) return

    const timer = setTimeout(() => {
      startValidacionUrl(async () => {
        const result = await validatePublicRepoUrlAction(value)
        if (repoUrlRef.current !== value) return // el usuario ya escribió otra cosa
        if (result.ok) setRepoPublico({ owner: result.owner, repo: result.repo })
        else setRepoUrlInvalido(true)
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [repoUrl])

  function usarUrlPublica() {
    if (!repoPublico) return
    setErrorCreacion(null)
    startCreacion(async () => {
      const result = await createProjectFromPublicUrlAction({ url: repoUrl.trim() })
      if (!result.ok) {
        setErrorCreacion(result.error)
        return
      }
      setCreado(fromResult(nombre.trim() || repoPublico.repo, result))
    })
  }

  function confirmarAuditoria() {
    if (!creado) return
    startInicio(async () => {
      const result = await startAuditAction({
        projectId: creado.projectId,
        deployedUrl: deployedUrl || undefined,
        databaseUrl: databaseUrl || undefined,
      })
      if (!result.ok) {
        notify.problema(result.error ?? 'No pudimos poner en marcha el análisis.')
        return
      }
      setConfirmOpen(false)
      notify.ok('Arrancamos. Te vamos a mostrar los hallazgos a medida que aparezcan.')
      router.push(`/proyectos/${creado.projectId}`)
    })
  }

  /* ── Paso 2: ya tenemos proyecto ─────────────────────────────────────── */
  if (creado) {
    return (
      <div className="space-y-6">
        <Card tone="verificado" emphasis="marked">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ScanSearch className="size-5 text-verificado-text" strokeWidth={1.8} />
              <CardTitle as="h2" className="text-lg">
                Ya vimos un primer vistazo de &ldquo;{creado.name}&rdquo;
              </CardTitle>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {creado.frameworkLabel && <Badge>{creado.frameworkLabel}</Badge>}
              {creado.backends.map((b) => (
                <Badge key={b} tone="neutral">
                  {b}
                </Badge>
              ))}
              <Badge tone="neutral">
                {creado.fileCount} archivo{creado.fileCount === 1 ? '' : 's'}
              </Badge>
              <Badge tone="neutral">
                {creado.routeCount} pantalla{creado.routeCount === 1 ? '' : 's'}
              </Badge>
            </div>
            {creado.warnings.length > 0 && (
              <p className="text-sm text-ink-muted">{creado.warnings.join(' ')}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {ONBOARDING.urlDesplegada.titulo}
            </CardTitle>
            <CardDescription>{ONBOARDING.urlDesplegada.texto}</CardDescription>
          </CardHeader>
          <CardBody className="space-y-5">
            <Input
              label="Dirección publicada"
              placeholder={ONBOARDING.urlDesplegada.placeholder}
              type="url"
              value={deployedUrl}
              onChange={(e) => setDeployedUrl(e.target.value)}
              optional
              hint={ONBOARDING.urlDesplegada.opcional}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2" className="text-lg">
              {ONBOARDING.baseDeDatos.titulo}
            </CardTitle>
            <CardDescription>{ONBOARDING.baseDeDatos.texto}</CardDescription>
          </CardHeader>
          <CardBody className="space-y-5">
            <Input
              label="Cadena de conexión de solo lectura"
              placeholder="postgresql://readonly_user:•••@db.tu-proyecto.supabase.co:5432/postgres"
              type="password"
              autoComplete="off"
              value={databaseUrl}
              onChange={(e) => setDatabaseUrl(e.target.value)}
              optional
              hint={ONBOARDING.baseDeDatos.opcional}
            />
          </CardBody>
        </Card>

        <div className="flex justify-end">
          <Button size="lg" icon={<Rocket strokeWidth={1.9} />} onClick={() => setConfirmOpen(true)}>
            Auditar mi app
          </Button>
        </div>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`¿Analizar "${creado.name}"?`}
          consequences={[
            'Vamos a leer tu código y, si nos diste la dirección, a navegar tu app publicada.',
            'No escribimos nada en tu base de datos.',
          ]}
          cost={{ usd: creado.costUsd, units: creado.costUnits.join(' · ') }}
          confirmLabel="Analizar"
          loading={iniciando}
          onConfirm={confirmarAuditoria}
        />
      </div>
    )
  }

  /* ── Paso 1: elegir fuente ────────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      {errorCreacion && <Callout tone="expuesto">{errorCreacion}</Callout>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setFuente('publico')}
          aria-pressed={fuente === 'publico'}
          className="text-left focus-visible:focus-ring rounded-lg"
        >
          <Card
            interactive
            emphasis={fuente === 'publico' ? 'marked' : 'plain'}
            tone={fuente === 'publico' ? 'revisar' : 'neutral'}
          >
            <CardBody className="flex items-start gap-3 pt-5">
              <Link2 className="mt-0.5 size-5 shrink-0 text-ink-muted" strokeWidth={1.8} />
              <div>
                <p className="text-lg font-semibold text-ink">{ONBOARDING.fuentes.publico.titulo}</p>
                <p className="mt-1 text-sm text-ink-muted">{ONBOARDING.fuentes.publico.texto}</p>
              </div>
            </CardBody>
          </Card>
        </button>

        <button
          type="button"
          onClick={() => setFuente('github')}
          aria-pressed={fuente === 'github'}
          className="text-left focus-visible:focus-ring rounded-lg"
        >
          <Card
            interactive
            emphasis={fuente === 'github' ? 'marked' : 'plain'}
            tone={fuente === 'github' ? 'revisar' : 'neutral'}
          >
            <CardBody className="flex items-start gap-3 pt-5">
              <GitBranch className="mt-0.5 size-5 shrink-0 text-ink-muted" strokeWidth={1.8} />
              <div>
                <p className="text-lg font-semibold text-ink">{ONBOARDING.fuentes.github.titulo}</p>
                <p className="mt-1 text-sm text-ink-muted">{ONBOARDING.fuentes.github.texto}</p>
              </div>
            </CardBody>
          </Card>
        </button>

        <button
          type="button"
          onClick={() => setFuente('zip')}
          aria-pressed={fuente === 'zip'}
          className="text-left focus-visible:focus-ring rounded-lg"
        >
          <Card
            interactive
            emphasis={fuente === 'zip' ? 'marked' : 'plain'}
            tone={fuente === 'zip' ? 'revisar' : 'neutral'}
          >
            <CardBody className="flex items-start gap-3 pt-5">
              <FileArchive className="mt-0.5 size-5 shrink-0 text-ink-muted" strokeWidth={1.8} />
              <div>
                <p className="text-lg font-semibold text-ink">{ONBOARDING.fuentes.zip.titulo}</p>
                <p className="mt-1 text-sm text-ink-muted">{ONBOARDING.fuentes.zip.texto}</p>
              </div>
            </CardBody>
          </Card>
        </button>
      </div>

      {fuente === 'publico' && (
        <Card>
          <CardBody className="space-y-5 pt-6">
            <Input
              label={ONBOARDING.fuentes.publico.titulo}
              placeholder={ONBOARDING.fuentes.publico.placeholder}
              hint={ONBOARDING.fuentes.publico.ayuda}
              error={repoUrlInvalido ? ONBOARDING.erroresDeRepositorio.direccionInvalida : undefined}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              type="url"
              autoComplete="off"
              spellCheck={false}
              disabled={creando}
              suffix={
                repoUrl.trim() && !repoPublico && !repoUrlInvalido ? <Spinner size="sm" /> : undefined
              }
            />

            {repoPublico && (
              <Button
                icon={<ArrowRight strokeWidth={1.9} />}
                loading={creando}
                loadingLabel="Trayendo tu código…"
                onClick={usarUrlPublica}
              >
                Usar este repositorio
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {fuente === 'zip' && (
        <Card>
          <CardBody className="space-y-5 pt-6">
            <Input
              label="Nombre del proyecto"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Mi proyecto"
              hint="Lo podés cambiar después desde los ajustes."
            />
            <SourceDropZone onFile={subirZip} disabled={creando} />
            {creando && <Progress label="Subiendo y revisando tu proyecto" />}
          </CardBody>
        </Card>
      )}

      {fuente === 'github' && (
        <Card>
          <CardBody className="space-y-5 pt-6">
            {!githubStatus.ready ? (
              <Callout tone="revisar" title="Todavía no está lista la conexión">
                {githubStatus.message}
              </Callout>
            ) : (
              <>
                {!instalaciones && (
                  <Button
                    variant="secondary"
                    icon={<FolderCode strokeWidth={1.8} />}
                    loading={cargandoInstalaciones}
                    loadingLabel="Buscando…"
                    onClick={buscarInstalaciones}
                  >
                    Buscar mis repositorios
                  </Button>
                )}

                {instalaciones && instalaciones.length === 0 && (
                  <Callout tone="revisar" title="No encontramos ninguna instalación">
                    {githubStatus.installUrl ? (
                      <>
                        Instalá la app de caughtcode en los repositorios que querés auditar y volvé
                        acá.{' '}
                        <a
                          href={githubStatus.installUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-medium underline underline-offset-4"
                        >
                          Instalar en GitHub
                        </a>
                      </>
                    ) : (
                      'Conectá tu cuenta de GitHub primero.'
                    )}
                  </Callout>
                )}

                {instalaciones && instalaciones.length > 1 && (
                  <Select
                    label="Cuenta u organización"
                    placeholder="Elegí una cuenta"
                    value={installationId ?? ''}
                    onChange={(e) => elegirInstalacion(Number(e.target.value))}
                  >
                    {instalaciones.map((inst) => (
                      <option key={inst.id} value={inst.id}>
                        {inst.accountLogin}
                      </option>
                    ))}
                  </Select>
                )}

                {installationId && cargandoRepos && <Progress label="Buscando tus repositorios" />}

                {repos && repos.length > 0 && (
                  <Select
                    label="Repositorio"
                    placeholder="Elegí un repositorio"
                    value={repoElegido}
                    onChange={(e) => setRepoElegido(e.target.value)}
                  >
                    {repos.map((repo) => (
                      <option key={repo.id} value={`${repo.owner}/${repo.name}`}>
                        {repo.fullName}
                      </option>
                    ))}
                  </Select>
                )}

                {repoElegido && (
                  <Button
                    icon={<ArrowRight strokeWidth={1.9} />}
                    loading={creando}
                    loadingLabel="Trayendo tu código…"
                    onClick={usarRepo}
                  >
                    Usar este repositorio
                  </Button>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}

      <p className="text-center text-xs text-ink-subtle">
        {COSTO.antesDeGastar} {COSTO.sinCreditos}
      </p>
    </div>
  )
}
