/**
 * Auditoría completa de un repositorio público, de punta a punta y contra el
 * mundo real: baja el repo de GitHub, lo indexa y le corre los chequeos.
 *
 * Es la prueba que faltaba. `scripts/probar-repo-publico.ts` cubre solo la
 * ingesta (bajar, extraer, reconocer el stack) y los tests de `tests/` corren
 * cada motor por separado contra fixtures. Acá se encadenan los tres pasos
 * sobre código real que nadie preparó para que el resultado dé bien.
 *
 * No toca la base de datos ni la cola: eso ya está cubierto por los tests de
 * `tests/jobs/`. Lo que se prueba acá es que los motores producen hallazgos
 * de verdad sobre código de verdad.
 *
 * Tampoco usa el modelo de lenguaje (`usarModelo: false`), así que corre sin
 * `ANTHROPIC_API_KEY` y es determinística. Eso no es una limitación de la
 * prueba sino una decisión del producto: el modelo afina, no detecta.
 *
 *   pnpm tsx --conditions=react-server scripts/auditar-repo-real.ts [url-del-repo]
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseGithubUrl, downloadPublicRepoArchive } from '@/server/ingest/github'
import { extractZip } from '@/server/ingest/zip'
import { buildCodeIndex } from '@/server/analysis'
import { correrChequeos, resumenDeCobertura } from '@/server/checks/runner'

import type { CheckRunContext } from '@/server/checks/lib/context'

const REPO_POR_DEFECTO = 'https://github.com/vercel/nextjs-postgres-nextauth-tailwindcss-template'

function ms(desde: number): string {
  return `${((Date.now() - desde) / 1000).toFixed(1)}s`
}

async function main() {
  const url = process.argv[2] ?? REPO_POR_DEFECTO
  const objetivo = parseGithubUrl(url)
  if (!objetivo) {
    console.error(`No pude entender la dirección: ${url}`)
    process.exit(1)
  }

  console.log(`\nAuditando ${objetivo.owner}/${objetivo.repo}\n${'─'.repeat(60)}`)
  const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-auditoria-'))

  try {
    /* ── 1. Bajar y extraer ──────────────────────────────────────────── */
    let t = Date.now()
    const bytes = await downloadPublicRepoArchive(objetivo)
    const extraido = await extractZip(bytes, dir, { stripTopLevelDir: 'auto' })
    console.log(
      `1. Ingesta        ${extraido.files.length} archivos · ` +
        `${(extraido.totalBytes / 1024).toFixed(0)} KB · ${ms(t)}`,
    )

    /* ── 2. Indexar ──────────────────────────────────────────────────── */
    t = Date.now()
    const { index, stack } = await buildCodeIndex({ root: dir })
    console.log(
      `2. Índice         ${index.fileCount} archivos · ${index.routes.length} rutas · ` +
        `${index.symbols.length} símbolos · stack: ${stack.framework}/${stack.language} · ${ms(t)}`,
    )

    /* ── 3. Chequeos ─────────────────────────────────────────────────── */
    t = Date.now()
    const ctx: CheckRunContext = {
      projectId: 'prueba-local',
      analysisRunId: 'prueba-local',
      repoPath: dir,
      index,
      stack,
      deployedUrl: null,
      databaseUrl: null,
      readFile: async (rel) => {
        try {
          return await readFile(path.join(dir, rel), 'utf8')
        } catch {
          return null
        }
      },
      log: () => {},
    }

    const resultado = await correrChequeos(ctx, { usarModelo: false })
    console.log(
      `3. Chequeos       ${resultado.chequeosCorridos} corridos · ` +
        `${resultado.findings.length} hallazgos · ${resultado.salteados.length} salteados · ${ms(t)}`,
    )

    /* ── 4. Lo que vería el usuario ──────────────────────────────────── */
    const rankeados = resultado.findings
    const cobertura = resumenDeCobertura(resultado)

    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Hallazgos: ${rankeados.length}`)
    console.log(`Cobertura: ${cobertura.revisados} revisados · ${cobertura.sinRevisar} sin revisar`)
    for (const falta of cobertura.faltantesPlain) console.log(`  · ${falta}`)

    const destacados = resultado.destacados
    if (destacados.length === 0) {
      console.log('\nNingún hallazgo. Puede ser correcto: revisá la cobertura de acá arriba.')
    } else {
      console.log(`\nLos ${destacados.length} primeros, como los vería el usuario:\n`)
      for (const [i, h] of destacados.entries()) {
        const d = h as unknown as Record<string, unknown>
        const titulo = d.titlePlain ?? d.title ?? d.checkId
        const sev = d.severity ?? '?'
        const ev = Array.isArray(d.evidence) ? d.evidence.length : 0
        console.log(`  ${i + 1}. [${String(sev).toUpperCase()}] ${titulo}`)
        console.log(`     evidencia: ${ev} pieza(s)`)
        if (typeof d.explanationPlain === 'string') {
          console.log(`     ${d.explanationPlain.slice(0, 140)}`)
        }
        console.log('')
      }
    }

    /* ── 5. Verificaciones duras de las reglas del producto ──────────── */
    console.log(`${'─'.repeat(60)}\nReglas del producto:`)

    const sinEvidencia = rankeados.filter((h) => {
      const ev = (h as unknown as { evidence?: unknown[] }).evidence
      return !Array.isArray(ev) || ev.length === 0
    })
    console.log(
      sinEvidencia.length === 0
        ? '  OK   Todo hallazgo tiene evidencia (regla dura #1).'
        : `  FALLA ${sinEvidencia.length} hallazgo(s) sin evidencia (viola la regla dura #1).`,
    )

    console.log(
      destacados.length <= 3
        ? '  OK   Como mucho 3 destacados (regla dura #2).'
        : `  FALLA ${destacados.length} destacados (viola la regla dura #2).`,
    )

    const conMarcador = rankeados.filter((h) => JSON.stringify(h).includes('{{'))
    console.log(
      conMarcador.length === 0
        ? '  OK   Ningún marcador {{...}} sin completar.'
        : `  FALLA ${conMarcador.length} hallazgo(s) con marcador sin completar.`,
    )

    if (resultado.fallados.length > 0) {
      console.log(`\n  ${resultado.fallados.length} chequeo(s) fallaron:`)
      for (const f of resultado.fallados.slice(0, 5)) {
        console.log(`    - ${f.checkId}: ${String(f.error).slice(0, 100)}`)
      }
    }

    const problemas = sinEvidencia.length + conMarcador.length + resultado.fallados.length
    console.log(`\n${problemas === 0 ? 'Auditoría limpia.' : `${problemas} problema(s) detectados.`}\n`)

    /*
     * `process.exitCode` y no `process.exit()`: tree-sitter deja handles de
     * libuv abiertos y salir de golpe los cierra a la fuerza, lo que en Windows
     * termina en un `Assertion failed` de Node después de la última línea. Se
     * ve como si el script hubiera fallado, y no falló.
     */
    process.exitCode = problemas === 0 ? 0 : 1
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\nFALLÓ:', error)
  process.exitCode = 1
})
