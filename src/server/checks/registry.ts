/**
 * Registro de chequeos.
 *
 * Cada chequeo declara qué insumo necesita (`requires`). El motor no lo corre
 * si falta alguno, y **deja constancia de que no lo corrió**: el usuario tiene
 * que poder ver qué no se revisó. Un chequeo salteado que se muestra como "todo
 * bien" es peor que no tener el chequeo.
 *
 * El `id` de cada uno es el del catálogo (`sec.…`, `cmp.…`, `sto.…`), y el test
 * `registry.test.ts` verifica que no haya ninguno inventado ni ninguno repetido.
 */

import type { Check } from './lib/context'

/* ── Pilar 1 · Seguridad ──────────────────────────────────────────────── */
import { rlsDisabled } from './security/rls_disabled'
import { rlsPermissive } from './security/rls_permissive'
import { rlsNotForced } from './security/rls_not_forced'
import { serviceRoleInClient } from './security/service_role_in_client'
import { secretInRepo } from './security/secret_in_repo'
import { envCommitted } from './security/env_committed'
import { publicEnvSecret } from './security/public_env_secret'
import { publicBucket } from './security/public_bucket'
import { apiRouteNoAuth } from './security/api_route_no_auth'
import { securityDefinerSearchPath } from './security/security_definer_search_path'
import { commentSecret } from './security/comment_secret'
import { sourcemapsPublic } from './security/sourcemaps_public'
import { dangerousHtml } from './security/dangerous_html'
import { sqlStringConcat } from './security/sql_string_concat'
import { corsWildcard } from './security/cors_wildcard'
import { piiInLogs } from './security/pii_in_logs'
import { noRateLimit } from './security/no_rate_limit'

/* ── Pilar 2 · Funciona completo ──────────────────────────────────────── */
import { noAccountDeletion } from './completeness/no_account_deletion'
import { noPasswordReset } from './completeness/no_password_reset'
import { noLogout } from './completeness/no_logout'
import { noEmailVerification } from './completeness/no_email_verification'
import { destructiveNoConfirm } from './completeness/destructive_no_confirm'
import { noLoadingState } from './completeness/no_loading_state'
import { noEmptyState } from './completeness/no_empty_state'
import { noErrorState } from './completeness/no_error_state'
import { formNoValidation } from './completeness/form_no_validation'
import { formNoLabels } from './completeness/form_no_labels'
import { placeholderLeft } from './completeness/placeholder_left'
import { brokenLinks } from './completeness/broken_links'
import { no404Page } from './completeness/no_404_page'
import { horizontalOverflow } from './completeness/horizontal_overflow'
import { a11yAxe } from './completeness/a11y_axe'
import { flowBlocked } from './completeness/flow_blocked'

/* ── Pilar 3 · Listo para publicar ────────────────────────────────────── */
import { noAccountDeletionTienda } from './store_hygiene/no_account_deletion'
import { trackersBeforeConsent } from './store_hygiene/trackers_before_consent'
import { noCookieBanner } from './store_hygiene/no_cookie_banner'
import { noPrivacyPage } from './store_hygiene/no_privacy_page'
import { noTermsPage } from './store_hygiene/no_terms_page'
import { thirdPartyDataSharing } from './store_hygiene/third_party_data_sharing'
import { noDeletionContact } from './store_hygiene/no_deletion_contact'

export const CHEQUEOS_SEGURIDAD: Check[] = [
  rlsDisabled,
  rlsPermissive,
  rlsNotForced,
  serviceRoleInClient,
  secretInRepo,
  envCommitted,
  publicEnvSecret,
  publicBucket,
  apiRouteNoAuth,
  securityDefinerSearchPath,
  commentSecret,
  sourcemapsPublic,
  dangerousHtml,
  sqlStringConcat,
  corsWildcard,
  piiInLogs,
  noRateLimit,
]

export const CHEQUEOS_COMPLETITUD: Check[] = [
  noAccountDeletion,
  noPasswordReset,
  noLogout,
  noEmailVerification,
  destructiveNoConfirm,
  noLoadingState,
  noEmptyState,
  noErrorState,
  formNoValidation,
  formNoLabels,
  placeholderLeft,
  brokenLinks,
  no404Page,
  horizontalOverflow,
  a11yAxe,
  flowBlocked,
]

