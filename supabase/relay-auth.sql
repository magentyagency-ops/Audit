-- =============================================================================
-- Nira Audit — Comptes et rôles
-- =============================================================================
-- À exécuter dans l'éditeur SQL de Supabase. Le script est idempotent et peut
-- être rejoué sans risque.
--
-- Il partage la table `profiles` avec Nira CRM : si elle existe déjà (base
-- commune), rien n'est écrasé et les comptes existants fonctionnent tels quels.
--
-- Modèle retenu :
--   * un compte « user » (consultant) accède aux missions de l'équipe ;
--   * un compte « admin » gère en plus les accès de l'équipe ;
--   * le premier compte créé — ou celui portant l'email ci-dessous — est admin.
-- =============================================================================

create or replace function public.bootstrap_admin_email()
returns text language sql immutable as $$ select 'clarence@nira-ia.com'::text $$;

-- -----------------------------------------------------------------------------
-- 1. Profils (une ligne par compte, adossée à auth.users)
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    full_name text not null default '',
    role text not null default 'user' check (role in ('admin', 'user')),
    active boolean not null default true,
    theme text not null default 'light' check (theme in ('light', 'midnight', 'ocean', 'sunset')),
    created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 2. Fonctions d'autorisation
-- -----------------------------------------------------------------------------
-- security definer : la fonction lit profiles sans repasser par la RLS, ce qui
-- évite une récursion infinie dans les politiques ci-dessous.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active);
$$;

create or replace function public.is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

-- -----------------------------------------------------------------------------
-- 3. Création automatique du profil à l'inscription
-- -----------------------------------------------------------------------------
-- Le déclencheur n'est installé que s'il n'existe pas déjà : sur une base
-- partagée avec Nira CRM, la version du CRM (qui reprend aussi les leads
-- orphelins) reste en place et fait déjà le travail.
create or replace function public.handle_new_relay_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  assigned_role text;
begin
  select case
    when (select count(*) from public.profiles) = 0 then 'admin'
    when new.email = public.bootstrap_admin_email() then 'admin'
    else 'user'
  end into assigned_role;

  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''), assigned_role)
  on conflict (id) do nothing;

  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname in ('on_auth_user_created', 'on_auth_user_created_relay')) then
    create trigger on_auth_user_created_relay
      after insert on auth.users
      for each row execute function public.handle_new_relay_user();
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. RLS sur les profils
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Un compte peut modifier son nom et son thème, jamais son rôle ni son activation :
-- le garde-fou est un trigger, une politique RLS qui relirait profiles récurserait.
create or replace function public.protect_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() est nul pour la clé service_role et pour l'éditeur SQL : ces deux
  -- chemins sont déjà réservés à l'administration et ne sont pas bridés ici.
  if auth.uid() is not null and not public.is_admin() then
    new.role := old.role;
    new.active := old.active;
    new.email := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on public.profiles;
create trigger profiles_protect_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
