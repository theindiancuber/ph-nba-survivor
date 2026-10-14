# The Burn: NBA player survivor (concept v0.1)

Working title. A free, season-long NBA league for the office. Each week you pick three players: one for **points**, one for **rebounds**, one for **assists**. Every player you use is burned for the rest of the season. You're ranked against everyone else in the league, not against one opponent.

It's meant to take about five minutes a week, with no draft, no roster, no waiver wire and no money. Missing a week or joining late shouldn't knock anyone out.

---

## 1. What's already out there (and what we borrow)

| Game | How it works | What we take |
|---|---|---|
| **Splash Sports NBA Player Survivor** (paid) | Pick a player each day who must clear a stat bar (e.g. 20+ points). Each player can be used once per contest. Run out of options and you're out. | The burn rule and the idea of stat bars. |
| **MLB Beat the Streak** (free) | Pick a batter to get a hit and build a streak. Picks lock 5 minutes before first pitch. "Double Down" lets you pick two batters in one day. | A free, low-effort daily habit, a one-off power-up, and a lock tied to tip-off. |
| **Golf One-and-Done** | One golfer per tournament, never reused all season. Points follow prize money. A bad pick never eliminates you. You name an **alternate** who's subbed in if your pick withdraws. | A points table where nobody is eliminated, plus the alternate pick for injuries. |
| **NFL Survivor / office pools** | Pick one team a week and never reuse it. Commissioners add **multiple lives**, **mulligans** and **auto-picks**. | Lives, a one-time comeback, and auto-pick for people who forget. |

Nobody seems to combine all of this into a free game for coworkers: a burn list across three stat categories, ranking against the whole league every week, and a separate survivor title for the people who like elimination.

---

## 2. Core rules (v1)

**The week.** Weeks run Monday to Sunday, NBA fantasy style. Picks lock at the first tip-off on Monday, so you can make them over Monday morning coffee.

**The picks.** You fill three slots each week:

| Slot | Stat |
|---|---|
| 🏀 Bucket | Points |
| 🧱 Glass | Rebounds |
| 🎯 Dime | Assists |

**The burn.** A player you've used in *any* slot is gone for you for the season. Jokić can be your rebounds pick or your assists pick, never both. Other people's picks don't affect yours, so ten people can all take Shai in week 1.

**What a pick scores.** Each pick scores its player's **best single game of the week** in that stat. Picking someone with a four-game week gives you more chances, which adds a little strategy, but one big night is enough. You don't have to check box scores every day.

**Alternates.** Each slot gets an optional backup. If your main pick plays **zero** games that week, the backup scores instead and is burned in his place. Your main pick stays available. If neither one plays, the slot scores 0 and both players stay unburned.

---

## 3. Scoring: you vs. everyone

Rebounds and assists run much lower than points (a big night is about 15 boards against about 40 points), so raw numbers can't simply be added together. Instead, each category is ranked across the league every week:

> **In each category, you score 1 point for every colleague whose pick you beat** (½ for a tie).

With 30 players, the top Bucket pick earns 29, the median earns about 15 and the last earns 0. Your weekly score is the sum of your three categories. The season standings add up your weekly scores.

Why ranking works here:
- It's "go against everyone" in the most literal sense.
- Every category is worth the same.
- As the season goes on, everyone runs low on stars together. In week 20, a 9-assist game might win the Dime category, so late picks still matter.

**Drop your 3 worst weeks.** Only your best (total weeks − 3) count toward the season title. Vacations, a forgotten Monday or a late start won't sink anyone.

---

## 4. Survivor track: the lives ladder

The same picks also count toward a second title, with no extra work.

- Everyone starts with **3 lives** ❤️❤️❤️.
- Each week the **bars** are **30 points / 12 rebounds / 10 assists** (best single game). These numbers are a starting guess and need tuning against last season's data.
- **Clear at least 2 of the 3 bars** to survive the week. Otherwise you lose a life.
- The last person with a life left wins the **Survivor Belt**. If the final players all go out in the same week, the one with the higher season points wins.

Early in the season almost everyone clears the bars with stars. By February your remaining assist options are thin, and that's when the ladder gets interesting. Players who lose all their lives **stay in the points table**, so no one stops playing.

---

## 5. Low-touch design (so more people join)

- **Autopilot.** Miss the deadline, or switch Autopilot on, and the app picks for you: the highest season-average player you haven't burned in each slot. You never score a zero, but autopilot spends your stars early, which is a fair cost for not picking.
- **One reminder** goes out on Monday morning (email, Slack or Teams) with a link straight to the pick screen. That's the only notification.
- **Any time zone.** The lock is shown in local time.
- **Late joiners** start with three lives and play under the drop-3-weeks rule. Monthly titles (below) give them something to win right away.

---

## 6. The fun layer (optional, pick and choose)

