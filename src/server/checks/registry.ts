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

export type Insumo = 'code' | 'database' | 'deployed_app'

/**
 * Cómo se le explica al usuario que falta un insumo. Sin jerga: no dice
 * "no se proveyó una connection string", dice qué tiene que hacer.
 */
export const INSUMO_FALTANTE: Record<Insumo, string> = {
  code: 'No pudimos leer el código de tu proyecto.',
  database: 'No conectaste tu base de datos, así que no revisamos quién puede ver qué.',
  deployed_app: 'No nos diste la dirección de tu app publicada, así que no la pudimos probar por dentro.',
}

/** Qué se gana conectando cada insumo. Va al lado del anterior. */
export const INSUMO_BENEFICIO: Record<Insumo, string> = {
  code: 'Con el código revisamos claves expuestas, flujos incompletos y textos sin terminar.',
  database: 'Conectándola probamos si un usuario puede ver los datos de otro. Es lectura: no tocamos nada.',
  deployed_app: 'Con la dirección recorremos tu app como un usuario y grabamos lo que pasa.',
}

export interface InsumosDisponibles {
  code: boolean
  database: boolean
  deployed_app: boolean
}

export function faltantes(check: Check, disponibles: InsumosDisponibles): Insumo[] {
  return check.requires.filter((insumo) => !disponibles[insumo])
}

export function esAplicable(check: Check, disponibles: InsumosDisponibles): boolean {
  return faltantes(check, disponibles).length === 0
}
