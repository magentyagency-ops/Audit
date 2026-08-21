-- =============================================================================
-- Nira Audit — Stockage des missions
-- =============================================================================
-- À exécuter dans l'éditeur SQL de Supabase, après supabase/relay-auth.sql.
-- Idempotent : peut être rejoué sans risque.
--
-- Ces tables ne sont jamais lues depuis le navigateur : seule l'API (clé
-- service_role) y accède, après avoir vérifié la session et le rôle du compte.
-- La RLS est donc activée sans aucune politique, ce qui ferme complètement
-- l'accès via les clés publiques (la clé service_role, elle, contourne la RLS).
-- =============================================================================

-- Registre des projets : une ligne par mission, la fiche complète en jsonb.
create table if not exists public.relay_projects (
    id text primary key,
    data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- État complet d'une mission : notes, entretiens, synthèses, cartographie,
-- collaborateurs, agenda, conversations de l'assistant.
create table if not exists public.relay_project_state (
    project_id text primary key references public.relay_projects(id) on delete cascade,
    state jsonb not null,
    updated_at timestamptz not null default now()
);

-- Générations longues (rapport d'audit) : l'état doit survivre à la requête qui
-- les a lancées, puisqu'une autre invocation servira les appels de suivi.
create table if not exists public.relay_jobs (
    id text primary key,
    status text not null check (status in ('processing', 'complete', 'error')),
    result jsonb,
    error text,
    created_at timestamptz not null default now()
);

create index if not exists idx_relay_jobs_created on public.relay_jobs(created_at);

alter table public.relay_projects enable row level security;
alter table public.relay_project_state enable row level security;
alter table public.relay_jobs enable row level security;

-- Aucune politique : tout accès par clé anonyme ou par jeton utilisateur est refusé.
drop policy if exists "relay_projects_service_only" on public.relay_projects;
drop policy if exists "relay_project_state_service_only" on public.relay_project_state;
drop policy if exists "relay_jobs_service_only" on public.relay_jobs;

-- Nettoyage des traitements terminés de plus d'un jour.
create or replace function public.purge_relay_jobs()
returns void language sql security definer set search_path = public as $$
  delete from public.relay_jobs where created_at < now() - interval '1 day';
$$;
