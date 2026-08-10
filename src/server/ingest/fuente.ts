/**
 * De dónde sale el código de un proyecto, y en qué orden se intenta.
 *
 * Existe aparte del handler por una razón concreta: **elegir mal el camino es un
 * bug silencioso y caro**. Un proyecto conectado con la GitHub App que se intenta
 * bajar por el camino anónimo recibe de GitHub un 404 —GitHub no distingue entre
 * "no existe" y "no te lo muestro"— y el usuario termina leyendo "ese repositorio
 * es privado" sobre un repositorio al que sí tenemos acceso. Pasó en producción.
 *
 * Acá no hay red, ni base, ni Storage: entra el estado del proyecto y sale la
 * lista ordenada de intentos. Es lo que hace que la regla se pueda probar sola.
 *
 * ## El orden y por qué es ese
 *
 *  1. **La copia de esta misma corrida**, si existe. Un reintento no vuelve a
 *     salir a la red ni puede terminar analizando un código distinto del que ya
 *     había empezado a mirar.
 *  2. **El repositorio, por el camino que corresponde al tipo de proyecto.** Una
 *     auditoría nueva tiene que mirar el código de hoy: si mirara la copia de la
 *     corrida anterior, podríamos mostrarle al usuario un problema que ya
 *     arregló. Para un producto cuyo valor es la evidencia, eso es peor que
 *     tardar unos segundos más.
 *  3. **La última copia guardada**, como respaldo. Si GitHub no contesta y el
 *     código ya está guardado, la auditoría no tiene por qué morirse; queda
 *     dicho en el registro que se usó una copia.
 *
 * Para un proyecto que llegó como archivo, la copia guardada es la única fuente:
 * no hay repositorio al que ir.
 */

/** Un intento de conseguir el código, ya resuelto a un camino concreto. */
export type OrigenCodigo =
  /** Bajarlo de nuestro Storage. `ruta` es la clave dentro del bucket de repos. */
  | { tipo: 'guardado'; ruta: string }
  /** Bajarlo de GitHub **con la instalación de la App**: repos privados incluidos. */
  | { tipo: 'github_app'; url: string }
  /** Bajarlo de GitHub **sin ninguna credencial**: solo sirve para repos públicos. */
  | { tipo: 'github_publico'; url: string }

export interface EntradaDelPlan {
  /** `github` (App), `github_public` (anónimo) o `zip`. Cualquier otra cosa se trata como archivo. */
  sourceType: string
  repoUrl: string | null
  storagePath: string | null
  /** Dónde guardamos el comprimido de ESTA corrida. */
  rutaCorrida: string
}

/**
 * Arma la lista ordenada de intentos para conseguir el código.
 *
 * **Invariante que no se puede romper:** un proyecto con `source_type = 'github'`
 * nunca sale por `github_publico`. Si la App no puede entrar, la respuesta honesta
 * es decirlo, no probar sin credencial y traducir el 404 a "es privado".
 */
export function planDeFuentes(entrada: EntradaDelPlan): OrigenCodigo[] {
  const plan: OrigenCodigo[] = []
  const url = entrada.repoUrl?.trim() || null
  const guardado = entrada.storagePath?.trim() || null

  if (guardado && guardado === entrada.rutaCorrida) {
    plan.push({ tipo: 'guardado', ruta: entrada.rutaCorrida })
  }

  if (url) {
    if (entrada.sourceType === 'github') plan.push({ tipo: 'github_app', url })
    else if (entrada.sourceType === 'github_public') plan.push({ tipo: 'github_publico', url })
  }

  if (guardado && guardado !== entrada.rutaCorrida) {
    plan.push({ tipo: 'guardado', ruta: guardado })
  }

  // Último recurso, y solo para proyectos que no son de GitHub: alguien pasó una
  // dirección en el pedido y no tenemos ninguna copia. Probar sin credencial no
  // puede filtrar nada y es la única chance de que la auditoría salga.
  const yaVaAGithub = plan.some((origen) => origen.tipo !== 'guardado')
  if (url && !yaVaAGithub && entrada.sourceType !== 'github') {
    plan.push({ tipo: 'github_publico', url })
  }

  return plan
}

/** `true` si el plan sale a GitHub sin credencial en algún momento. */
export function usaCaminoAnonimo(plan: OrigenCodigo[]): boolean {
  return plan.some((origen) => origen.tipo === 'github_publico')
}
