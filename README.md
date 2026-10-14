# Peakhill NBA Survivor

A free, season-long NBA player-survivor league for the office. Every week you pick a scorer (**Bucket**), a rebounder (**Glass**) and a passer (**Dime**). Each pick scores his weekly total. Once you use a player in a category, he's burned in that category for the season. You score 1 point for every colleague your pick beats, keep 3 lives on the survivor ladder, and play two Jokers plus a deck of collectible Joker cards (jinxes, traps, duels, heists, Blue Shells and pranks) that you pull from packs. Champions get a downloadable certificate. Rules and design notes are in [CONCEPT.md](CONCEPT.md).

**Try it now:** serve the folder and open `/?demo`. You'll get a made-up league frozen in early December, with week 6 live and week 7 open for picks.

```
npm run serve     # http://localhost:8080/?demo
npm test          # league engine + data pipeline tests
```

## How it fits together

| Piece | What it does |
|---|---|
| `index.html`, `styles.css`, `src/app.js` | The app. Static files, no build step. |
| `src/league.js` | The rules engine: burns, backups, rank scoring, card effects, lives, drops, Monthly Crowns, awards, head-to-head, Autopilot. Shared by the app and the data script. |
| `src/cards.js` | The Joker card deck, pack odds, seeded pack dealing, and the hand/trap/attack bookkeeping the engine uses. |
| `src/pack.js` | Card faces, foil packs and the pack-opening animation (swipe to tear, rarity tell, walkout, flip, keep one and burn the rest). |
| `src/config.js` | League settings: name, commissioner, bars, calendar, Supabase keys. |
| `supabase/schema.sql` | Accounts, picks, jokers and card plays, with row-level security. You can only write your own picks, only before the lock, and nobody can see anyone else's picks or cards until the lock. |
| `scripts/update-data.mjs` + `.github/workflows/update-data.yml` | Hourly on game nights: pulls the NBA schedule and box scores into `data/`, moves each week's lock to the real first tip-off, and runs Autopilot for empty slots after the lock. |

## Setup (about 15 minutes)

1. **Create a Supabase project** (free tier) at supabase.com.
   - SQL Editor → paste `supabase/schema.sql` → Run.
   - Authentication → Sign In / Providers → Email: turn **off** "Confirm email". Colleagues then join with an email and password and no inbox step (Supabase's built-in mailer only sends a few emails an hour).
   - Project Settings → API: copy the **Project URL** and **anon public** key into `src/config.js` (`supabaseUrl`, `supabaseAnonKey`). Set `commissioner` to the name you want on certificates.
2. **Add two repository secrets** (GitHub → Settings → Secrets and variables → Actions):
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the **service_role** key from the same page. Keep it out of `config.js`: it bypasses all security and is only used by the hourly job.
3. **Merge to `main`**, then Actions → "Update NBA data" → **Run workflow** once. It should commit `data/weeks.json`, `players.json`, `totals.json` and box scores under `data/games/`. After that it runs hourly on its own.
4. **Host it.** The repo is private, and GitHub Pages on a private repo needs a paid plan. Pick one:
   - Make the repo public and turn on Pages (Settings → Pages → Deploy from branch → `main` / root). Nothing in the repo is secret: the anon key is meant to be public, and the service key lives in Actions secrets.
   - Or connect the repo to Netlify. Leave the build command empty and set the publish directory to `/`. It redeploys whenever the hourly job commits data.
5. **Share the link.** Picks for week 1 lock at the first tip-off on Tuesday, Oct 20.

## Commissioner tab

Run `supabase/admin.sql` in the Supabase SQL editor (it's safe to re-run after updates), then make yourself commissioner:

```sql
insert into public.admins (user_id)
select id from public.profiles where display_name = 'Your display name'
on conflict do nothing;
```

Sign out and back in. A **Commissioner** tab appears with:
- **Member list:** everyone's email and when they were last seen.
- **This week's check-in:** who has filled 0–3 slots, with a button to copy the emails of people who still need to pick.
- **Burn ledger:** search any player to see who burned him, in which category and when.
- **League-wide stats:** most-burned players, untouched gems, firepower left, playing styles, and the best and worst picks of the season.
- **Best strategy (hindsight):** each final week's perfect three picks, the perfect season plan per category (every player used at most once, the same rule everyone plays under), and how close each person came to it.
- **Remove member:** deletes the account with its picks and jokers, and by default blocks that email from signing up again. Blocked emails are listed with an **Unblock** button.

The database only answers these requests for accounts in the `admins` table. Before a lock, the check-in shows how many slots each person has filled, never which players.

## Joker cards

Packs are dealt in the browser from a seeded shuffle of (season, person, pack), so every browser deals the same three cards and nobody can re-roll. The database only stores which card you kept (`_keep`), duel answers (`_reply`), gifts and plays, all in `card_plays`. The engine rebuilds every hand from that history and ignores a play for a card you don't hold. A forged play shows up at the reveal as "tried to play a card they don't have".

- **Already running the league?** Re-run `supabase/schema.sql` to add the `card_plays` table and the `scout_report` function. Until then the app works as before, without cards.
- **When cards start:** `cards.startWeek` in `src/config.js`. Everyone gets a Starter Pack that week (late joiners get theirs in their first week). Hand limit, attack cap, duel stake, heist size and Embargo notice are next to it.
- **What's visible when:** your own rows any time; everyone's at the lock. An Embargo and kept cards are public immediately, and a duel is visible to the person challenged so they can accept or decline.
- **Pack opening** works with a swipe across the top of the pack, the *Rip it open* button, or Enter. Sound is synthesised and off by default (🔇 in the corner). It respects reduced-motion settings. In the demo, *Rip a practice pack* on the Cards tab opens as many as you like without saving.

## Things to know

- **Stats source:** NBA.com's public JSON (`cdn.nba.com`: the season schedule and per-game box scores). It's free and unofficial. Player headshots and team logos also load from there. If NBA.com ever blocks the hourly job, the parser in `scripts/update-data.mjs` is the only place that needs changing.
- **Player pool:** built from box scores, so it fills in from preseason games. A player who hasn't appeared in a box score yet can't be picked until he does.
- **Scoring is computed in the browser** from picks plus `data/totals.json`, using the same engine the tests cover. A tampered pick (for example, an already-burned player) simply scores 0.
- **Changing rules:** bars, lives and drops live in `src/config.js`. The calendar is `buildWeeks()` in the same file.
