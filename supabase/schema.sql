-- Peakhill NBA Survivor: database schema.
-- Paste into Supabase → SQL Editor → Run. Safe to re-run.

-- People in the league. One row per signed-in account.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  fav_team text,
  rival_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_name_unique on public.profiles (lower(display_name));

-- Pick locks. The data script moves each lock to the week's real first tip-off.
create table if not exists public.weeks (
  week int primary key,
  lock_at timestamptz not null
);

-- One row per person, week and slot.
create table if not exists public.picks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  week int not null references public.weeks(week),
  slot text not null check (slot in ('PTS', 'REB', 'AST')),
  player_id int not null,
  alt_id int,
  double_down boolean not null default false,
  auto boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, week, slot),
  check (alt_id is null or alt_id <> player_id)
);
-- Double Down joker: once a season.
create unique index if not exists picks_one_double_down on public.picks (user_id) where double_down;

-- Un-burn joker: once a season, one player back in one slot.
create table if not exists public.unburns (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  slot text not null check (slot in ('PTS', 'REB', 'AST')),
  player_id int not null,
  week int not null references public.weeks(week),
  created_at timestamptz not null default now()
);

create or replace function public.week_open(w int) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from weeks where week = w and lock_at > now()) $$;

create or replace function public.week_locked(w int) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from weeks where week = w and lock_at <= now()) $$;

alter table public.profiles enable row level security;
alter table public.weeks enable row level security;
alter table public.picks enable row level security;
alter table public.unburns enable row level security;

drop policy if exists "profiles readable" on public.profiles;
drop policy if exists "profiles insert own" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles readable" on public.profiles for select to anon, authenticated using (true);
create policy "profiles insert own" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "weeks readable" on public.weeks;
create policy "weeks readable" on public.weeks for select to anon, authenticated using (true);

-- Your own picks any time; everyone's picks once the week locks.
drop policy if exists "picks readable" on public.picks;
drop policy if exists "picks insert own before lock" on public.picks;
drop policy if exists "picks update own before lock" on public.picks;
drop policy if exists "picks delete own before lock" on public.picks;
create policy "picks readable" on public.picks for select to anon, authenticated
  using (user_id = auth.uid() or public.week_locked(week));
create policy "picks insert own before lock" on public.picks for insert to authenticated
  with check (user_id = auth.uid() and public.week_open(week) and not auto);
create policy "picks update own before lock" on public.picks for update to authenticated
  using (user_id = auth.uid() and public.week_open(week))
  with check (user_id = auth.uid() and public.week_open(week) and not auto);
create policy "picks delete own before lock" on public.picks for delete to authenticated
  using (user_id = auth.uid() and public.week_open(week));

drop policy if exists "unburns readable" on public.unburns;
drop policy if exists "unburns insert own before lock" on public.unburns;
drop policy if exists "unburns delete own before lock" on public.unburns;
create policy "unburns readable" on public.unburns for select to anon, authenticated
  using (user_id = auth.uid() or public.week_locked(week));
create policy "unburns insert own before lock" on public.unburns for insert to authenticated
  with check (user_id = auth.uid() and public.week_open(week));
create policy "unburns delete own before lock" on public.unburns for delete to authenticated
  using (user_id = auth.uid() and public.week_open(week));

-- Default locks: 7pm ET on the first day of each week.
insert into public.weeks (week, lock_at) values
  (1, '2026-10-20T23:00:00.000Z'),
  (2, '2026-11-03T00:00:00.000Z'),
  (3, '2026-11-10T00:00:00.000Z'),
  (4, '2026-11-17T00:00:00.000Z'),
  (5, '2026-11-24T00:00:00.000Z'),
  (6, '2026-12-01T00:00:00.000Z'),
  (7, '2026-12-08T00:00:00.000Z'),
  (8, '2026-12-15T00:00:00.000Z'),
  (9, '2026-12-22T00:00:00.000Z'),
  (10, '2026-12-29T00:00:00.000Z'),
  (11, '2027-01-05T00:00:00.000Z'),
  (12, '2027-01-12T00:00:00.000Z'),
  (13, '2027-01-19T00:00:00.000Z'),
  (14, '2027-01-26T00:00:00.000Z'),
  (15, '2027-02-02T00:00:00.000Z'),
  (16, '2027-02-09T00:00:00.000Z'),
  (17, '2027-02-16T00:00:00.000Z'),
  (18, '2027-03-02T00:00:00.000Z'),
  (19, '2027-03-09T00:00:00.000Z'),
  (20, '2027-03-15T23:00:00.000Z'),
  (21, '2027-03-22T23:00:00.000Z'),
  (22, '2027-03-29T23:00:00.000Z'),
  (23, '2027-04-05T23:00:00.000Z')
on conflict (week) do nothing;
