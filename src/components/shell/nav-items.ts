import {
  ClipboardCheck,
  CreditCard,
  Eraser,
  Film,
  Folder,
  MessageSquare,
  User,
  type LucideIcon,
} from 'lucide-react'

/**
 * Rótulos de navegación.
 * Escritos para alguien que no programa: "Preguntar", no "Chat con el LLM";
 * "Plan y pagos", no "Facturación"; "Cómo funciona", no "Documentación".
 */

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Solo activo si la ruta coincide exacto (no por prefijo). */
  exact?: boolean
  /** Contador. Ej. cuántos hallazgos sin resolver quedan. */
  badge?: number
  /** Tono del contador. Rojo solo si hay algo expuesto. */
  badgeTone?: 'expuesto' | 'neutral'
}

export interface NavGroup {
  /** Encabezado del grupo. Se omite en el primero. */
  label?: string
  items: NavItem[]
}

/** Navegación que existe siempre, haya o no un proyecto abierto. */
export const GLOBAL_NAV: NavGroup = {
  items: [{ href: '/proyectos', label: 'Proyectos', icon: Folder }],
}

export const ACCOUNT_NAV: NavGroup = {
  label: 'Tu espacio',
  items: [
    { href: '/facturacion', label: 'Plan y pagos', icon: CreditCard },
    { href: '/cuenta', label: 'Tu cuenta', icon: User },
  ],
}

/** Secciones de un proyecto abierto. */
export function projectNav(projectId: string, openFindings?: number): NavGroup {
  return {
    label: 'Este proyecto',
    items: [
      {
        href: `/proyectos/${projectId}/hallazgos`,
        label: 'Hallazgos',
        icon: ClipboardCheck,
        badge: openFindings,
        badgeTone: openFindings ? 'expuesto' : 'neutral',
      },
      { href: `/proyectos/${projectId}/como-funciona`, label: 'Cómo funciona', icon: Film },
      { href: `/proyectos/${projectId}/chat`, label: 'Preguntar', icon: MessageSquare },
      { href: `/proyectos/${projectId}/comentarios`, label: 'Comentarios', icon: Eraser },
    ],
  }
}

/**
 * Barra inferior de celular: máximo 5, siempre con texto.
 * Sin proyecto abierto muestra lo global; con proyecto, sus secciones.
 */
export function mobileNav(projectId?: string, openFindings?: number): NavItem[] {
  if (!projectId) {
    return [...GLOBAL_NAV.items, ...ACCOUNT_NAV.items]
  }
  return [
    { href: '/proyectos', label: 'Proyectos', icon: Folder },
    ...projectNav(projectId, openFindings).items,
    { href: '/cuenta', label: 'Cuenta', icon: User },
  ].slice(0, 5)
}

/** ¿Este ítem corresponde a la ruta actual? */
export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
