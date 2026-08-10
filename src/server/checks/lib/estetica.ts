/**
 * Guardia contra la crítica estética generada por IA (D6).
 *
 * No es una preferencia de estilo. La evidencia:
 *   - correlación con la calidad real de un juicio estético: humanos 0.556,
 *     modelos 0.194
 *   - similitud semántica entre una crítica humana y una del modelo: 0.046,
 *     o sea que ni siquiera están mirando lo mismo
 *
 * El riesgo concreto es de contaminación: si el usuario lee un hallazgo que le
 * suena a opinión genérica, empieza a dudar también de los de seguridad, que sí
 * son sólidos. Un hallazgo blando se lleva puesta la credibilidad de los duros.
 *
 * Este módulo existe para que eso no dependa de que nadie se acuerde: hay un
 * test que corre esto sobre todo el catálogo y sobre todo hallazgo emitido.
 *
 * Ojo con la precisión: "contraste" **sí** se puede decir (es medible con una
 * revisión automática de accesibilidad) y "mismo diseño que el resto de la app"
 * también (es consistencia verificable, no gusto). Por eso las reglas son
 * frases, no palabras sueltas.
 */

export interface FraseProhibida {
  patron: RegExp
  porque: string
}

export const FRASES_ESTETICAS: FraseProhibida[] = [
  { patron: /jerarqu[ií]a\s+visual/i, porque: 'Juicio estético: no es medible.' },
  { patron: /espacio\s+en\s+blanco|whitespace/i, porque: 'Juicio estético: no es medible.' },
  { patron: /respirar|aire\s+visual/i, porque: 'Juicio estético disfrazado de consejo.' },
  { patron: /los\s+colores\s+no\s+(combinan|funcionan|pegan)/i, porque: 'Opinión sobre gusto.' },
  { patron: /paleta\s+(de\s+colores\s+)?(poco|más|mas|muy)\b/i, porque: 'Opinión sobre gusto.' },
  { patron: /(se\s+ve|luce|queda)\s+(feo|fea|anticuad|desactualizad|genérico|generico|pobre|barato)/i, porque: 'Opinión sobre gusto.' },
  { patron: /poco\s+atractiv|más\s+atractiv|mas\s+atractiv/i, porque: 'Opinión sobre gusto.' },
  { patron: /(mejor[aá]|cuid[aá]|revis[aá])\s+la\s+(est[eé]tica|tipograf[ií]a|composici[oó]n)/i, porque: 'Opinión sobre gusto.' },
  { patron: /(diseño|dise[nñ]o)\s+(anticuado|desactualizado|amateur|poco\s+profesional)/i, porque: 'Opinión sobre gusto.' },
  { patron: /armon[ií]a\s+(visual|crom[aá]tica)/i, porque: 'Juicio estético: no es medible.' },
  { patron: /(se\s+ver[ií]a|quedar[ií]a)\s+mejor\s+(si|con)/i, porque: 'Sugerencia de gusto, no hallazgo.' },
  { patron: /m[aá]s\s+moderno|aspecto\s+moderno|look\s+moderno/i, porque: 'Opinión sobre gusto.' },
  { patron: /elecci[oó]n\s+de\s+(fuente|tipograf[ií]a)/i, porque: 'Opinión sobre gusto.' },
  { patron: /interlineado|kerning|tracking\s+tipogr/i, porque: 'Detalle tipográfico: no es un hallazgo.' },
  { patron: /(demasiado|muy)\s+(recargad|cargad|vac[ií]o\s+visual)/i, porque: 'Opinión sobre gusto.' },
  { patron: /experiencia\s+visual|impacto\s+visual/i, porque: 'Vaguedad sin evidencia.' },
]

export interface CriticaEstetica {
  frase: string
  porque: string
}

/**
 * Devuelve las frases estéticas encontradas en un texto destinado al usuario.
 * Vacío = el texto pasa.
 */
export function detectarCriticaEstetica(texto: string): CriticaEstetica[] {
  const encontradas: CriticaEstetica[] = []
  for (const { patron, porque } of FRASES_ESTETICAS) {
    const match = patron.exec(texto)
    if (match) encontradas.push({ frase: match[0], porque })
  }
  return encontradas
}