- **Lock reveal.** When picks lock, everyone's picks become visible with ownership %. "14 of 22 took Jokić for Glass" is good office banter.
- **Weekly awards**, generated automatically:
  - 🧠 **Galaxy Brain**: best result from the least-picked player.
  - 🪦 **The Fumble**: a pick who scored 0 (DNP, rest day, ejection).
  - 🧊 **Ice Cold**: the lowest weekly score.
  - 🐐 **Chalk Merchant**: picked the most popular player in all three slots.
- **Two jokers a season** (borrowed from BTS's Double Down and NFL mulligans):
  - **Double Down**: one slot earns double rank points this week.
  - **Un-burn**: get one burned player back, once.
- **Monthly crowns** for Nov, Dec, Jan, Feb, Mar/Apr, so there's always a race that's still open.
- **Rivals.** Name one coworker as your rival and see your weekly head-to-head record next to the standings.
- **Playoff Burn** (April to June): a separate mini-game with a fresh burn list. One pick per category per round, burned until the Finals.

---

## 7. 2026–27 calendar

The regular season runs from **Tue Oct 20, 2026** to **Sun Apr 11, 2027**. Notable dates: NBA Cup group play starts Oct 30, the Cup final is Dec 11, the trade deadline is Feb 11, and All-Star Weekend is Feb 19–21.

| Week | Dates | Note |
|---|---|---|
| 1 | Tue Oct 20 – Sun Nov 1 | Opening "double week" so people have time to sign up |
| 2–16 | Mon Nov 2 – Sun Feb 14 | Regular weeks |
| 17 | Mon Feb 15 – Sun Feb 28 | All-Star week is light, so it's merged with the next week into a double week |
| 18–23 | Mon Mar 1 – Sun Apr 11 | Stretch run, with tanking and resting stars to watch for |

That's **23 weeks × 3 = 69 burns per person**, which uses up most real stars. Your 50th-best rebounder is a real question by March, and that's the intended endgame.

---

## 8. Open decisions (let's settle these together)

1. **Best game vs. weekly total vs. per-game average.** Best game is the simplest and the most forgiving. A weekly total rewards picking teams with four-game weeks (more strategy, more homework). An average ignores how many games a team plays.
2. **Burn scope.** Should a burn cover every slot (current plan, harder) or one slot (Jokić usable once *per category*, gentler, with 3× the player pool)?
3. **A fourth rotating slot?** For example, a weekly "Wildcard" stat such as threes, steals + blocks or turnovers (fewest wins).
4. **Survivor bars:** fixed all season, or rising each month?
5. **Name.** The Burn / Burn Book / One & Done Hoops / Survivor: Hardwood / something office-specific.
6. **Prizes without money.** A trophy, a parking spot, losers bring donuts, the Belt holder picks the team lunch.

---

## 9. Build plan

The season starts in less than a week, so this is split into two phases:

**Phase 0: launch week 1 by hand (now)**
- A Google Form takes name + 3 picks + 3 alternates, and timestamps enforce the lock.
- Score week 1 in a sheet.

**Phase 1: the app (weeks 2–3)**
- A single static page (same approach as `dynasty-draft`: one `index.html`, no build step) for picks, burn list, standings, lives and lock reveal.
- **Shared storage** for picks and users: a free hosted database (Supabase/Firebase) or a shared-state artifact.
- A **scoring job** that runs on a schedule (e.g. GitHub Actions nightly), pulls box scores, computes each player's best game per stat, and writes standings JSON.
  - Data source options: NBA's public CDN JSON (schedule + box scores, free, unofficial), ESPN's public scoreboard/summary JSON (free, unofficial), `nba_api` (wraps stats.nba.com, often blocks cloud IPs), or BALLDONTLIE (stats endpoints appear to need a paid tier). These still need testing.
- Player pool: every active player, searchable, with season averages shown in the picker so casual players can choose without leaving the app.

**Phase 2: the fun layer**: awards, jokers, rivals, monthly crowns, Playoff Burn.

---

### Sources
- [NBA Survivor explained, Splash Sports](https://splashsports.com/blog/nba-survivor-explained)
- [Beat the Streak official rules, MLB](https://www.mlb.com/mlb-play/official-rules/beat-the-streak) · [BTS FAQ](https://www.mlb.com/apps/beat-the-streak/frequently-asked-questions)
- [One-and-Done fantasy golf rules & strategy, Golf News Net](https://thegolfnewsnet.com/ryan_ballengee/2026/01/12/one-and-done-fantasy-golf-rules-strategy-108088/) · [Golf One-and-Done strategy, RotoGrinders](https://rotogrinders.com/fantasy/golf-one-and-done-strategy)
- [NFL Survivor pool rules, OfficePoolStop](https://officepoolstop.com/rules/survivor)
- [2026–27 NBA key dates, NBC](https://www.nbclosangeles.com/nba/nba-key-dates-2026-27-opening-night-trade-deadline-finals/3927794/) · [Opening night schedule, Fox Sports](https://www.foxsports.com/stories/nba/when-does-2026-27-nba-season-start-opening-night-schedule)
- [Best NBA APIs in 2026, Highlightly](https://highlightly.net/blogs/best-nba-apis-in-2026)
