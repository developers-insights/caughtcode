import { describe, expect, it } from 'vitest'

import {
  caracteresHablados,
  construirSsml,
  desarmarSsml,
  escaparXml,
  fraseoConPausas,
  PAUSA_MS,
  RITMO_LENTO_PCT,
} from '@/server/video/tts/ssml'

describe('prosodia', () => {
  it('mete una pausa después de cada punto', () => {
    const salida = fraseoConPausas('Entramos a tu app. Miramos los datos. Estaban abiertos.')
    const pausas = salida.match(/<break/g) ?? []
    expect(pausas).toHaveLength(2) // el punto final no lleva pausa: la pone la escena
    expect(salida).toContain(`<break time="${PAUSA_MS.oracion}ms"/>`)
  })

  it('usa pausas distintas para coma, dos puntos y punto', () => {
    const salida = fraseoConPausas('Miramos, probamos: entramos. Listo.')
    expect(salida).toContain(`<break time="${PAUSA_MS.clausula}ms"/>`)
    expect(salida).toContain(`<break time="${PAUSA_MS.anuncio}ms"/>`)
    expect(salida).toContain(`<break time="${PAUSA_MS.oracion}ms"/>`)
  })

  it('el ritmo es más lento que el default, como pide D10', () => {
    expect(RITMO_LENTO_PCT).toBeLessThanOrEqual(-10)
    expect(RITMO_LENTO_PCT).toBeGreaterThanOrEqual(-15)
  })

  it('escapa los caracteres que romperían el XML', () => {
    expect(escaparXml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
    )
  })

  it('no deja XML sin escapar dentro del SSML', () => {
    const ssml = construirSsml('Dice <script> y & después', { dialect: 'azure', voice: 'es-AR-TomasNeural' })
    expect(ssml).not.toContain('<script>')
    expect(ssml).toContain('&lt;script&gt;')
  })
})

describe('dialectos', () => {
  it('azure lleva la voz adentro del SSML y el idioma es-AR', () => {
    const ssml = construirSsml('Hola.', { dialect: 'azure', voice: 'es-AR-TomasNeural' })
    expect(ssml).toContain('xml:lang="es-AR"')
    expect(ssml).toContain('<voice name="es-AR-TomasNeural">')
    expect(ssml).toContain('rate="-12%"')
  })

  it('google NO lleva la voz adentro: la rechaza', () => {
    const ssml = construirSsml('Hola.', { dialect: 'google', voice: 'es-US-Chirp3-HD-Achernar' })
    expect(ssml).not.toContain('<voice')
    expect(ssml).toContain('rate="88%"')
  })
})

describe('medición del SSML', () => {
  it('cuenta solo el texto hablado, sin etiquetas', () => {
    const ssml = construirSsml('Hola mundo.', { dialect: 'azure', voice: 'v' })
    expect(caracteresHablados(ssml)).toBe('Hola mundo.'.length)
  })

  it('suma las pausas declaradas', () => {
    const ssml = construirSsml('Uno. Dos. Tres.', { dialect: 'azure', voice: 'v' })
    expect(desarmarSsml(ssml).pausasMs).toBe(PAUSA_MS.oracion * 2)
  })

  it('recupera el texto original al desarmar', () => {
    const texto = 'Probamos entrar con otra cuenta, y pudimos.'
    const ssml = construirSsml(texto, { dialect: 'azure', voice: 'v' })
    expect(desarmarSsml(ssml).texto).toBe(texto)
  })
})
