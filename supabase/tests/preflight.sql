-- ============================================================================
-- caughtcode · Chequeo previo al push
-- ----------------------------------------------------------------------------
-- caughtcode NO tiene proyecto propio: vive dentro de un proyecto de Supabase
-- compartido con otro producto que ya está en producción. Antes de aplicar las
-- migraciones hay que confirmar que no le pisamos nada.
--
-- Correr esto ANTES de `supabase db push`:
--
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/preflight.sql
--
-- Es de solo lectura y termina en ROLLBACK. Si sale sin error, se puede pushear.
-- Si encuentra algo, IMPRIME QUÉ y falla: no pushear hasta resolverlo.
--
-- La regla es simple: todo lo nuestro termina en `_caughtcode`. Entonces, si ya
-- existe algo con ese sufijo en la base, o alguien más lo usó, o quedó basura de
-- un push anterior a medio aplicar. En los dos casos hay que mirarlo a mano.
-- ============================================================================

begin;

-- ── 1. Con qué nos vamos a compartir la casa ───────────────────────────────
select
  'contexto' as tipo,
  (select count(*) from pg_tables where schemaname = 'public')                     as tablas_en_public,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public')                                                    as funciones_en_public,
  (select count(*) from storage.buckets)                                           as buckets,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime') as tablas_en_realtime;


-- ── 2. Colisiones: cualquier cosa que ya termine en _caughtcode ────────────
select 'COLISIÓN' as gravedad, 'tabla o vista' as objeto, c.relname as nombre
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'v', 'm', 'p', 'f')
   and c.relname like '%\_caughtcode'

union all
select 'COLISIÓN', 'función', p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname like '%\_caughtcode'

union all
select 'COLISIÓN', 'índice', c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'i'
   and c.relname like '%\_caughtcode'

union all
select 'COLISIÓN', 'constraint', con.conname
  from pg_constraint con
  join pg_namespace n on n.oid = con.connamespace
 where n.nspname = 'public'
   and con.conname like '%\_caughtcode'

union all
select 'COLISIÓN', 'tipo', t.typname
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'public'
   and t.typname like '%\_caughtcode'
   and t.typtype in ('e', 'c', 'd')

union all
select 'COLISIÓN', 'bucket de storage', b.id
  from storage.buckets b
 where b.id like '%\_caughtcode'

order by 2, 3;


-- ── 3. Lo que necesitamos que YA exista ────────────────────────────────────
select
  'requisito' as tipo,
  'publicación supabase_realtime' as necesita,
  case when exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       then 'presente' else 'FALTA — 0010 va a fallar' end as estado

union all
select 'requisito', 'esquema auth (solo lectura)',
  case when exists (select 1 from pg_namespace where nspname = 'auth')
       then 'presente' else 'FALTA' end

union all
select 'requisito', 'esquema storage',
  case when exists (select 1 from pg_namespace where nspname = 'storage')
       then 'presente' else 'FALTA' end;


-- ── 4. Veredicto ───────────────────────────────────────────────────────────
do $$
declare
  v_colisiones int;
  v_faltantes  text[] := '{}';
begin
  select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like '%\_caughtcode')
    + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '%\_caughtcode')
    + (select count(*) from pg_constraint con join pg_namespace n on n.oid = con.connamespace
        where n.nspname = 'public' and con.conname like '%\_caughtcode')
    + (select count(*) from storage.buckets where id like '%\_caughtcode')
  into v_colisiones;

  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    v_faltantes := v_faltantes || 'supabase_realtime';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    v_faltantes := v_faltantes || 'esquema auth';
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    v_faltantes := v_faltantes || 'esquema storage';
  end if;

  if v_colisiones > 0 then
    raise exception
      'NO PUSHEAR. Ya hay % objeto(s) terminados en _caughtcode en esta base. Mirá la lista de arriba: o el nombre ya lo usa otro, o quedó basura de un push anterior a medias.',
      v_colisiones;
  end if;

  if array_length(v_faltantes, 1) > 0 then
    raise exception 'NO PUSHEAR. Falta en la base: %', array_to_string(v_faltantes, ', ');
  end if;

  raise notice 'PREFLIGHT OK · No hay colisiones. Se puede correr supabase db push.';
end;
$$;

rollback;
