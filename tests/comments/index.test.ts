import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { cleanProject, scanProject } from '@/server/comments'
import { allFixtureFiles, materializeFixtureRepo, materializeRepo } from '../fixtures/comments/load'

describe('scanProject — recorrido del repo', () => {
  it('analiza todos los archivos con comentarios y cuenta bien', async () => {
    const root = materializeFixtureRepo()
    const res = await scanProject(root)

    expect(res.scannedFiles).toBeGreaterThanOrEqual(Object.keys(allFixtureFiles()).length)
    expect(res.hits.length).toBeGreaterThan(10)
    expect(res.exposedCount).toBe(res.hits.filter((h) => h.reach === 'ships_to_browser').length)
    expect(res.riskyCount).toBe(res.hits.filter((h) => h.risk !== 'none').length)
    expect(res.removableCount).toBe(res.hits.filter((h) => !h.functional).length)
  })

  it('las rutas de los hallazgos son relativas al repo y con barras normales', async () => {
    const root = materializeFixtureRepo()
    const res = await scanProject(root)
    for (const h of res.hits) {
      expect(h.file.startsWith('/')).toBe(false)
      expect(h.file).not.toContain('\\')
    }
    expect(res.hits.some((h) => h.file === 'src/app/buscar/page.tsx')).toBe(true)
  })

  it('encuentra el secreto del HTML, que es el caso que más importa', async () => {
    const root = materializeFixtureRepo()
    const res = await scanProject(root)
    const enHtml = res.hits.filter((h) => h.file === 'public/index.html')
    expect(enHtml.some((h) => h.risk === 'secret' && h.reach === 'ships_to_browser')).toBe(true)
  })
})

describe('scanProject — qué se saltea', () => {
  it('respeta .gitignore', async () => {
    const root = materializeRepo({
      '.gitignore': 'ignorado/\n*.gen.ts\n',
      'src/a.ts': '// visible\nexport const a = 1\n',
      'ignorado/b.ts': '// oculto\nexport const b = 1\n',
      'src/c.gen.ts': '// generado\nexport const c = 1\n',
    })
    const res = await scanProject(root)
    const archivos = new Set(res.hits.map((h) => h.file))
    expect(archivos.has('src/a.ts')).toBe(true)
    expect(archivos.has('ignorado/b.ts')).toBe(false)
    expect(archivos.has('src/c.gen.ts')).toBe(false)
  })

  it('saltea node_modules y carpetas de build', async () => {
    const root = materializeRepo({
      'src/a.ts': '// visible\nexport const a = 1\n',
      'node_modules/x/i.ts': '// no\nexport const x = 1\n',
      '.next/y.ts': '// no\nexport const y = 1\n',
      'dist/z.js': '// no\nexport const z = 1\n',
    })
    const res = await scanProject(root)
    expect(res.hits.map((h) => h.file)).toEqual(['src/a.ts'])
  })

  it('saltea binarios y archivos enormes', async () => {
    const root = materializeRepo({ 'src/a.ts': '// visible\nexport const a = 1\n' })
    writeFileSync(join(root, 'src/logo.ts'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]))
    writeFileSync(join(root, 'src/enorme.ts'), `// grande\n${'x'.repeat(2 * 1024 * 1024 + 10)}`)
    const res = await scanProject(root)
    expect(res.hits.map((h) => h.file)).toEqual(['src/a.ts'])
  })
})

describe('cleanProject', () => {
  it('devuelve un plan y un patch coherentes entre sí', async () => {
    const root = materializeFixtureRepo()
    const { plan, patch } = await cleanProject(root, { mode: 'safe' })

    expect(plan.mode).toBe('safe')
    expect(plan.files.length).toBeGreaterThan(0)
    expect(plan.totalRemoved).toBeGreaterThan(0)
    for (const f of plan.files) expect(patch).toContain(`diff --git a/${f.file} b/${f.file}`)
  })

  it('nunca escribe en el repo del usuario', async () => {
    const root = materializeFixtureRepo()
    const antes = allFixtureFiles()
    await cleanProject(root, { mode: 'aggressive' })
    const res = await scanProject(root)
    // Si hubiéramos escrito, los comentarios ya no estarían.
    expect(res.hits.length).toBeGreaterThan(10)
    expect(Object.keys(antes).length).toBeGreaterThan(0)
  })

  it('permite limitar la limpieza a ciertos archivos', async () => {
    const root = materializeFixtureRepo()
    const { plan } = await cleanProject(root, { mode: 'safe', files: ['src/lib/notes.ts'] })
    expect(plan.files.map((f) => f.file)).toEqual(['src/lib/notes.ts'])
  })

  it('con un repo sin comentarios devuelve un plan vacío y patch vacío', async () => {
    const root = materializeRepo({ 'src/a.ts': 'export const a = 1\n' })
    const { plan, patch } = await cleanProject(root, { mode: 'safe' })
    expect(plan.files).toHaveLength(0)
    expect(patch).toBe('')
  })
})
