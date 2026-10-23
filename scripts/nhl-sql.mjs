// Builds supabase/nhl/setup.sql: the NHL league's whole database in one file, from the NBA league's
// SQL files with the hockey slots, weeks and decree codes swapped in.
//
//   PHS_SPORT=nhl node scripts/nhl-sql.mjs
//
// Both leagues live in the same Supabase project so one account signs in to both: the NBA league's
// tables are in the public schema, the NHL league's in the nhl schema. Accounts (auth.users) are
// shared, so the NHL file leaves the sign-up triggers on auth.users to the NBA files, and removing
// someone from the NHL league removes them from that league only.
//
// Run it again after changing any file in supabase/, and commit the result. Like the files it is
// built from, setup.sql is safe to re-run.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPORT, LEAGUE, buildWeeks, defaultLockAt } from '../src/config.js';
import { DECREE_CODES } from '../src/decrees.js';

if (SPORT !== 'nhl') throw new Error('Run with PHS_SPORT=nhl.');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The order the README gives for a new NBA league, harden.sql last.
export const FILES = ['schema', 'admin', 'upgrade-dub-invite', 'upgrade-onboarding', 'upgrade-cards', 'upgrade-decree', 'upgrade-settings', 'upgrade-commissioner-ops', 'harden'];
const SCHEMA = LEAGUE.dbSchema;

const list = xs => `(${xs.map(x => `'${x}'`).join(', ')})`;
const NBA_SLOTS = "('PTS', 'REB', 'AST', 'WIN')";

