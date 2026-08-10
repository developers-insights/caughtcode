import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildCleanPlan } from '@/server/comments/cleaner'
import { buildPatch, unifiedDiff } from '@/server/comments/patch'
import { scanFile } from '@/server/comments/scanner'
import {
  FIXTURE_PATHS,
  allFixtureFiles,
  fixture,
  fixturePath,
  materializeRepo,
} from '../fixtures/comments/load'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('patch — formato del diff unificado', () => {
  const diff = unifiedDiff('src/a.ts', 'const a = 1 // nota\nconst b = 2\n', 'const a = 1\nconst b = 2\n')

  it('lleva las cabeceras que espera git', () => {
    expect(diff).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(diff).toContain('--- a/src/a.ts')
    expect(diff).toContain('+++ b/src/a.ts')
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
  })

  it('marca la línea que sale y la que entra', () => {
    expect(diff).toContain('-const a = 1 // nota')
    expect(diff).toContain('+const a = 1')
  })

  it('devuelve vacío si no hay cambios', () => {
    expect(unifiedDiff('a.ts', 'const a = 1\n', 'const a = 1\n')).toBe('')
  })

  it('marca la falta de salto de línea final', () => {
    const d = unifiedDiff('a.ts', 'const a = 1 // x', 'const a = 1')
    expect(d).toContain('\\ No newline at end of file')
  })
})

describe('patch — se aplica de verdad con git apply', () => {
  const nombres = Object.keys(FIXTURE_PATHS)
  const files = nombres.map((n) => scanFile({ file: fixturePath(n), text: fixture(n) }))
  const plan = buildCleanPlan(files, { mode: 'safe' })
  const patch = buildPatch(plan)

  it('genera un patch para todos los archivos con cambios', () => {
    expect(patch.length).toBeGreaterThan(0)
    for (const f of plan.files) expect(patch).toContain(`diff --git a/${f.file} b/${f.file}`)
  })

  it('git apply lo acepta y produce exactamente el "después" del plan', () => {
    const root = materializeRepo(allFixtureFiles())
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@caughtcode.local')
    git(root, 'config', 'user.name', 'test')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')

    // Falla con un error claro si el patch está mal formado.
    execFileSync('git', ['apply', '--check', '-'], { cwd: root, input: patch })
    execFileSync('git', ['apply', '-'], { cwd: root, input: patch })

    for (const f of plan.files) {
      expect(readFileSync(join(root, f.file), 'utf8')).toBe(f.after)
    }
    expect(nombres.length).toBeGreaterThan(0)
  })
})
