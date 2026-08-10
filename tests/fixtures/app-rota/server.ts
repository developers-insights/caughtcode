/**
 * "Facturia": una app rota a propósito, para probar el agente de navegación.
 *
 * Servidor HTTP mínimo con `node:http`, sin dependencias nuevas. Tiene, deliberadamente:
 *
 *  1. Un formulario de ingreso SIN enlace para recuperar la contraseña.
 *  2. Una pantalla de cuenta SIN opción de borrar la cuenta.
 *  3. `/factura/1` que se abre cambiando el número aunque la factura sea de otra persona.
 *  4. Un cartel de cookies que dispara rastreadores ANTES de que lo aceptes.
 *  5. Una tabla que se va para el costado en un teléfono de 375 px.
 *
 * Lo que SÍ está bien (para verificar que el agente no inventa hallazgos):
 *  - hay forma de cerrar sesión
 *  - existe la página de privacidad
 *
 * Lo usa: `tests/agent/e2e.test.ts`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

interface User {
  id: 'a' | 'b'
  email: string
  password: string
  name: string
}

const USERS: User[] = [
  { id: 'a', email: 'ana@example.com', password: 'Prueba-A-2026', name: 'Ana Prueba' },
  { id: 'b', email: 'bruno@example.com', password: 'Prueba-B-2026', name: 'Bruno Prueba' },
]

interface Invoice {
  id: number
  owner: 'a' | 'b'
  concept: string
  amount: string
  taxId: string
}

const INVOICES: Invoice[] = [
  { id: 1, owner: 'a', concept: 'Plan mensual', amount: '$ 12.400', taxId: '20-11111111-2' },
  { id: 2, owner: 'b', concept: 'Plan anual', amount: '$ 128.900', taxId: '27-22222222-9' },
  { id: 3, owner: 'b', concept: 'Servicio adicional', amount: '$ 4.100', taxId: '27-22222222-9' },
]

/* ── Plantilla ───────────────────────────────────────────────────────── */

/** Los rastreadores se cargan en el head, antes de cualquier consentimiento. */
const TRACKERS = `
  <script src="https://www.googletagmanager.com/gtag/js?id=G-ROTA"></script>
  <script>
    fetch('https://www.google-analytics.com/g/collect?v=2&tid=G-ROTA&en=page_view').catch(function () {});
  </script>
`

const STYLES = `
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; margin: 0; color: #17161a; background: #fbfaf8; }
  header { display: flex; gap: 1.5rem; align-items: center; padding: 1rem 1.5rem; border-bottom: 1px solid #e6e2dc; }
  main { padding: 1.5rem; }
  footer { padding: 1.5rem; border-top: 1px solid #e6e2dc; margin-top: 3rem; }
  a { color: #7a2e12; }
  label { display: block; margin: 0.75rem 0; }
  input { display: block; padding: 0.5rem; font-size: 1rem; min-width: 260px; }
  button { padding: 0.6rem 1rem; font-size: 1rem; cursor: pointer; }
  /* La tabla no se adapta: en un teléfono la pantalla se va para el costado. */
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d9d4cc; padding: 0.5rem 1.25rem; white-space: nowrap; }
  #cookies { position: fixed; inset: auto 0 0 0; background: #17161a; color: #fff; padding: 1rem 1.5rem;
             display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
`

const COOKIE_BANNER = `
  <div id="cookies">
    <span>Usamos cookies para mejorar tu experiencia y medir el uso del sitio.</span>
    <button onclick="document.getElementById('cookies').remove()">Aceptar todo</button>
  </div>
`

