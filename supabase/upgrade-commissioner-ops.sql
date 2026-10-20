-- Peakhill NBA Survivor: commissioner office tooling.
-- Run in Supabase → SQL Editor after admin.sql. Safe to re-run.
--
-- Extends the Week check-in (packs / card plays as flags only), decree vote
-- turnout (who voted, never which option), and week row helpers for the
-- commissioner's office tools.

-- ---- Check-in: slot counts plus pack/play flags (never which players/cards) ----

create or replace function public.admin_checkin(w int)
  returns table (
    user_id uuid,
    slots int,
    backups int,
    last_saved timestamptz,
    pack_kept boolean,
    played boolean
  )
  language sql stable security definer set search_path = public
  as $$
    with members as (
      select p.id from profiles p where public.is_admin()
    ),
    pick as (
      select pk.user_id,
             count(*)::int as slots,
             count(pk.alt_id)::int as backups,
             max(pk.updated_at) as last_saved
      from picks pk
      where pk.week = w and public.is_admin()
      group by pk.user_id
    ),
    packs as (
      select c.user_id
      from card_plays c
      where c.week = w and c.card = '_keep'
        and c.card_uid like 'pack:w' || w::text || ':%'
        and public.is_admin()
      group by c.user_id
    ),
    plays as (
      select c.user_id
      from card_plays c
      where c.week = w
        and c.card = any (array[
          'jinx', 'load', 'heist', 'blue_shell', 'burn_notice',
          'clown', 'nickname', 'sixth', 'copycat', 'leech',
          'switcheroo', 'garbage', 'embargo', 'scout', 'duel'
        ]::text[])
        and public.is_admin()
      group by c.user_id
    )
    select m.id,
           coalesce(p.slots, 0),
           coalesce(p.backups, 0),
           p.last_saved,
           exists (select 1 from packs k where k.user_id = m.id),
           exists (select 1 from plays y where y.user_id = m.id)
    from members m
    left join pick p on p.user_id = m.id
    order by m.id
  $$;

-- ---- Decree vote turnout: who has cast a ballot (never the choice) ----

create or replace function public.admin_vote_turnout(w int)
  returns table (user_id uuid)
  language sql stable security definer set search_path = public
  as $$
    select v.user_id
    from decree_votes v
    where v.week = w and public.is_admin()
  $$;

-- ---- Week board: every pick and card play, for weeks that have locked ----
-- Like everyone else, the commissioner sees a week's picks and cards only once it locks.
create or replace function public.week_locked(w int) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from weeks wk where wk.week = w and wk.lock_at <= now()) $$;

create or replace function public.admin_week_rows(w int)
  returns table (
    user_id uuid,
    slot text,
    player_id int,
    alt_id int,
    double_down boolean,
    auto boolean,
    updated_at timestamptz
  )
  language sql stable security definer set search_path = public
  as $$
    select pk.user_id, pk.slot, pk.player_id, pk.alt_id, pk.double_down, coalesce(pk.auto, false), pk.updated_at
    from picks pk
    where pk.week = w and public.is_admin() and public.week_locked(w)
  $$;

create or replace function public.admin_week_plays(w int)
  returns setof public.card_plays
  language sql stable security definer set search_path = public
  as $$
    select c.* from card_plays c where c.week = w and public.is_admin() and public.week_locked(w)
  $$;

-- Pack seeds for every member, for locked weeks only (pack_seeds already gives everyone those).
-- An open week's seed would reveal someone's hand before the lock.
create or replace function public.admin_pack_seeds()
  returns table (user_id uuid, week int, seed text)
  language sql stable security definer set search_path = public, extensions
  as $$
    select p.id, w.week,
      encode(extensions.hmac(p.id::text || '|' || w.week::text, (select secret from league_secret where id), 'sha256'), 'hex')
    from profiles p cross join weeks w
    where public.is_admin() and w.lock_at <= now()
  $$;

revoke execute on function public.week_locked(int) from public, anon;
revoke execute on function public.admin_checkin(int) from public, anon;
revoke execute on function public.admin_vote_turnout(int) from public, anon;
revoke execute on function public.admin_week_rows(int) from public, anon;
revoke execute on function public.admin_week_plays(int) from public, anon;
revoke execute on function public.admin_pack_seeds() from public, anon;

grant execute on function public.week_locked(int) to authenticated;
grant execute on function public.admin_checkin(int) to authenticated;
grant execute on function public.admin_vote_turnout(int) to authenticated;
grant execute on function public.admin_week_rows(int) to authenticated;
grant execute on function public.admin_week_plays(int) to authenticated;
grant execute on function public.admin_pack_seeds() to authenticated;
