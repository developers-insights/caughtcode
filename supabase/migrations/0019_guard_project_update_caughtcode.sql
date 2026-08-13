-- ============================================================================
-- caughtcode · 0019 · Guarda de columnas sensibles en projects_caughtcode
-- ----------------------------------------------------------------------------
-- QUÉ PROTEGE
-- -----------
-- RLS filtra FILAS, no COLUMNAS: `projects_update_caughtcode` (migración 0005)
-- deja que cualquier MIEMBRO de la organización haga `PATCH /rest/v1/
-- projects_caughtcode?id=eq.<uuid>` con el cuerpo que quiera. Dos columnas de
-- esa fila no son datos del usuario, son entrada del worker:
--
--   * `org_id`      → de quién es el proyecto. Cambiarlo lo muda de organización.
--   * `storage_path`→ de dónde baja el worker el código a auditar.
--
-- `organizations_caughtcode` ya tiene su `guard_organization_update_caughtcode`
-- justo por esto (dueño y plan). A `projects_caughtcode` le faltaba el análogo,
-- y el comentario de `esRutaDelProyecto()` en `src/server/ingest/rehidratar.ts`
-- lo dice con todas las letras.
--
-- DEFENSA EN PROFUNDIDAD, NO EL ÚNICO CONTROL
-- -------------------------------------------
-- El frente de aislamiento ya hizo que apuntar `storage_path` al .zip de otra
-- empresa sea INÚTIL: antes de descargar se valida el prefijo
-- `<org_id>/<project_id>/` y, si no encaja, se trata como si no hubiera copia.
-- Ese control sigue siendo el que cierra la puerta —el worker baja con
-- `service_role`, que ignora las policies del bucket—. Esto es la segunda
-- cerradura: que la columna no se pueda ni escribir mal.
--
-- POR QUÉ `storage_path` SE VALIDA Y NO SE BLOQUEA
-- ------------------------------------------------
-- Verificado antes de escribir esto: el worker NO es el único que la escribe.
-- El onboarding la escribe con la SESIÓN DE LA PERSONA (`supabase` de
-- `requireSession()`, no el cliente admin) en los tres caminos de
-- `src/app/(app)/proyectos/nuevo/actions.ts` — subida de .zip, repo de GitHub y
-- repo público—, siempre con la forma `<org_id>/<project_id>/<archivo>`. Un
-- trigger que prohibiera la columna a `authenticated` rompería la creación de
-- proyectos entera.
--
-- Entonces la regla no es "no la toques", es "no la saques de tu propia
-- carpeta", que es exactamente el invariante que valida `esRutaDelProyecto()`:
-- primer segmento el `org_id`, segundo el `project_id`, y ningún segmento
-- vacío, `.` ni `..` (se normalizan del otro lado y podrían escaparse del
-- prefijo aunque la ruta empiece bien). Poner la columna en `null` sí se
-- permite: no apunta a nada de nadie y la próxima ingesta la reescribe.
--
-- `org_id`, en cambio, se bloquea sin más: no hay un solo camino del producto
-- que mueva un proyecto de organización. Si algún día lo hay, va a ser por una
-- función `security definer` que revise permisos, no por un PATCH.
--
-- El `service_role` pasa de largo, como en la guarda de organizaciones: el
-- worker escribe la ruta canónica en cada ingesta y no puede depender de que su
-- propio formato le guste al trigger. Y si algún día entrara por una conexión
-- sin JWT (rol `postgres`, donde `auth.jwt()` da null), tampoco se rompería:
-- `rutaDelArchivo()` devuelve `<org_id>/<project_id>/corridas/<run>/codigo.zip`,
-- que pasa la validación por derecha.
-- ============================================================================

create or replace function public.guard_project_update_caughtcode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefijo text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') = 'service_role' then
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'Un proyecto no se puede mover de organización.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.storage_path is distinct from old.storage_path
     and new.storage_path is not null then
    v_prefijo := new.org_id::text || '/' || new.id::text || '/';

    -- Tiene que empezar por su propia carpeta y tener algo adentro.
    if left(new.storage_path, length(v_prefijo)) is distinct from v_prefijo
       or length(new.storage_path) <= length(v_prefijo) then
      raise exception 'La copia del código de un proyecto vive en su propia carpeta.'
        using errcode = 'insufficient_privilege';
    end if;

    -- Y ningún segmento puede ser vacío, `.` ni `..`: eso se normaliza del otro
    -- lado y se escapa del prefijo aunque la ruta empiece bien.
    if new.storage_path ~ '(^|/)(\.{1,2})?(/|$)' then
      raise exception 'La copia del código de un proyecto vive en su propia carpeta.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.guard_project_update_caughtcode() is
  'Impide mudar un proyecto de organización y apuntar su copia de código fuera de <org_id>/<project_id>/. Solo el service_role (el worker) queda exento. Ver migración 0019.';

-- Nace con EXECUTE para anon y authenticated por el default privilege de
-- Supabase. No es un endpoint: la dispara Postgres. Se revoca igual, por el
-- mismo criterio de 0014, y `supabase/tests/grants_rpc.sql` lo verifica.
revoke all on function public.guard_project_update_caughtcode() from public, anon, authenticated;

drop trigger if exists projects_guard_update_caughtcode on public.projects_caughtcode;

create trigger projects_guard_update_caughtcode
before update on public.projects_caughtcode
for each row execute function public.guard_project_update_caughtcode();