// Replaces exactly `count` occurrences, so a change in the source files can't slip by unnoticed.
function swap(text, from, to, count, file) {
  const n = text.split(from).length - 1;
  if (n !== count) throw new Error(`${file}: expected ${count} × ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return text.split(from).join(to);
}

// The text from `start` up to and including `end`, which must both be there.
function cut(text, start, end, file) {
  const i = text.indexOf(start), j = text.indexOf(end, i);
  if (i < 0 || j < 0) throw new Error(`${file}: block ${JSON.stringify(start.slice(0, 50))} not found`);
  return [text.slice(0, i), text.slice(i, j + end.length), text.slice(j + end.length)];
}

// The NBA file's sign-up check (public.require_invite and its trigger on auth.users).
const INVITE_START = '-- Sign-ups must carry the code';
const INVITE_END = 'for each row execute function public.require_invite();';

export function nhlSql(sources) {
  const out = [];
  for (const f of FILES) {
    let sql = sources[f];
    // Picks take every slot, Gloves Off included; un-burns and cards only the ranked ones.
    if (f === 'upgrade-dub-invite') {
      sql = swap(sql, `picks_slot_check check (slot in ${NBA_SLOTS})`, `picks_slot_check check (slot in ${list(LEAGUE.pickSlots)})`, 1, f);
      // Sign-ups are shared: the NBA file's trigger checks both leagues' codes (added at the end of this file).
      const [before, , after] = cut(sql, INVITE_START, INVITE_END, f);
      sql = `${before}-- Sign-ups: one account for both leagues, so the trigger on auth.users is the NBA league's
-- (public.require_invite, at the end of this file). It accepts this league's code too.${after}`;
    }
    if (['schema', 'upgrade-dub-invite', 'upgrade-cards'].includes(f)) sql = sql.split(NBA_SLOTS).join(list(LEAGUE.slots));
    if (f === 'schema') {
      const start = sql.indexOf('insert into public.weeks (week, lock_at) values');
      const end = sql.indexOf('on conflict (week) do nothing;', start);
      if (start < 0 || end < 0) throw new Error('schema: weeks insert not found');
      const rows = buildWeeks().map(w => `  (${w.week}, '${defaultLockAt(w)}')`).join(',\n');
      sql = `${sql.slice(0, start)}insert into public.weeks (week, lock_at) values\n${rows}\n${sql.slice(end)}`;
    }
    if (f === 'upgrade-decree') {
      const start = sql.indexOf('options <@ array[');
      const end = sql.indexOf(']::text[]', start);
      if (start < 0 || end < 0) throw new Error('upgrade-decree: decree codes not found');
      sql = `${sql.slice(0, start)}options <@ array[\n      ${DECREE_CODES.map(c => `'${c}'`).join(', ')}\n    ${sql.slice(end)}`;
    }
    if (f === 'admin') {
      // The commissioner's check-in counts the four ranked slots; Gloves Off is optional.
      sql = swap(sql, 'select pk.user_id, count(*)::int, count(pk.alt_id)::int', "select pk.user_id, (count(*) filter (where pk.slot <> 'FIGHT'))::int, count(pk.alt_id)::int", 1, f);
      // Removing someone takes them out of this league only: the account and the NBA league stay.
      sql = swap(sql, '-- Deletes the account and everything tied to it (profile, picks, jokers), and\n-- optionally blocks the email.',
        "-- Takes them out of this league (profile, picks, jokers) and optionally blocks the email from\n-- rejoining it. Their Peakhill account and the NBA league aren't touched.", 1, f);
      sql = swap(sql, 'delete from auth.users u where u.id = target;', 'delete from public.profiles p where p.id = target;', 1, f);
      // A blocked email can't rejoin this league (accounts are shared, so it's checked on joining, not sign-up).
      const [before, , after] = cut(sql, '-- Sign-ups from blocked emails fail.', 'for each row execute function public.reject_blocked_signup();', f);
      sql = `${before}-- A blocked email can't rejoin this league.
create or replace function public.reject_blocked_member()
  returns trigger
  language plpgsql security definer set search_path = public
  as $$
  begin
    if exists (select 1 from public.blocked_emails b join auth.users u on lower(u.email) = b.email where u.id = new.id) then
      raise exception 'This email has been removed from the league.';
    end if;
    return new;
  end
  $$;
drop trigger if exists reject_blocked_member on public.profiles;
create trigger reject_blocked_member before insert on public.profiles
  for each row execute function public.reject_blocked_member();${after}`;
    }
    if (f === 'upgrade-commissioner-ops') sql = swap(sql, 'count(*)::int as slots', "(count(*) filter (where pk.slot <> 'FIGHT'))::int as slots", 1, f);
    sql = sql.replace(/Peakhill NBA Survivor/g, LEAGUE.name);
    // Everything moves to the league's own schema. `from public, anon` (the PUBLIC role) stays.
    sql = sql.split('public.').join(`${SCHEMA}.`)
      .split('search_path = public').join(`search_path = ${SCHEMA}`)
      .split('schema public').join(`schema ${SCHEMA}`);
    out.push(`-- ======== from supabase/${f}.sql ========\n\n${sql.trim()}\n`);
  }
  // The NBA league's sign-up check, which also accepts this league's invite code.
  const [, invite] = cut(sources['upgrade-dub-invite'], INVITE_START, INVITE_END, 'upgrade-dub-invite');
  return `-- ${LEAGUE.name}: the whole database, in one file. Generated by scripts/nhl-sql.mjs from the
-- files in supabase/ (don't edit it by hand). Run it in the NBA league's Supabase project: the NHL
-- league's tables go in the ${SCHEMA} schema, and accounts are shared, so one sign-in works in both.
-- Safe to re-run. Then add ${SCHEMA} to the API's exposed schemas, set the invite code and add
-- yourself as commissioner (see the README).

create schema if not exists ${SCHEMA};
grant usage on schema ${SCHEMA} to anon, authenticated, service_role;
alter default privileges in schema ${SCHEMA} grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema ${SCHEMA} grant usage, select on sequences to authenticated, service_role;

${out.join('\n')}
-- ======== table access ========
-- Row-level security above decides what each member sees; signed out (anon) gets nothing.
grant select, insert, update, delete on all tables in schema ${SCHEMA} to authenticated, service_role;
grant usage, select on all sequences in schema ${SCHEMA} to authenticated, service_role;

-- ======== sign-ups (the NBA league's check, from supabase/upgrade-dub-invite.sql) ========

${invite}

notify pgrst, 'reload schema';
`;
}

async function main() {
  const sources = {};
  for (const f of FILES) sources[f] = await readFile(path.join(ROOT, 'supabase', `${f}.sql`), 'utf8');
  await mkdir(path.join(ROOT, 'supabase', 'nhl'), { recursive: true });
  await writeFile(path.join(ROOT, 'supabase', 'nhl', 'setup.sql'), nhlSql(sources));
  console.log('Wrote supabase/nhl/setup.sql');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
