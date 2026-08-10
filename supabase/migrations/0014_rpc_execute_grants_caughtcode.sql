-- ============================================================================
-- caughtcode · 0014 · Quién puede llamar a nuestras funciones desde la API
-- ----------------------------------------------------------------------------
-- La clave `anon` es pública por diseño: viaja en el bundle del navegador.
-- Cualquiera la copia del DevTools y hace `POST /rest/v1/rpc/<nombre>`. Todo lo
-- que tenga EXECUTE para `anon` es, literalmente, un endpoint abierto a
-- internet. Once funciones nuestras lo tenían.
--
-- POR QUÉ PASÓ, aunque las migraciones ya revocaban
-- ------------------------------------------------
-- 0004, 0007 y 0008 hacen `revoke all ... from public`. No alcanza, y no es un
-- descuido de tipeo: son dos cosas distintas. `public` es el pseudo-rol "todos";
-- `anon` y `authenticated` son roles reales, y Supabase trae de fábrica
--
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
--
-- así que cada función nueva del schema `public` NACE con EXECUTE para los tres.
-- Revocarle a `public` no le saca nada a un rol que tiene el privilegio a
-- nombre propio. Hay que nombrarlos. Es el mismo agujero que 0013 cerró en las
-- dos funciones de la cola; esto lo termina para el resto.
--
-- LO QUE SE MIDIÓ ANTES DE TOCAR NADA (POST real con la clave pública)
-- -------------------------------------------------------------------
--   anon → org_of_project_caughtcode(<proyecto real>)
--          200  "99bc0b30-…"        ← devolvió la organización dueña. Sin sesión.
--   anon → delete_project_cascade_caughtcode(<uuid inexistente>)
--          "No encontramos ese proyecto."
--   anon → delete_project_cascade_caughtcode(<proyecto real>)
--          "No tenés permiso para borrar este proyecto."
--
-- Dos lecturas de eso, y las dos importan:
--
--   1. La defensa en profundidad AGUANTÓ. Los chequeos internos de rol que ya
--      tenían las funciones de borrado impidieron que se borrara nada. No hubo
--      pérdida de datos.
--   2. Y aun así hay que cerrarlo. Los dos mensajes distintos convierten a la
--      función en un oráculo de existencia, y esos chequeos internos eran lo
--      ÚNICO entre `anon` y un borrado en cascada. Un solo error futuro en esa
--      condición y no queda nada atrás.
--
-- EL HALLAZGO QUE CAMBIA EL PLAN: a `authenticated` NO se le puede revocar
-- ----------------------------------------------------------------------
-- Parece razonable pensar que los ayudantes de tenencia (is_org_member_*,
-- org_of_*) no necesitan EXECUTE porque "solo los usan las policies por dentro".
-- Es falso, y se comprobó contra esta misma base antes de escribir una línea:
-- las expresiones de una policy se evalúan con los privilegios del rol que hace
-- la consulta, no con los del dueño de la tabla.
--
--     revoke execute on function public.is_org_member_caughtcode(uuid)
--       from authenticated;
--     set role authenticated;  select count(*) from projects_caughtcode;
--     → ERROR 42501: permission denied for function is_org_member_caughtcode
--
-- (con el grant puesto, la misma consulta devuelve las 2 filas esperadas).
-- Revocarle `authenticated` a esas seis funciones dejaría a TODA persona con
-- sesión sin poder leer una sola fila de la app. Se quedan, a propósito.
--
-- Entonces el criterio, función por función, es quién la llama de verdad:
--   · el navegador o el server action con la sesión del usuario → `authenticated`
--     conserva EXECUTE, y lo que tiene que estar bien es la validación de adentro
--   · solo el worker con service_role                          → se revoca a los dos
--   · función de trigger                                        → se revoca a los dos
--     (Postgres verifica el permiso al CREAR el trigger, no cada vez que dispara)
--
-- Aditiva: no cambia ningún dato, ningún esquema, ninguna policy.
-- ============================================================================


