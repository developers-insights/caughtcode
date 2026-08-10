/**
 * La vuelta de GitHub después de instalar la App.
 *
 * Cuando alguien termina de instalar, GitHub lo manda a la "Setup URL" de la App
 * con `?installation_id=…&setup_action=install`. Hasta ahora nadie escuchaba esa
 * vuelta: la instalación quedaba viva en GitHub y sin dueño de nuestro lado, y por
 * eso el asistente terminaba mostrándole a cada persona las instalaciones de
 * todas las demás. Acá es donde la instalación pasa a tener dueño.
 *
 * ## Lo que NO se hace acá
 *
 * **No se le cree al `installation_id`.** Llega por la barra de direcciones del
 * navegador: es un número que escribe cualquiera, y probar de a uno hasta pegarle
 * a una instalación ajena es trivial. Antes de guardar nada se le pregunta a la
 * API de GitHub si esa instalación existe y de qué cuenta es, y se rechaza si ya
 * está atada a otra organización (`bindInstallationToOrg`). La clave primaria de
 * la tabla lo vuelve a impedir por si esta ruta se escribiera mal mañana.
 *
 * **No se le cree al `state`.** El testigo firmado sirve para reconocer de qué
 * organización salió el viaje, no para autorizar: la instalación se ata a la
 * organización de la sesión de quien vuelve. Si el testigo dice otra cosa, no
 * seguimos — es la señal de que alguien completó un enlace de instalación que
 * empezó otra persona.
 *
 * ## Adónde termina el usuario
 *
 * Siempre en el asistente de proyecto nuevo, nunca en una pantalla muerta ni en
 * un JSON. El resultado viaja como parámetro para que la pantalla pueda decir qué
 * pasó (ver la nota de copy en el retorno de este frente).
 */

import { NextResponse, type NextRequest } from 'next/server'

import {
  GithubNotConfiguredError,
  bindInstallationToOrg,
  decodeInstallState,
} from '@/server/ingest/github'

import { requireSession } from '../../../(app)/current-org'

/** Nunca cachear: el resultado depende de quién tiene la sesión. */
export const dynamic = 'force-dynamic'

const DESTINO = '/proyectos/nuevo'

function volver(request: NextRequest, resultado: string): NextResponse {
  const url = new URL(DESTINO, request.nextUrl.origin)
  url.searchParams.set('github', resultado)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Si no hay sesión, `requireSession()` manda a /entrar. No hay atajo: sin saber
  // quién vuelve no hay a qué organización atar la instalación.
  const { user, org } = await requireSession()

  const params = request.nextUrl.searchParams
  const setupAction = params.get('setup_action')

  // La persona pidió la instalación pero todavía la tiene que aprobar quien
  // administra la organización en GitHub. No hay instalación que atar todavía.
  if (setupAction === 'request') return volver(request, 'pendiente')

  const crudo = params.get('installation_id')
  const installationId = Number(crudo)
  if (!crudo || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return volver(request, 'sin_instalacion')
  }

  // El testigo es opcional (alguien puede instalar la App desde el listado de
  // GitHub, sin pasar por nuestro enlace). Cuando viene y no coincide con la
  // sesión, el viaje lo empezó otra cuenta: se corta.
  const state = params.get('state')
  if (state) {
    const orgDelTestigo = decodeInstallState(state)
    if (orgDelTestigo !== null && orgDelTestigo !== org.id) {
      return volver(request, 'otra_sesion')
    }
  }

  try {
    const resultado = await bindInstallationToOrg({
      installationId,
      orgId: org.id,
      userId: user.id,
    })

    if (!resultado.ok) {
      return volver(request, resultado.motivo === 'no_existe' ? 'sin_instalacion' : 'ya_conectada')
    }

    return volver(request, 'conectado')
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) return volver(request, 'sin_github')
    return volver(request, 'error')
  }
}
