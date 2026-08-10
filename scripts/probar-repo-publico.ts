/**
 * Prueba real: bajar un repositorio público de GitHub, extraerlo y reconocer
 * con qué está hecho. Sin base de datos y sin cola: solo el camino nuevo.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseGithubUrl, downloadPublicRepoArchive } from '@/server/ingest/github'
import { extractZip } from '@/server/ingest/zip'
import { detectStack } from '@/server/ingest/stack'

const URLS = [
  'https://github.com/vercel/nextjs-postgres-nextauth-tailwindcss-template',
  'https://github.com/vercel/nextjs-postgres-nextauth-tailwindcss-template/tree/main',
  'https://github.com/vercel/nextjs-postgres-nextauth-tailwindcss-template.git',
  'github.com/vercel/nextjs-postgres-nextauth-tailwindcss-template',
  'https://github.com/no-existe-este-repo-jamas-12345/nada',
  'https://gitlab.com/otro/cosa',
  'cualquier cosa',
]

async function main() {
  console.log('=== 1. Parseo de direcciones ===')
  for (const url of URLS) {
    const ref = parseGithubUrl(url)
    console.log(`  ${ref ? `OK    ${ref.owner}/${ref.repo}${ref.ref ? '@' + ref.ref : ''}` : 'NULL  (rechazada)'}  ← ${url}`)
  }

  const objetivo = parseGithubUrl(URLS[0])
  if (!objetivo) throw new Error('El parser rechazó una dirección válida.')

  console.log('\n=== 2. Bajar el repositorio (sin token) ===')
  const arrancó = Date.now()
  const bytes = await downloadPublicRepoArchive(objetivo)
  console.log(`  ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB en ${Date.now() - arrancó} ms`)

  console.log('\n=== 3. Extraer ===')
  const dir = await mkdtemp(path.join(tmpdir(), 'caughtcode-prueba-'))
  try {
    const extraído = await extractZip(bytes, dir, { stripTopLevelDir: 'auto' })
    console.log(`  archivos: ${extraído.files.length}`)
    console.log(`  bytes: ${extraído.totalBytes}`)
    console.log(`  ignorados: ${extraído.skipped.length}`)
    console.log(`  primeros: ${extraído.files.slice(0, 6).join(', ')}`)

    console.log('\n=== 4. Reconocer con qué está hecho ===')
    const stack = await detectStack(dir)
    console.log(`  framework: ${stack.framework}`)
    console.log(`  lenguaje: ${stack.language}`)
    console.log(`  gestor: ${stack.packageManager}`)
    console.log(`  backends: ${stack.backends.join(', ') || '(ninguno)'}`)
    console.log(`  router: ${stack.routerKind}`)
    console.log(`  typescript: ${stack.hasTypescript}  tailwind: ${stack.hasTailwind}`)
    console.log(`  evidencia: ${stack.evidence.slice(0, 4).join(' | ')}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log('\n=== 5. Repositorio inexistente: qué error da ===')
  const fantasma = parseGithubUrl(URLS[4])
  if (fantasma) {
    try {
      await downloadPublicRepoArchive(fantasma)
      console.log('  PROBLEMA: no falló y debería haber fallado.')
    } catch (error) {
      const código = (error as { code?: string }).code ?? '(sin code)'
      console.log(`  code = ${código}`)
      console.log(`  mensaje técnico = ${(error as Error).message}`)
    }
  }
}

main().catch((error) => {
  console.error('FALLÓ:', error)
  process.exit(1)
})