-- ── 1 · Los ayudantes de tenencia dejan de contestar sin sesión ─────────────
-- `authenticated` los conserva porque son la base de todas las policies (ver
-- arriba). `anon` no: no hay una sola policy dirigida a `anon` en todo el
-- esquema, así que ninguno de estos se evalúa nunca para alguien sin sesión.
-- Lo único que hacía ese grant era contestar preguntas por la puerta de al lado.
revoke all on function public.is_org_member_caughtcode(uuid)   from anon;
revoke all on function public.is_org_admin_caughtcode(uuid)    from anon;
revoke all on function public.org_of_project_caughtcode(uuid)  from anon;
revoke all on function public.org_of_run_caughtcode(uuid)      from anon;
revoke all on function public.org_of_finding_caughtcode(uuid)  from anon;
revoke all on function public.org_of_thread_caughtcode(uuid)   from anon;


-- ── 2 · Las acciones del usuario: se quedan, porque las llama el usuario ────
-- Las cuatro salen de código que corre con la sesión de la persona, no con
-- service_role. Revocarles `authenticated` rompería la app:
--
--   ensure_org_caughtcode           src/app/(app)/current-org.ts
--                                   Primer ingreso. Sin esto, nadie nuevo tiene
--                                   dónde crear proyectos.
--   delete_project_cascade_*        src/components/projects/actions.ts
--   delete_account_caughtcode       src/app/(app)/cuenta/actions.ts
--   set_finding_status_caughtcode   src/components/findings/finding-status-control.tsx
--                                   Esta la llama el NAVEGADOR directamente.
--
-- Se auditó la validación interna de las cuatro, que es lo que de verdad las
-- protege ahora que siguen expuestas. Las cuatro derivan la autorización del
-- servidor y ninguna le cree al cliente el id de la organización:
--
--   ensure_org          → solo tu propio usuario (auth.uid()), o service_role
--   delete_project      → is_org_admin_caughtcode(org DEL PROYECTO, leída de la
--                         tabla, no del parámetro)
--   delete_account      → solo tu propio user_id, o service_role
--   set_finding_status  → is_org_member_caughtcode(org_of_finding_caughtcode(id)),
--                         resuelta desde el hallazgo; además solo puede escribir
--                         status y resolved_at
--
-- No hacía falta arreglar ninguna. Se les saca `anon` y nada más.
revoke all on function public.ensure_org_caughtcode(uuid)               from anon;
revoke all on function public.delete_project_cascade_caughtcode(uuid)   from anon;
revoke all on function public.delete_account_caughtcode(uuid)           from anon;
revoke all on function public.set_finding_status_caughtcode(uuid, text) from anon;


-- ── 3 · Las funciones de trigger no son endpoints ──────────────────────────
-- Las dispara Postgres cuando se toca la tabla. El permiso se verifica al crear
-- el trigger, no en cada disparo, así que sacarles EXECUTE a todo el mundo no
-- las apaga. PostgREST hoy tampoco las publica (devuelven `trigger`), pero eso
-- es una decisión de PostgREST, no una garantía nuestra: el grant sobraba igual.
--
-- set_updated_at_caughtcode no venía en el informe de los advisors porque no es
-- `security definer`. Va acá de todos modos: es exactamente la misma clase de
-- objeto y el mismo grant de más.
--
-- ⚠️ Acá hay que revocarle a `public` TAMBIÉN, y por el motivo inverso al de
-- arriba. Estas tres son las únicas de la lista cuya migración original nunca
-- hizo `revoke ... from public`, así que conservaban el default de Postgres
-- (`GRANT EXECUTE ON FUNCTIONS TO PUBLIC`, que es del motor, no de Supabase).
-- Se vio en el ACL crudo: `{=X/postgres, …}` — el grantee vacío es PUBLIC.
--
-- O sea: los dos revokes son necesarios y ninguno reemplaza al otro. `anon` con
-- el privilegio a nombre propio sobrevive a un revoke a `public`; y `public`
-- sobrevive a un revoke a `anon`. Ojo con verificar esto con
-- `has_function_privilege('anon', …)`: devuelve true en los dos casos y no
-- distingue de dónde viene el permiso. Para eso hay que mirar `pg_proc.proacl`.
revoke all on function public.add_owner_membership_caughtcode()      from public, anon, authenticated;
revoke all on function public.guard_organization_update_caughtcode() from public, anon, authenticated;
revoke all on function public.set_updated_at_caughtcode()            from public, anon, authenticated;


