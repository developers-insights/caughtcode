import { afterEach, describe, expect, it, vi } from 'vitest'

import { HandlerNotRegisteredError, isRetryable } from '@/server/jobs/errors'
import {
  JOB_KINDS,
  JOB_KIND_LABEL,
  getHandler,
  hasRealHandler,
  isJobKind,
  pendingKinds,
  registerHandler,
  registeredKinds,
  resetHandlers,
} from '@/server/jobs/registry'

afterEach(() => {
  resetHandlers()
})

describe('catálogo de tipos de trabajo', () => {
  it('tiene una etiqueta sin jerga para cada tipo', () => {
    expect(JOB_KINDS.length).toBeGreaterThan(0)
    for (const kind of JOB_KINDS) {
      const label = JOB_KIND_LABEL[kind]
      expect(label).toBeTruthy()
      // Nada de siglas ni nombres de tabla en lo que ve el usuario.
      expect(label).not.toMatch(/RLS|CWE|CVE|jsonb|repo_url/i)
    }
  })

  it('reconoce tipos válidos e inválidos', () => {
    expect(isJobKind('run_checks')).toBe(true)
    expect(isJobKind('hacer_magia')).toBe(false)
    expect(isJobKind(42)).toBe(false)
  })
})

describe('stubs por defecto', () => {
  it('todos los tipos arrancan sin handler real', () => {
    expect(pendingKinds().sort()).toEqual([...JOB_KINDS].sort())
    expect(registeredKinds()).toEqual([])
  })

  it('el stub falla con un mensaje entendible y no se reintenta', async () => {
    const ctx = {} as any
    const error = await getHandler('run_checks')({}, ctx).catch((e) => e)

    expect(error).toBeInstanceOf(HandlerNotRegisteredError)
    expect(error.message).toContain('handler no registrado todavía')
    expect(error.message).toContain('run_checks')
    expect(isRetryable(error)).toBe(false)
  })
})

describe('registro de handlers', () => {
  it('registerHandler reemplaza el stub', async () => {
    const handler = vi.fn(async () => {})
    registerHandler('generate_video', handler)

    expect(hasRealHandler('generate_video')).toBe(true)
    expect(registeredKinds()).toEqual(['generate_video'])
    expect(pendingKinds()).not.toContain('generate_video')

    await getHandler('generate_video')({ videoId: 'v1' }, {} as any)
    expect(handler).toHaveBeenCalledWith({ videoId: 'v1' }, {})
  })

  it('resetHandlers vuelve todo a stubs', async () => {
    registerHandler('index_code', async () => {})
    expect(hasRealHandler('index_code')).toBe(true)

    resetHandlers()
    expect(hasRealHandler('index_code')).toBe(false)
  })

  it('un kind desconocido también falla claro', async () => {
    const error = await getHandler('no_existe' as any)({}, {} as any).catch((e) => e)
    expect(error).toBeInstanceOf(HandlerNotRegisteredError)
  })
})
