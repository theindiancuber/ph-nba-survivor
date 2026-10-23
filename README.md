# Peakhill Survivor Leagues

One site, two leagues: **NBA Survivor** at the root and **NHL Survivor** at `nhl/` (see [The NHL league](#the-nhl-league)). One Peakhill account signs in to both; each league has its own standings, picks, cards and data. The switch at the top of the page moves between them.

## Peakhill NBA Survivor


A free, season-long NBA player-survivor league for the office. Every week you pick a scorer (**Bucket**), a rebounder (**Glass**), a passer (**Dime**) and a team to win (**Dub**). Each pick scores its weekly total. Once you use a player or team in a category, it's burned in that category for the season. You score 1 point for every colleague your pick beats, keep 3 lives on the survivor ladder, and play two Jokers plus a deck of collectible Joker cards (jinxes, traps, duels, heists, Blue Shells and pranks) that you pull from packs. Champions get a downloadable certificate. Rules and design notes are in [CONCEPT.md](CONCEPT.md).

## How it fits together

| Piece | What it does |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | The app. Static files, no build step. |
| `src/league.js` | The rules engine: burns, backups, rank scoring, card effects, lives, drops, Monthly Crowns, awards, head-to-head, Autopilot. Shared by the app and the data script. |
| `src/cards.js` | The Joker card deck, pack odds, seeded pack dealing, and the hand/trap/attack bookkeeping the engine uses. |
| `src/pack.js` | Card faces, foil packs and the pack-opening animation (swipe to tear, rarity tell, walkout, flip, keep one and burn the rest). |
| `src/config.js` | League settings for each sport: name, commissioner, slots, bars, calendar, Supabase keys. A page picks its league with `<html data-sport="nhl">`; the data job and tests with `PHS_SPORT=nhl`. |
| `supabase/schema.sql` | Accounts, picks, jokers and card plays, with row-level security. You can only write your own picks, only before the lock, and nobody can see anyone else's picks or cards until the lock. |
| `supabase/harden.sql` | Locks the API down: nothing is readable signed out, the invite code can't be guessed over the API, and the server sets join dates and save times. Run it last, after the other SQL files. |
| `scripts/update-data.mjs` + `.github/workflows/update-data.yml` | Asks to run every 30 minutes (GitHub drops many scheduled runs), and each run that starts keeps refreshing every 8 minutes while games are on, for up to ~5.5 hours: pulls the NBA schedule and box scores into `data/`, moves each week's lock to the real first tip-off, and runs Autopilot for empty slots after the lock. |

## Setup (about 15 minutes)

1. **Create a Supabase project** (free tier) at supabase.com.
   - SQL Editor → paste `supabase/schema.sql` → Run.
   - Once you've run the other SQL files below, run `supabase/harden.sql` last (and again after any new SQL file).
   - Authentication → Sign In / Providers → Email: turn **off** "Confirm email". Colleagues then join with an email and password and no inbox step (Supabase's built-in mailer only sends a few emails an hour).
   - Project Settings → API: copy the **Project URL** and **anon public** key into `src/config.js` (`supabaseUrl`, `supabaseAnonKey`). Set `commissioner` to the name you want on certificates.
2. **Add two repository secrets** (GitHub → Settings → Secrets and variables → Actions):
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the **service_role** key from the same page. Keep it out of `config.js`: it bypasses all security and is only used by the data job.
3. **Merge to `main`**, then Actions → "Update league data" → **Run workflow** once. It should commit `data/weeks.json`, `players.json`, `totals.json`, `schedule.json` (the Calendar tab), day-by-day lines under `data/days/` and box scores under `data/games/`. After that it runs on its own.
4. **Host it.** The repo is private, and GitHub Pages on a private repo needs a paid plan. Pick one:
   - Make the repo public and turn on Pages (Settings → Pages → Deploy from branch → `main` / root). Nothing in the repo is secret: the anon key is meant to be public, and the service key lives in Actions secrets.
   - Or connect the repo to Netlify. Leave the build command empty and set the publish directory to `/`. It redeploys whenever the data job commits data.
5. **Share the link.** Picks for week 1 lock at the first tip-off on Tuesday, Oct 20.

## The NHL league

Peakhill NHL Survivor runs on the same site at `nhl/`, from the same code (`nhl/index.html` sets `data-sport="nhl"`). The rules are on its Rules tab.

**One account for both leagues.** Both leagues use the same Supabase project, so a Peakhill account signs in to both. The NBA league's tables are in the `public` schema and the NHL league's in the `nhl` schema; the app picks the schema from `dbSchema` in `src/config.js`. Someone already in one league who opens the other only picks a display name. A new account needs either league's invite code (`public.require_invite`), and then it can join both. Removing someone from the NHL league takes them out of hockey only; removing someone from the NBA league deletes their account, so they leave both.

| Piece | What it does |
|---|---|
| `src/config.js` (`NHL`), `src/teams.js` | The four ranked slots (points, plus-minus, save percentage, team wins), the Gloves Off fight bonus, the bars and the calendar (24 weeks, Oct 26 – Apr 11). |
| `src/league.js` | The hockey rules: plus-minus can go negative and a pick who never played ranks last; a goalie counts once he's faced 20 shots; goalies can be used twice in The Wall; Gloves Off scores +5 a fight (2 max) and burns only when he fights; the Gordie Howe hat trick adds +5. |
| `scripts/update-nhl.mjs` | The NHL data job: schedule, box scores, fights (fighting majors from the play-by-play) and rosters from the NHL's public feed (`api-web.nhle.com`) into `nhl/data/` (with the day-by-day lines for the Calendar), then lock sync and Autopilot in the `nhl` schema. The same workflow runs it right after the NBA job, with the same secrets, and both commit together. |
| `supabase/nhl/setup.sql` | The NHL league's whole database (the `nhl` schema) in one file, built from the NBA SQL files by `PHS_SPORT=nhl node scripts/nhl-sql.mjs`. Rebuild it after changing any file in `supabase/` (a test fails if it's stale). It ends with the shared sign-up check. |
| `src/demo-nhl.js` | The NHL demo league (`nhl/?demo`). |

Not in the NHL league yet: the card game (`cards.startWeek` is `Infinity` until its hockey rules are in) and the commissioner's nightly recap. The Calendar tab works as in the NBA league: the job writes `nhl/data/days/<week>.json` (each player's line for each day, in the weekly shape, so `totalsThrough` adds a week back up from its days).

**Setting it up** (in the NBA league's Supabase project):

1. SQL Editor → paste all of `supabase/nhl/setup.sql` → Run.
2. Project Settings → Data API → **Exposed schemas**: add `nhl` (keep `public`) and save.
3. Set the hockey invite code (or later from the NHL Commissioner tab):
   ```sql
   update nhl.league_settings set invite_code = 'YOURCODE' where id;
   ```
4. Open `…/nhl/` signed in with your NBA account, pick your hockey name, then make yourself NHL commissioner:
   ```sql
   insert into nhl.admins (user_id) values ((select id from auth.users where email = 'you@example.com'))
   on conflict do nothing;
   ```
5. Share `…/nhl/?invite=YOURCODE`. NBA members just open `…/nhl/`.

## Commissioner tab
## Commissioner tab

Run `supabase/admin.sql` and then `supabase/upgrade-dub-invite.sql` in the Supabase SQL editor (both are safe to re-run), then make yourself commissioner:

```sql
insert into public.admins (user_id)
select id from public.profiles where display_name = 'Your display name'
on conflict do nothing;
```

Sign out and back in. A **Commissioner** tab appears with:
- **Member list:** everyone's email and when they were last seen.
- **Invite code:** new sign-ups need it (the database rejects them otherwise). Copy an invite link that fills it in, change it, or turn it off. Changing it doesn't affect people who've already joined.
- **This week's check-in:** who has filled 0–4 slots, with a button to copy the emails of people who still need to pick.
- **Burn ledger:** search any player to see who burned him, in which category and when.
- **League-wide stats:** most-burned players, untouched gems, firepower left, playing styles, and the best and worst picks of the season.
- **Best strategy (hindsight):** each final week's perfect three picks, the perfect season plan per category (every player used at most once, the same rule everyone plays under), and how close each person came to it.
- **Commissioner's Decree:** a one-week twist, up to 3 a season. Impose one, or put 2–3 to a league vote. The twists are Prime Time (a category's rank points double), Opposite Day (the lowest total wins a category), Bounty (+5 for the week's top scorer), Mercy Rule, Sudden Death (all 4 bars), Amnesty (no burns), Ceasefire (no cards), Free-for-all (2 cards each) and Pack Day (a bonus pack). Decrees go up, and votes close, at least 24 hours before the lock, and can be cancelled until then. Everyone sees decrees and running vote counts, never who voted for what. Run `supabase/upgrade-decree.sql` once to turn it on. The catalog is `src/decrees.js`; the limits are `decree` in `src/config.js` (keep `perSeason` in step with the SQL).
- **League settings** (run `supabase/upgrade-settings.sql` once):
  - **Announcement:** a banner on every page for everyone, until you take it down (each person can dismiss it).
  - **Survival and card rules:** the four survival bars, bars to clear, hand limit, attack cap, duel stake and heist size. A change takes effect from the week you choose (this week or later). Earlier weeks keep the rules they were played under, and every change is listed publicly on the Rules tab. You can undo a change until its week locks.
  - **Season settings:** lives, drops, decrees a season, the Bounty size and the commissioner name on certificates. These apply to the whole season; raising lives gives everyone more.
  - **Adjustments:** add or take away points or lives for one member in a locked week, with a reason. They're shown publicly on that week's Results.
  - `src/config.js` keeps the defaults. The settings live in `league_config` (members can read it, commissioners write it). `league_settings` is the separate one-row invite-code table from `upgrade-dub-invite.sql`. The app and the data job apply them through `src/settings.js`.
- **Remove member:** deletes the account with its picks and jokers, and by default blocks that email from signing up again. Blocked emails are listed with an **Unblock** button.

The database only answers these requests for accounts in the `admins` table. Before a lock, the check-in shows how many slots each person has filled, never which players.

## Tour and "What's new"

- **First login:** everyone gets a guided tour of the real app (`TOUR` in `src/app.js`). Each step opens a page and spotlights what it describes: the lock countdown, the pick slots, backups, survival bars, Save, Jokers, the Burn Book, Standings and Results tabs, the card dashboard, the Card Dex, Rivals and Rules. On a phone the text sits in a bottom sheet, which moves to the top when the target is low on the screen. Steps list fallback targets, so a missing element (for example, no open week) just shows a centred card. It's replayable from the Rules tab. Members who joined before the tour existed see it on their next visit.
- **Updates:** player-facing changes are listed in `src/updates.js`. Each member sees the entries they haven't read, once, on their next visit. Everyone can reopen them from **What's new** in the footer. Commissioner-only changes aren't listed.
- Run `supabase/upgrade-onboarding.sql` once so this is remembered per account across devices. Without it, it's remembered per browser.
## Joker cards

Packs are dealt from a seeded shuffle, so every browser deals the same three cards and nobody can re-roll. The seed comes from a secret in the database (`pack_seeds()`): you get your own seeds up to the open week and everyone else's once a week locks, so nobody can work out a colleague's hand early. The database only stores which card you kept (`_keep`), duel answers (`_reply`), gifts and plays, all in `card_plays`. The engine rebuilds every hand from that history and ignores a play for a card you don't hold. A forged play shows up at the reveal as "tried to play a card they don't have".

- **Turn cards on:** run `supabase/upgrade-cards.sql` once in the Supabase SQL editor. Until then the app works as before, without cards.
- **For players:** the Cards tab has a short "How cards work" guide (open until you play your first card, linked from Rules), a dashboard, 10 achievements and the Card Dex, where tapping any card shows what it does, when to play it and a tip.
- **When cards start:** `cards.startWeek` in `src/config.js`. Everyone gets a Starter Pack that week (late joiners get theirs in their first week). Hand limit, attack cap, duel stake, heist size and Embargo notice are next to it.
- **What's visible when:** your own rows any time; everyone's at the lock. An Embargo is public immediately, and a duel is visible to the person challenged so they can accept or decline. A played Scout Report can't be taken back.
- **Cards and Dub:** cards that name a slot take a team in Dub. Load Management takes off a win, Garbage Time turns a loss into a win, and Sixth Man and Switcheroo stay in the player slots.
- **Kept cards are final.** In Week 1 only (`cards.swapsThroughWeek`), while people learned the game, each pack allowed one swap of the kept card for one of the other two, until that week's lock, and only while the card is still in your hand (not played, armed or gifted). It's a second `_keep` row with `card_uid` `repick:<pack key>`; the insert policy in `upgrade-cards.sql` enforces the rules. Those swaps still count; the app no longer offers swaps and the insert policy refuses new `repick:` rows.
- **Pack odds:** `standingOdds()` in `src/cards.js`, from `cards.oddsFrom` (Week 3) on. Odds slide with your place in the standings two weeks back (leader → last) and the point in the season, which scales how much your place counts (40% at the start, 100% at the end). Per card drawn: Burn Notice 0.1% → 0.6% (ultra rare: about 1 in 330 packs for the leader, 1 in 52 for last place late in the season), each Rare 20% → 30% between them, Heist and Blue Shell only in the bottom half (up to 16%). Revenge and Album packs have their own fixed odds (Burn Notice 1% and 1.5% a card). Packs before `oddsFrom` keep the old three-tier table, because packs are re-dealt from their seeds and must come out the same.
- **Practice packs:** everyone gets 2 on the Cards tab. They're dealt at random in the browser, never saved and never touch the real seeds.
- **Pack opening** works with a swipe across the top of the pack, the *Rip it open* button, or Enter. Sound is synthesised and off by default (🔇 in the corner). It respects reduced-motion settings. In the demo, practice packs are unlimited.

## Security

The app runs in each person's browser, so anyone can open the browser's developer tools and see the code, the requests it makes and the data that comes back, and copy those requests into a tool like `curl`. That can't be switched off, so nothing relies on hiding it. The database decides what each account may read and write:

- **Signed out:** nothing. The public key in `src/config.js` gets no names, ids, picks or cards on its own (`harden.sql`).
- **Signed in:** your own picks and cards any time; everyone else's picks, packs and card plays once that week locks. Commissioner data (emails, the invite code) only for accounts in `admins`.
- **Writes:** only your own rows, only inside the time windows, and the server sets ids, join dates and save times. Card plays and picks the rules don't allow are scored as invalid and flagged at the reveal.
- **Invite code:** checked only at sign-up, which Supabase rate-limits, so it can't be guessed by brute force.
- **Injected content:** names and card data are escaped wherever they're shown, and the Content-Security-Policy in `index.html` blocks any script that isn't ours.

Account ids (the long codes like `3f2a…`) and NBA player ids aren't secrets. Knowing one doesn't let you do anything as that person.

## Things to know

- **Stats source:** NBA.com's public JSON (`cdn.nba.com`: the season schedule and per-game box scores). It's free and unofficial. Player headshots and team logos also load from there. If NBA.com ever blocks the job, the parser in `scripts/update-data.mjs` is the only place that needs changing.
- **Player pool:** built from box scores, so it fills in from preseason games. A player who hasn't appeared in a box score yet can't be picked until he does.
- **Scoring is computed in the browser** from picks plus `data/totals.json`, using the same engine the tests cover. A tampered pick (for example, an already-burned player) simply scores 0.
- **Changing rules:** bars, lives and drops live in `src/config.js`. The calendar is `buildWeeks()` in the same file.

## Keeping it up

The app is static files on GitHub Pages plus Supabase, and both are very reliable. Most outages come from a bad change, so several checks stand in the way:

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: the engine tests, then `scripts/smoke.mjs`. That opens the app in a real browser and checks that every file parses, the data files are valid JSON, the signed-out page reaches sign-in, and the demo league renders every tab with no script errors or CSP blocks. **Make it required:** Settings → Branches → add a rule for `main` → *Require status checks to pass* → pick **CI / check**. A broken pull request then can't be merged. Run it locally with `npm i --no-save playwright && npx playwright install chromium && npm run smoke`.
- **Uptime monitor** (`.github/workflows/uptime.yml`): every 15 minutes it runs the same smoke test against the live site, retrying once a minute later. If the site is down it opens a **🚨 site-down** issue, and GitHub emails you. It closes the issue when the site recovers.
- **In the app:**
  - If a script fails to load, `src/boot-guard.js` replaces the endless "Loading the league…" with a Reload button within seconds.
  - If Supabase is slow or unreachable, the app shows an error and retries every 30 seconds by itself.
  - Once loaded, a dropped connection keeps the last data on screen and retries in the background.
  - A bug in one page shows "This page hit a snag" on that page only. The other tabs, and saving picks, keep working.
- **No CDN:** the Supabase client is served from this repo (`vendor/`), so a CDN outage can't take the league down. The CSP no longer allows any outside scripts.
- **Supabase free tier** pauses a project after a week with no requests. The data job talks to it many times a day, which keeps it awake, so leave that workflow on.

### Updating the vendored Supabase client

```sh
mkdir /tmp/sb && cd /tmp/sb && npm init -y && npm i @supabase/supabase-js@<version> esbuild
echo "export { createClient } from '@supabase/supabase-js';" > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --target=es2020 --outfile=supabase.mjs
```

Copy it to `vendor/supabase-js-<version>.mjs` and update `SUPABASE_ESM` in `src/backend.js`.