-- ── 4 · org_of_* deja de contestar por proyectos ajenos ────────────────────
-- Esto no es un grant, es el agujero que quedaba abierto DESPUÉS de sacarle
-- `anon`: cualquiera con sesión —incluidas las personas del otro producto que
-- comparte esta base, que también son `authenticated` acá— podía traducir un id
-- de proyecto ajeno a su organización, y de paso confirmar que ese proyecto
-- existe. Son `security definer`: pasan por encima de RLS y no preguntaban nada.
--
-- Explotarlo exige adivinar un uuid v4, así que la gravedad es baja. Se cierra
-- igual: es de una línea y este producto se llama caughtcode.
--
-- El arreglo NO cambia lo que ven las policies. Todas las usan envueltas, así:
--
--     is_org_member_caughtcode( org_of_project_caughtcode(project_id) )
--
-- Si sos miembro, devuelve tu organización igual que antes. Si no, devuelve null
-- en vez del uuid ajeno — y is_org_member_caughtcode(null) ya era false. Misma
-- decisión, misma fila visible o no visible; lo único que cambia es que el dato
-- deja de salir por la puerta.
--
-- La rama de service_role está porque el worker no pasa por RLS (rolbypassrls) y
-- tiene que poder resolver la organización de cualquier proyecto para hacer su
-- trabajo.

create or replace function public.org_of_project_caughtcode(p_project_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id
  from public.projects_caughtcode p
  where p.id = p_project_id
    and (
      coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
      or public.is_org_member_caughtcode(p.org_id)
    );
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
  where r.id = p_analysis_run_id
    and (
      coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
      or public.is_org_member_caughtcode(p.org_id)
    );
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
  where f.id = p_finding_id
    and (
      coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
      or public.is_org_member_caughtcode(p.org_id)
    );
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
  where t.id = p_thread_id
    and (
      coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
      or public.is_org_member_caughtcode(p.org_id)
    );
$$;

comment on function public.org_of_project_caughtcode(uuid) is
  'Organización dueña de un proyecto, solo si quien pregunta es miembro (o es el servidor). null en cualquier otro caso: ver migración 0014.';
comment on function public.org_of_run_caughtcode(uuid) is
  'Organización dueña de una corrida de análisis, solo si quien pregunta es miembro (o es el servidor). null en cualquier otro caso: ver migración 0014.';
comment on function public.org_of_finding_caughtcode(uuid) is
  'Organización dueña de un hallazgo, solo si quien pregunta es miembro (o es el servidor). null en cualquier otro caso: ver migración 0014.';
comment on function public.org_of_thread_caughtcode(uuid) is
  'Organización dueña de un hilo de chat, solo si quien pregunta es miembro (o es el servidor). null en cualquier otro caso: ver migración 0014.';


-- ── 5 · Se reponen los grants que sí van ───────────────────────────────────
-- `create or replace` conserva los permisos de la función anterior, así que
-- esto es cinturón y tiradores: deja el estado final escrito, sin depender de
-- lo que hubiera antes ni del orden en que se apliquen las migraciones.
grant execute on function public.org_of_project_caughtcode(uuid)  to authenticated, service_role;
grant execute on function public.org_of_run_caughtcode(uuid)      to authenticated, service_role;
grant execute on function public.org_of_finding_caughtcode(uuid)  to authenticated, service_role;
grant execute on function public.org_of_thread_caughtcode(uuid)   to authenticated, service_role;
revoke all on function public.org_of_project_caughtcode(uuid)  from anon;
revoke all on function public.org_of_run_caughtcode(uuid)      from anon;
revoke all on function public.org_of_finding_caughtcode(uuid)  from anon;
revoke all on function public.org_of_thread_caughtcode(uuid)   from anon;


-- ── 6 · Que no vuelva a pasar ──────────────────────────────────────────────
-- La causa raíz no era ninguna función en particular: era el default privilege
-- del schema. Mientras siga puesto, la próxima función que alguien cree nace
-- otra vez abierta a internet y hay que acordarse de revocar a mano.
--
-- No se toca acá a propósito. Ese default es del schema `public`, que en esta
-- base COMPARTIMOS con otro producto en producción: cambiarlo les cambiaría el
-- comportamiento a ellos también, y eso no es una decisión nuestra.
--
-- Lo que sí queda es la regla — toda función nueva `_caughtcode` revoca a `anon`
-- POR NOMBRE en su propia migración, y después otorga solo a quien la llama de
-- verdad — y un test que la hace cumplir sin depender de que alguien se acuerde:
--
--     psql "$SUPABASE_DB_URL" -f supabase/tests/grants_rpc.sql
--
-- Falla si aparece una función nuestra invocable por `anon`, y también si se
-- revocó de más y quedó rota alguna que la app necesita.
