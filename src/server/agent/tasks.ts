/**
 * El set curado de tareas que el agente intenta en la app del usuario.
 *
 * No es una lista de chequeos: es una lista de cosas que una persona haría y que,
 * cuando fallan, se pueden mostrar en video. Cada tarea tiene un objetivo en lenguaje
 * natural (lo lee el modelo que conduce el navegador), si toca datos de verdad, y un
 * tope de pasos para que ninguna se vaya de presupuesto.
 *
 * Sobre `destructive`: marca las tareas que escriben en la app del usuario. Requieren
 * confirmación explícita en la interfaz antes de correr (DECISIONS.md D9). Registrarse
 * cuenta: crea una cuenta real en su base de datos.
 *
 * Lo usan: `index.ts` y `src/server/agent/tasks/**`.
 */

import 'server-only'

import type { AgentTask, AgentTaskId, StackInfo } from '@/lib/types/domain'

export const ALL_TASKS: Record<AgentTaskId, AgentTask> = {
  signup: {
    id: 'signup',
    goal:
      'Crear una cuenta nueva desde cero, como haría alguien que entra por primera vez. ' +
      'Prestar atención a si pide confirmar el correo antes de dejar entrar, si acepta ' +
      'una contraseña débil, y si se puede llegar a la parte privada sin confirmar nada.',
    destructive: true,
    maxSteps: 12,
  },
  login: {
    id: 'login',
    goal:
      'Entrar a la app con la cuenta de prueba. Si no hay pantalla para iniciar sesión, ' +
      'decirlo. Si hay, llegar hasta la parte privada.',
    destructive: false,
    maxSteps: 10,
  },
  password_reset: {
    id: 'password_reset',
    goal:
      'Recuperar el acceso como alguien que se olvidó la contraseña: buscar el enlace ' +
      'desde la pantalla de ingreso y desde las direcciones habituales de recuperación. ' +
      'Lo que importa es si el camino existe, no completarlo.',
    destructive: false,
    maxSteps: 10,
  },
  logout: {
    id: 'logout',
    goal:
      'Cerrar la sesión desde adentro de la app: buscar el botón en el menú de usuario, ' +
      'en el encabezado y en los ajustes.',
    destructive: false,
    maxSteps: 8,
  },
  // No está marcada como destructiva a propósito: la prueba BUSCA la opción, nunca la
  // ejecuta. Si pidiera autorización, el hallazgo estrella (D5) no correría por defecto
  // y sería justo el que más le importa al usuario. El click real sigue bloqueado por
  // la barrera de acciones destructivas de `guards.ts`.
  delete_account: {
    id: 'delete_account',
    goal:
      'Encontrar cómo borrar la cuenta, como pide la tienda de aplicaciones: revisar ' +
      'ajustes, perfil, privacidad y cuenta. Solo hay que llegar hasta la opción, no ejecutarla.',
    destructive: false,
    maxSteps: 14,
  },
  edit_profile: {
    id: 'edit_profile',
    goal:
      'Cambiar un dato del perfil (el nombre visible alcanza) y confirmar que el cambio ' +
      'queda guardado al volver a entrar a la pantalla.',
    destructive: true,
    maxSteps: 12,
  },
  cross_tenant_read: {
    id: 'cross_tenant_read',
    goal:
      'Con la sesión de la primera cuenta de prueba, intentar abrir por dirección directa ' +
      'un recurso que le pertenece a la segunda cuenta, cambiando el número o el identificador ' +
      'de la dirección. Ver si la app lo muestra igual.',
    destructive: false,
    maxSteps: 12,
  },
  primary_flow: {
    id: 'primary_flow',
    goal:
      'Hacer lo principal que ofrece la app desde la portada, como lo haría un visitante ' +
      'nuevo, hasta llegar al resultado o toparse con una pared. Frenar antes de pagar.',
    destructive: false,
    maxSteps: 14,
  },
  cookie_banner: {
    id: 'cookie_banner',
    goal:
      'Abrir la portada sin tocar nada y observar si la app ya cargó rastreadores antes ' +
      'de que el visitante acepte el cartel de cookies.',
    destructive: false,
    maxSteps: 6,
  },
  privacy_terms: {
    id: 'privacy_terms',
    goal:
      'Buscar las páginas de política de privacidad y de términos, tanto por enlaces del ' +
      'pie de página como por las direcciones habituales.',
    destructive: false,
    maxSteps: 8,
  },
}

/** Orden de ejecución: primero lo barato y sin sesión, después lo que la necesita. */
export const TASK_ORDER: AgentTaskId[] = [
  'cookie_banner',
  'privacy_terms',
  'primary_flow',
  'signup',
  'login',
  'password_reset',
  'logout',
  'edit_profile',
  'delete_account',
  'cross_tenant_read',
]

/** Tareas que no tienen sentido sin poder iniciar sesión. */
export const TASKS_NEEDING_SESSION: AgentTaskId[] = [
  'logout',
  'edit_profile',
  'delete_account',
  'cross_tenant_read',
]

/** Tareas que solo aplican si la app tiene cuentas de usuario. */
const TASKS_NEEDING_ACCOUNTS: AgentTaskId[] = [
  'signup',
  'login',
  'password_reset',
  'logout',
  'delete_account',
  'edit_profile',
  'cross_tenant_read',
]

/**
 * Adapta el set al stack detectado.
 * Un sitio estático sin base de datos no tiene cuentas: preguntar por el borrado de
 * cuenta ahí sería ruido, y el ruido es lo que hace que el usuario deje de leer (D15).
 */
export function selectTasks(stack?: StackInfo | null, only?: AgentTaskId[]): AgentTask[] {
  const hasAccounts = stackHasAccounts(stack)
  const wanted = new Set<AgentTaskId>(only ?? TASK_ORDER)

  return TASK_ORDER.filter((id) => wanted.has(id))
    .filter((id) => hasAccounts || !TASKS_NEEDING_ACCOUNTS.includes(id))
    .map((id) => adaptTask(ALL_TASKS[id], stack))
}

/** ¿La app parece tener cuentas de usuario? */
export function stackHasAccounts(stack?: StackInfo | null): boolean {
  if (!stack) return true // Sin información, se prueba todo: es más barato que perderse un hallazgo.
  const backends = stack.backends ?? []
  const realBackends = backends.filter((backend) => backend !== 'none')
  return realBackends.length > 0
}

/** Ajustes finos del objetivo según el stack, para que el modelo busque en el lugar correcto. */
function adaptTask(task: AgentTask, stack?: StackInfo | null): AgentTask {
  if (!stack) return task
  const hints: string[] = []

  if (stack.backends?.includes('supabase')) {
    hints.push(
      'La app guarda los datos en Supabase: los recursos suelen tener identificadores largos ' +
        'con guiones en la dirección.',
    )
  }
  if (stack.framework === 'nextjs' && stack.routerKind === 'app') {
    hints.push('Es una app de Next.js: las direcciones son limpias y sin extensión.')
  }
  if (stack.framework === 'flutter') {
    hints.push(
      'Es una app de Flutter en el navegador: los botones pueden tardar en responder y la ' +
        'dirección quizás no cambie al navegar.',
    )
  }

  if (hints.length === 0) return task
  return { ...task, goal: `${task.goal}\n\nContexto: ${hints.join(' ')}` }
}

export function getTask(id: AgentTaskId): AgentTask {
  return ALL_TASKS[id]
}
