-- Peakhill NBA Survivor: lock the API down. Run in the Supabase SQL editor after the
-- other files (and again after adding a new table or function). Safe to re-run.
--
-- The app's public key ships to every browser, so anyone can call the API with it.
-- This file makes sure that key on its own gets nothing, and that signed-in members
-- can only read what the app already shows them and can't fake the fields the
-- server should own.

-- ---- Members only ----
-- Signed out (the anon role), nothing in the league is readable: no names, account
-- ids, picks, cards or locks. Every policy and function is for signed-in members.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from public, anon;

grant execute on all functions in schema public to authenticated, service_role;

-- The invite code can't be tried over the API. Only sign-up checks it, and Supabase
-- rate-limits sign-ups, so it can't be guessed by brute force.
revoke execute on function public.check_invite(text) from authenticated;

-- ---- The server owns the timestamps ----
-- Join dates decide when your first card pack arrives, so they can't be backdated.
-- Save times are set by the server too. The SQL editor and the data job are exempt.
create or replace function public.stamp_profile() returns trigger
  language plpgsql set search_path = public
  as $$
  begin
    if current_user in ('anon', 'authenticated') then
      new.created_at := case when tg_op = 'INSERT' then now() else old.created_at end;
    end if;
    return new;
  end
  $$;
drop trigger if exists stamp_profile on public.profiles;
create trigger stamp_profile before insert or update on public.profiles
  for each row execute function public.stamp_profile();

create or replace function public.stamp_updated() returns trigger
  language plpgsql set search_path = public
  as $$
  begin
    if current_user in ('anon', 'authenticated') then new.updated_at := now(); end if;
    return new;
  end
  $$;
drop trigger if exists stamp_updated on public.picks;
create trigger stamp_updated before insert or update on public.picks
  for each row execute function public.stamp_updated();

create or replace function public.stamp_created() returns trigger
  language plpgsql set search_path = public
  as $$
  begin
    if current_user in ('anon', 'authenticated') then new.created_at := now(); end if;
    return new;
  end
  $$;
drop trigger if exists stamp_created on public.unburns;
create trigger stamp_created before insert on public.unburns
  for each row execute function public.stamp_created();
drop trigger if exists stamp_created on public.decree_votes;
create trigger stamp_created before insert or update on public.decree_votes
  for each row execute function public.stamp_created();

-- ---- Size limits ----
-- Everyone downloads every profile and card row, so one oversized or garbage value
-- slows the app down for the whole league. NOT VALID: checks new writes only.
alter table public.profiles drop constraint if exists profiles_fav_team_check;
alter table public.profiles add constraint profiles_fav_team_check
  check (fav_team is null or fav_team ~ '^[A-Z]{2,3}$') not valid;
-- No control, zero-width or right-to-left characters, which can disguise one name as another.
alter table public.profiles drop constraint if exists profiles_display_name_chars;
alter table public.profiles add constraint profiles_display_name_chars
  check (display_name !~ '[[:cntrl:]​-‏‪-‮⁠-⁩﻿]') not valid;

alter table public.card_plays drop constraint if exists card_plays_size_check;
alter table public.card_plays add constraint card_plays_size_check
  check (octet_length(params::text) <= 1000 and (card_uid is null or char_length(card_uid) <= 80)) not valid;

-- A real week needs a handful of card rows; 40 is plenty, and stops anyone flooding the table.
create or replace function public.card_plays_cap() returns trigger
  language plpgsql set search_path = public
  as $$
  begin
    if current_user in ('anon', 'authenticated')
      and (select count(*) from public.card_plays c where c.user_id = new.user_id and c.week = new.week) >= 40 then
      raise exception 'Too many card plays this week.';
    end if;
    return new;
  end
  $$;
drop trigger if exists card_plays_cap on public.card_plays;
create trigger card_plays_cap before insert on public.card_plays
  for each row execute function public.card_plays_cap();