export const CHEQUEOS_TIENDA: Check[] = [
  noAccountDeletionTienda,
  trackersBeforeConsent,
  noCookieBanner,
  noPrivacyPage,
  noTermsPage,
  thirdPartyDataSharing,
  noDeletionContact,
]

export const CHEQUEOS: Check[] = [
  ...CHEQUEOS_SEGURIDAD,
  ...CHEQUEOS_COMPLETITUD,
  ...CHEQUEOS_TIENDA,
]

export const CHEQUEOS_POR_ID = new Map(CHEQUEOS.map((c) => [c.id, c]))

export function chequeo(id: string): Check | undefined {
  return CHEQUEOS_POR_ID.get(id)
}

/* ── Insumos ──────────────────────────────────────────────────────────── */

/**
 * `deployed_app` y `browser_run` son dos cosas distintas, y confundirlas costaba
 * un informe mentiroso.
 *
 * - `deployed_app` es **la dirección**: con eso solo ya se puede pedir páginas
 *   por HTTP (enlaces rotos, 404, sourcemaps, CORS).
 * - `browser_run` es **haber recorrido la app de verdad** con el agente. Sin eso
 *   no hay cookies, ni pedidos de red, ni medidas de pantalla en el celular, ni
 *   sesiones de las que deducir que falta un flujo.
 *
 * Hasta que se separaron, un solo insumo cubría las dos, y el motor lo daba por
 * disponible con tener la dirección. O sea que cuando el agente no llegaba a
 * correr —hoy el caso normal: el tick de Vercel no lo pide y el worker con
 * navegador puede no existir— los once chequeos que leen `ctx.agent` corrían
 * igual, no encontraban nada, y la cobertura los mostraba como "revisado, sin
 * problemas". Un chequeo que no miró no puede decir que está todo bien.
 */
export type Insumo = 'code' | 'database' | 'deployed_app' | 'browser_run'

/**
 * Cómo se le explica al usuario que falta un insumo. Sin jerga: no dice
 * "no se proveyó una connection string", dice qué tiene que hacer.
 *
 * Ojo con `browser_run`: es el único que **no es una decisión del usuario**,
 * es algo que no pudimos hacer nosotros. El texto tiene que decir eso y no
 * pedirle nada a nadie — presentar una falla propia como un insumo que la
 * persona no dio es la clase de mentira que este archivo existe para evitar.
 */
export const INSUMO_FALTANTE: Record<Insumo, string> = {
  code: 'No pudimos leer el código de tu proyecto.',
  database: 'No conectaste tu base de datos, así que no revisamos quién puede ver qué.',
  deployed_app: 'No nos diste la dirección de tu app publicada, así que no la pudimos probar por dentro.',
  browser_run: 'No llegamos a recorrer tu app con el navegador, así que esto quedó sin revisar.',
}

/** Qué se gana conectando cada insumo. Va al lado del anterior. */
export const INSUMO_BENEFICIO: Record<Insumo, string> = {
  code: 'Con el código revisamos claves expuestas, flujos incompletos y textos sin terminar.',
  database: 'Conectándola probamos si un usuario puede ver los datos de otro. Es lectura: no tocamos nada.',
  deployed_app: 'Con la dirección recorremos tu app como un usuario y grabamos lo que pasa.',
  browser_run: 'Cuando la recorremos vemos lo que solo se nota usándola: cookies, rastreadores, pantallas que se rompen en el celular y flujos que no están.',
}

export interface InsumosDisponibles {
  code: boolean
  database: boolean
  deployed_app: boolean
  browser_run: boolean
}

export function faltantes(check: Check, disponibles: InsumosDisponibles): Insumo[] {
  return check.requires.filter((insumo) => !disponibles[insumo])
}

export function esAplicable(check: Check, disponibles: InsumosDisponibles): boolean {
  return faltantes(check, disponibles).length === 0
}
