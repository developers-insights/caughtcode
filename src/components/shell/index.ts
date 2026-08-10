/**
 * Armazón de la aplicación.
 * Guía de uso: docs/DESIGN.md → "Armazón".
 */

export { AppShell, type AppShellProps } from './app-shell'
export { MobileNav, type MobileNavProps } from './mobile-nav'
export { PageHeader, type Crumb, type PageHeaderProps } from './page-header'
export { SidebarNav, type SidebarNavProps } from './sidebar-nav'
export { ThemeToggle, THEME_INIT_SCRIPT, THEME_STORAGE_KEY, type ThemePreference } from './theme-toggle'
export { TopBar, type TopBarProject, type TopBarProps, type TopBarUser } from './top-bar'
export {
  ACCOUNT_NAV,
  GLOBAL_NAV,
  isActive,
  mobileNav,
  projectNav,
  type NavGroup,
  type NavItem,
} from './nav-items'
