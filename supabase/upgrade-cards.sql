-- Peakhill NBA Survivor: Joker cards. Run once in the Supabase SQL editor. Safe to re-run.
--
-- What's stored: the card you kept from each pack ('_keep'; in Week 1 also one 'repick:' change of mind), duel answers ('_reply'),
-- gifts and plays. The league engine rebuilds every hand from these rows and ignores
-- (and flags at the reveal) any play for a card you don't actually hold.
-- Packs are dealt from a secret seed, so nobody can work out a colleague's hand early.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.card_plays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  week int not null references public.weeks(week),
  card text not null check (card in (
    '_keep', '_reply', 'gift',
    'jinx', 'load', 'heist', 'blue_shell', 'burn_notice', 'clown', 'nickname', 'charge', 'reverse',
    'sixth', 'copycat', 'leech', 'switcheroo', 'garbage', 'embargo', 'scout', 'duel')),
  card_uid text,
  target_id uuid references public.profiles(id) on delete cascade,
  slot text,
  player_id int,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.card_plays drop constraint if exists card_plays_slot_check;
alter table public.card_plays add constraint card_plays_slot_check check (slot in ('PTS', 'REB', 'AST', 'WIN'));
-- Each card (or pack, for '_keep') can be used once.
create unique index if not exists card_plays_once on public.card_plays (user_id, card_uid) where card_uid is not null;
create index if not exists card_plays_week on public.card_plays (week);

-- The server sets the id and time, so nobody can backdate a play.
create or replace function public.card_plays_stamp() returns trigger
  language plpgsql as $$
  begin
    new.id := gen_random_uuid();
    new.created_at := now();
    return new;
  end
  $$;
drop trigger if exists card_plays_stamp on public.card_plays;
create trigger card_plays_stamp before insert on public.card_plays
  for each row execute function public.card_plays_stamp();

-- When a row can be added or taken back. Hindsight cards rewrite last week, so
-- they go in after that week locks and before the next one does. An Embargo
-- has to give everyone a day's notice.
create or replace function public.card_window(c text, w int) returns boolean
  language sql stable security definer set search_path = public
  as $$
    select case
      when c in ('switcheroo', 'garbage') then public.week_locked(w) and public.week_open(w + 1)
      when c = 'embargo' then exists (select 1 from weeks where week = w and lock_at > now() + interval '24 hours')
      else public.week_open(w)
    end
  $$;

alter table public.card_plays enable row level security;
drop policy if exists "card plays readable" on public.card_plays;
drop policy if exists "card plays insert own" on public.card_plays;
drop policy if exists "card plays delete own" on public.card_plays;
-- Your own rows any time; everyone's once the week locks. An Embargo is public
-- straight away, and a duel (and its answer) is visible to the other person.
create policy "card plays readable" on public.card_plays for select to authenticated
  using (
    user_id = auth.uid() or public.week_locked(week) or card = 'embargo'
    or (card in ('duel', '_reply') and target_id = auth.uid())
  );
-- Kept cards are final. (Week 1 allowed one change of mind per pack, a second '_keep' row
-- 'repick:<pack key>'; those rows still count, but no new ones are accepted.)
create policy "card plays insert own" on public.card_plays for insert to authenticated
  with check (
    user_id = auth.uid() and public.card_window(card, week)
    and (card <> '_keep' or coalesce(card_uid, '') not like 'repick:%')
  );
-- Kept cards are final, and a Scout Report can't be taken back once it's been read:
-- a made-up Scout play stays on the record and is flagged at the reveal.
create policy "card plays delete own" on public.card_plays for delete to authenticated
  using (user_id = auth.uid() and card not in ('_keep', 'scout') and public.card_window(card, week));

-- Scout Report: the five most-picked players in one slot of the open week, as
-- counts only. Answers only someone who has played a Scout Report on that slot.
create or replace function public.scout_report(w int, s text)
  returns table (player_id int, picks int, entries int)
  language sql stable security definer set search_path = public
  as $$
    select p.player_id, count(*)::int,
      (select count(distinct x.user_id)::int from picks x where x.week = w)
    from picks p
    where p.week = w and p.slot = s and public.week_open(w)
      and exists (select 1 from card_plays c where c.user_id = auth.uid() and c.week = w and c.card = 'scout' and c.slot = s)
    group by p.player_id
    order by count(*) desc, p.player_id
    limit 5
  $$;
revoke execute on function public.scout_report(int, text) from public, anon;
grant execute on function public.scout_report(int, text) to authenticated;

-- ---- Secret pack seeds ----
-- One random secret, readable by nobody through the API.
create table if not exists public.league_secret (
  id boolean primary key default true check (id),
  secret text not null
);
alter table public.league_secret enable row level security;
insert into public.league_secret (id, secret)
  values (true, encode(extensions.gen_random_bytes(32), 'hex'))
  on conflict (id) do nothing;

-- Pack seeds per person and week: your own up to the open week, everyone's once
-- a week has locked, and all of them for the hourly data job (service role).
create or replace function public.pack_seeds()
  returns table (user_id uuid, week int, seed text)
  language sql stable security definer set search_path = public, extensions
  as $$
    select p.id, w.week,
      encode(extensions.hmac(p.id::text || '|' || w.week::text, (select secret from league_secret where id), 'sha256'), 'hex')
    from profiles p cross join weeks w
    where w.lock_at <= now()
      or (p.id = auth.uid() and w.week <= coalesce((select min(x.week) from weeks x where x.lock_at > now()), w.week))
      or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
  $$;
revoke execute on function public.pack_seeds() from public, anon;
grant execute on function public.pack_seeds() to authenticated, service_role;
