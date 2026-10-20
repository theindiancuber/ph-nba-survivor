-- Peakhill NBA Survivor: league settings the commissioner edits from the Commissioner tab.
-- Run once in the Supabase SQL editor, after admin.sql. Safe to re-run.
--
-- Three rows, readable by every member (everyone's app needs them to score the league), written
-- only by commissioners:
--   'rules'        survival bars and card rules, each change taking effect from a week
--   'meta'         lives, drops, decree limits, the commissioner's name, an announcement
--   'adjustments'  public point and life corrections, each with a reason
--
-- The table is league_config. (It was once also called league_settings, but that name already
-- belongs to the one-row invite-code table from upgrade-dub-invite.sql, so this file used to
-- skip creating it and put its policies on the invite table instead. The cleanup below undoes that.)

create table if not exists public.league_config (
  key text primary key check (key in ('rules', 'meta', 'adjustments')),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.league_config enable row level security;
drop policy if exists "config readable" on public.league_config;
drop policy if exists "config commissioner insert" on public.league_config;
drop policy if exists "config commissioner update" on public.league_config;
drop policy if exists "config commissioner delete" on public.league_config;
create policy "config readable" on public.league_config for select to authenticated using (true);
create policy "config commissioner insert" on public.league_config for insert to authenticated with check (public.is_admin());
create policy "config commissioner update" on public.league_config for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "config commissioner delete" on public.league_config for delete to authenticated using (public.is_admin());
revoke all on public.league_config from anon;

-- Cleanup: the invite-code table takes no API policies (only its functions read it), so remove
-- the ones an earlier version of this file added to it by mistake. They let any member read the code.
do $$
begin
  if to_regclass('public.league_settings') is not null then
    drop policy if exists "settings readable" on public.league_settings;
    drop policy if exists "settings commissioner insert" on public.league_settings;
    drop policy if exists "settings commissioner update" on public.league_settings;
    drop policy if exists "settings commissioner delete" on public.league_settings;
  end if;
end
$$;

-- How many decrees a season: meta.decree.perSeason in league_config (from the
-- Commissioner tab), or 3 if that hasn't been set.
create or replace function public.decree_limit() returns int
  language plpgsql stable security definer set search_path = public
  as $$
  begin
    return coalesce((select (value #>> '{decree,perSeason}')::int from league_config where key = 'meta'), 3);
  exception when undefined_table or undefined_column then
    return 3;
  end
  $$;

-- The decree insert policy uses decree_limit() (upgrade-decree.sql sets it up the same way).
do $$
begin
  if to_regclass('public.decrees') is not null then
    drop policy if exists "decrees commissioner insert" on public.decrees;
    create policy "decrees commissioner insert" on public.decrees for insert to authenticated
      with check (public.is_admin() and public.decree_open(week) and (select count(*) from public.decrees) < public.decree_limit());
  end if;
end
$$;

-- Tell the API about the table straight away, so the Commissioner tab can save without waiting
-- for Supabase to notice ("Could not find the table ... in the schema cache").
notify pgrst, 'reload schema';
