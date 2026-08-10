-- ============================================================================
-- caughtcode · 0004 · Funciones de tenencia
-- ----------------------------------------------------------------------------
-- Estas funciones son la ÚNICA autoridad sobre "¿esta persona puede ver esto?".
-- Todas son `security definer` + `stable` + `set search_path = ''`.
--
-- Por qué `security definer`: las creamos como `postgres`, que tiene bypassrls.
-- La función lee org_members_caughtcode sin pasar por las policies de org_members_caughtcode, y así
-- la policy de org_members_caughtcode puede llamarla sin recursión infinita.
--
-- Por qué `set search_path = ''`: sin eso, alguien que controle el search_path
-- de la sesión puede plantar una tabla `org_members_caughtcode` propia y hacer que la
-- función devuelva true para cualquier organización. Todo va calificado.
-- ============================================================================

-- ── ¿Pertenezco a esta organización? ───────────────────────────────────────
create or replace function public.is_org_member_caughtcode(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members_caughtcode m
    where m.org_id = org
      and m.user_id = (select auth.uid())
  );
$$;

comment on function public.is_org_member_caughtcode(uuid) is
  'true si quien hace el pedido es miembro de la organización. Base de todas las policies.';


-- ── ¿Puedo administrar esta organización? ──────────────────────────────────
create or replace function public.is_org_admin_caughtcode(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members_caughtcode m
    where m.org_id = org
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

comment on function public.is_org_admin_caughtcode(uuid) is
  'true si quien hace el pedido es owner o admin. Requerido para operaciones destructivas.';


-- ── Resolución de organización desde tablas hijas ──────────────────────────
-- Devuelven null si el objeto no existe; is_org_member_caughtcode(null) es false, así que
-- el resultado seguro es "no ves nada".

create or replace function public.org_of_project_caughtcode(p_project_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id from public.projects_caughtcode p where p.id = p_project_id;
$$;

create or replace function public.org_of_run_caughtcode(p_analysis_run_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id
  from public.analysis_runs_caughtcode r
  join public.projects_caughtcode p on p.id = r.project_id
  where r.id = p_analysis_run_id;
$$;

create or replace function public.org_of_finding_caughtcode(p_finding_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id
  from public.findings_caughtcode f
  join public.projects_caughtcode p on p.id = f.project_id
  where f.id = p_finding_id;
$$;

create or replace function public.org_of_thread_caughtcode(p_thread_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id
  from public.chat_threads_caughtcode t
  join public.projects_caughtcode p on p.id = t.project_id
  where t.id = p_thread_id;
$$;

comment on function public.org_of_project_caughtcode(uuid) is 'Organización dueña de un proyecto.';
comment on function public.org_of_run_caughtcode(uuid)     is 'Organización dueña de una corrida de análisis.';
comment on function public.org_of_finding_caughtcode(uuid) is 'Organización dueña de un hallazgo.';
comment on function public.org_of_thread_caughtcode(uuid)  is 'Organización dueña de un hilo de chat.';


-- ── Permisos ───────────────────────────────────────────────────────────────
-- Las expresiones de una policy se evalúan con el rol que consulta, así que
-- `authenticated` necesita EXECUTE. `anon` no ejecuta nada: no tiene por qué
-- poder sondear qué organizaciones existen.
revoke all on function public.is_org_member_caughtcode(uuid)   from public;
revoke all on function public.is_org_admin_caughtcode(uuid)    from public;
revoke all on function public.org_of_project_caughtcode(uuid)  from public;
revoke all on function public.org_of_run_caughtcode(uuid)      from public;
revoke all on function public.org_of_finding_caughtcode(uuid)  from public;
revoke all on function public.org_of_thread_caughtcode(uuid)   from public;

grant execute on function public.is_org_member_caughtcode(uuid)   to authenticated, service_role;
grant execute on function public.is_org_admin_caughtcode(uuid)    to authenticated, service_role;
grant execute on function public.org_of_project_caughtcode(uuid)  to authenticated, service_role;
grant execute on function public.org_of_run_caughtcode(uuid)      to authenticated, service_role;
grant execute on function public.org_of_finding_caughtcode(uuid)  to authenticated, service_role;
grant execute on function public.org_of_thread_caughtcode(uuid)   to authenticated, service_role;