function layout(title: string, body: string, user: User | null): string {
  const nav = user
    ? `<a href="/cuenta">Mi cuenta</a> <a href="/ajustes">Ajustes</a> <a href="/perfil">Perfil</a> <a href="/salir">Cerrar sesión</a>`
    : `<a href="/ingresar">Ingresar</a> <a href="/registro">Crear cuenta</a>`

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Facturia</title>
  <style>${STYLES}</style>
  ${TRACKERS}
</head>
<body>
  <header><strong>Facturia</strong> <nav>${nav}</nav></header>
  <main>${body}</main>
  <footer><a href="/privacidad">Privacidad</a> · <span>Facturia 2026</span></footer>
  ${COOKIE_BANNER}
</body>
</html>`
}

/* ── Páginas ─────────────────────────────────────────────────────────── */

function homePage(user: User | null): string {
  const rows = INVOICES.map(
    (invoice) => `
      <tr>
        <td>${invoice.id}</td>
        <td>${invoice.concept}</td>
        <td>${invoice.amount}</td>
        <td>${invoice.taxId}</td>
        <td>Emitida el 09/08/2026</td>
        <td>Vence el 09/09/2026</td>
        <td>Método: transferencia bancaria</td>
        <td>Estado: pendiente de acreditación</td>
      </tr>`,
  ).join('')

  return layout(
    'Inicio',
    `<h1>Facturia</h1>
     <p>Emití y seguí tus facturas en un solo lugar.</p>
     <p><a href="/reportes">Ver reportes</a></p>
     <button onclick="alert('listo')">Vaciar historial de facturas</button>
     <h2>Últimos movimientos</h2>
     <table>
       <thead><tr><th>Número</th><th>Concepto</th><th>Importe</th><th>Identificación fiscal</th>
       <th>Emisión</th><th>Vencimiento</th><th>Forma de pago</th><th>Estado</th></tr></thead>
       <tbody>${rows}</tbody>
     </table>`,
    user,
  )
}

/** Sin enlace de "olvidé mi contraseña": ese es el hallazgo. */
function loginPage(error: string | null): string {
  return layout(
    'Ingresar',
    `<h1>Ingresar</h1>
     ${error ? `<p role="alert">${error}</p>` : ''}
     <form method="post" action="/ingresar">
       <label>Correo <input type="email" name="email" autocomplete="username" required></label>
       <label>Contraseña <input type="password" name="password" autocomplete="current-password" required></label>
       <button type="submit">Entrar</button>
     </form>
     <p><a href="/registro">¿No tenés cuenta? Creá una</a></p>`,
    null,
  )
}

function signupPage(): string {
  return layout(
    'Crear cuenta',
    `<h1>Crear cuenta</h1>
     <form method="post" action="/registro">
       <label>Nombre <input type="text" name="name" autocomplete="name" required></label>
       <label>Correo <input type="email" name="email" autocomplete="email" required></label>
       <label>Contraseña <input type="password" name="password" autocomplete="new-password" required></label>
       <button type="submit">Registrarme</button>
     </form>`,
    null,
  )
}

/** Sin opción de borrar la cuenta: ese es el otro hallazgo. */
function accountPage(user: User): string {
  const own = INVOICES.filter((invoice) => invoice.owner === user.id)
  const links = own
    .map((invoice) => `<li><a href="/factura/${invoice.id}">Factura ${invoice.id} — ${invoice.concept}</a></li>`)
    .join('')

  return layout(
    'Mi cuenta',
    `<h1>Mi cuenta</h1>
     <p>Hola, ${user.name}.</p>
     <h2>Tus facturas</h2>
     <ul>${links}</ul>
     <h2>Preferencias</h2>
     <p><a href="/ajustes">Ir a ajustes</a></p>`,
    user,
  )
}

function settingsPage(user: User): string {
  return layout(
    'Ajustes',
    `<h1>Ajustes</h1>
     <p>Notificaciones por correo: activadas.</p>
     <p>Idioma: español.</p>
     <p><a href="/perfil">Editar perfil</a></p>`,
    user,
  )
}

function profilePage(user: User): string {
  return layout(
    'Perfil',
    `<h1>Perfil</h1>
     <form method="post" action="/perfil">
       <label>Nombre visible <input type="text" name="name" value="${user.name}"></label>
       <button type="submit">Guardar cambios</button>
     </form>`,
    user,
  )
}

/** El agujero: muestra cualquier factura a cualquier persona con sesión iniciada. */
function invoicePage(invoice: Invoice, user: User): string {
  const owner = USERS.find((candidate) => candidate.id === invoice.owner)
  return layout(
    `Factura ${invoice.id}`,
    `<h1>Factura ${invoice.id}</h1>
     <p>Concepto: ${invoice.concept}</p>
     <p>Importe: ${invoice.amount}</p>
     <p>Identificación fiscal: ${invoice.taxId}</p>
     <p>Titular: ${owner?.name ?? 'desconocido'} (${owner?.email ?? ''})</p>`,
    user,
  )
}

function reportsPage(user: User | null): string {
  return layout(
    'Reportes',
    `<h1>Reportes</h1>
     <p>Resumen de facturación del mes.</p>
     <p>Total emitido: $ 145.400</p>`,
    user,
  )
}

function privacyPage(user: User | null): string {
  return layout(
    'Privacidad',
    `<h1>Política de privacidad</h1>
     <p>Guardamos tu correo y tus facturas para poder prestarte el servicio.</p>
     <p>Usamos cookies de medición para entender cómo se usa el sitio.</p>
     <p>Podés escribirnos a privacidad@facturia.example para pedir una copia de tus datos.</p>`,
    user,
  )
}

function notFoundPage(): string {
  return layout('Página no encontrada', `<h1>Uy, esta página no está</h1><p><a href="/">Volver al inicio</a></p>`, null)
}

/* ── Servidor ────────────────────────────────────────────────────────── */

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function currentUser(request: IncomingMessage): User | null {
  const id = readCookie(request, 'sesion')
  return USERS.find((user) => user.id === id) ?? null
}

async function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function send(response: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(html)
}

function redirect(response: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  response.writeHead(302, { location, ...headers })
  response.end()
}

export interface BrokenApp {
  url: string
  port: number
  close: () => Promise<void>
  server: Server
  users: User[]
}

export async function startBrokenApp(port = 0): Promise<BrokenApp> {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      send(response, 500, notFoundPage())
    })
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    server,
    users: USERS,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const user = currentUser(request)

  if (request.method === 'POST' && pathname === '/ingresar') {
    const body = await readBody(request)
    const match = USERS.find(
      (candidate) =>
        candidate.email === body.get('email') && candidate.password === body.get('password'),
    )
    if (!match) {
      send(response, 200, loginPage('Correo o contraseña incorrectos.'))
      return
    }
    redirect(response, '/cuenta', { 'set-cookie': `sesion=${match.id}; Path=/; HttpOnly; SameSite=Lax` })
    return
  }

  if (request.method === 'POST' && pathname === '/registro') {
    // Entra directo, sin confirmar el correo. Otro hallazgo real.
    redirect(response, '/cuenta', { 'set-cookie': 'sesion=a; Path=/; HttpOnly; SameSite=Lax' })
    return
  }

  if (request.method === 'POST' && pathname === '/perfil') {
    // Dice que guardó pero no guarda nada: el cambio se pierde.
    if (!user) {
      redirect(response, '/ingresar')
      return
    }
    redirect(response, '/perfil')
    return
  }

  switch (pathname) {
    case '/':
      send(response, 200, homePage(user))
      return
    case '/ingresar':
      send(response, 200, loginPage(null))
      return
    case '/registro':
      send(response, 200, signupPage())
      return
    case '/salir':
      redirect(response, '/', { 'set-cookie': 'sesion=; Path=/; Max-Age=0' })
      return
    case '/reportes':
      send(response, 200, reportsPage(user))
      return
    case '/privacidad':
      send(response, 200, privacyPage(user))
      return
    default:
      break
  }

  const needsSession = ['/cuenta', '/ajustes', '/perfil'].includes(pathname) || pathname.startsWith('/factura/')
  if (needsSession && !user) {
    redirect(response, '/ingresar')
    return
  }

  if (user) {
    if (pathname === '/cuenta') {
      send(response, 200, accountPage(user))
      return
    }
    if (pathname === '/ajustes') {
      send(response, 200, settingsPage(user))
      return
    }
    if (pathname === '/perfil') {
      send(response, 200, profilePage(user))
      return
    }
    const invoiceMatch = pathname.match(/^\/factura\/(\d+)$/)
    if (invoiceMatch) {
      const invoice = INVOICES.find((candidate) => candidate.id === Number(invoiceMatch[1]))
      if (!invoice) {
        send(response, 404, notFoundPage())
        return
      }
      // Acá está el agujero: nunca se compara `invoice.owner` con `user.id`.
      send(response, 200, invoicePage(invoice, user))
      return
    }
  }

  send(response, 404, notFoundPage())
}
