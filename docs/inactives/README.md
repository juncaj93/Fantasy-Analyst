# Round 27: game-day inactives (research)

Question from Alex: can start/sit know on game day that a player is INACTIVE?
Teams announce inactives about 90 minutes before kickoff. A player listed
Questionable on Friday who is ruled inactive Sunday can still look startable
here until a later download catches it.

Answer: **no new source built.** Measured on 13 November 2026. All times
Eastern. Alex approved one small change the same day: Sunday's one Sleeper
download moves from 11:45 AM to 12:15 PM (see the end).

## Sources

| Source | Shows inactives? | Speed after the announcement | Free | Allowed | Id |
|---|---|---|---|---|---|
| Sleeper player list `/v1/players/nfl` | Yes: `injury_status` turns `Out`, body part `Coach's Decision` for healthy scratches | Sleeper's news stamp on those players lands 20 to 35 min after (see below). Not within 15 min, and the status change itself has no timestamp | Yes | Yes, but Sleeper asks apps to download it **at most once a day** (5 MB) | Sleeper id (ours) |
| nflverse weekly rosters `roster_weekly_2026.csv` | Yes: `status = INA` per player per game | Next morning. The file was stamped Fri 11/13 10:20 AM; Thursday night's inactives first appear there about 15 hours late | Yes | Yes (public release file, storing is allowed) | `gsis_id` and `sleeper_id` on the same row |
| nflverse injury report `injuries_2026.csv` (what the app reads every 5 min) | No. It is the official Friday report and never changes on game day | Never | Yes | Yes | `gsis_id` |
| ESPN, NFL.com game books, team sites | Yes | Fast | Yes | **No**: undocumented or scraping | various |
| Sportradar, SportsDataIO, paid live feeds | Yes | Fast | **No** | n/a | various |

Confirmed from the shell on 13 November: both nflverse files and Sleeper's
player list downloaded and parsed. Not confirmed: nflverse's exact publish
schedule (its docs site does not open from the sandbox), and the exact minute
Sleeper flips a status (it publishes no timestamp for that, only `news_updated`).

### How fast Sleeper was, measured

Sleeper's `news_updated` on the players ruled inactive (Thursday 11/12, WAS at
NYG, 8:15 PM kickoff, inactives about 6:45 PM; Sunday night 11/8, TB at CHI,
8:20 PM kickoff, inactives about 6:50 PM):

| Player | Sleeper now | Sleeper news stamp |
|---|---|---|
| Athan Kaliakmanis (WAS QB) | Out, Coach's Decision | Thu 11/12 7:05 PM |
| Thomas Fidone II (NYG TE) | Out, Coach's Decision | Thu 11/12 7:20 PM |
| Kyle Monangai (CHI RB) | Out, Toe | Sun 11/8 7:15 PM |

So Sleeper does carry game-day inactives, about 20 to 35 minutes after the
announcement. The app just does not ask Sleeper often enough to see them.

## How the app sees it today

- **Injury report (nflverse):** checked every 5 minutes, but the file only
  holds the Friday designation. A Questionable player stays Questionable here
  all weekend. It cannot catch an inactive.
- **Sleeper player list:** downloaded once a day. 4:00 AM Monday to Saturday,
  and on Sunday once at **11:45 AM** (retries at 12:15 and 12:30 PM only if
  11:45 failed). The worse status of the two wins.
- So: 1 PM games are caught only if Sleeper has updated by 11:45 AM, which is
  15 minutes after the 11:30 announcement and earlier than the 20 to 35 minutes
  measured above. 4 PM, Sunday night, Monday night and Thursday games are not
  caught until the next morning's download.

## Last Sunday (11/8) and Thursday (11/12)

Skill players who were Questionable on the final report and then inactive
(nflverse weekly rosters, `INA`):

| Player | Kickoff | When the app could first know |
|---|---|---|
| George Pickens (DAL WR) | Sun 1:00 PM | Sun 11:45 AM, only if Sleeper had flipped him by then; otherwise Mon 4:00 AM |
| Kyle Monangai (CHI RB) | Sun 8:20 PM | Mon 11/9 4:00 AM (Sleeper had it at about 7:15 PM Sunday) |
| MarShawn Lloyd (GB RB) | Sun 4:25 PM | Mon 11/9 4:00 AM |
| Jaylen Wright (MIA RB) | Sun 1:00 PM | Sun 11:45 AM at best |
| Jacob Saylors (DET RB) | Sun 1:00 PM | Sun 11:45 AM at best |
| Luke Schoonmaker (DAL TE) | Sun 1:00 PM | Sun 11:45 AM at best |
| Deshaun Watson (CLE QB) | Sun 1:00 PM | Sun 11:45 AM at best |

Thursday 11/12: none. The three skill players inactive (Colson Yankoff, Thomas
Fidone II, Athan Kaliakmanis) were already Out or not on the report.

Who in Alex's league started them: PENDING the production check
(`scripts/probe-round27.mjs`), which stood down at 2:44 PM because the day was
at 51.2 percent of database reads.

## Why nothing was built

The brief allows a build only if all three hold:

1. **A free, allowed source that updates within 15 minutes.** Fails. Sleeper is
   the only free, allowed source that has game-day inactives, it measured 20 to
   35 minutes, and polling it at 2 h, 1.5 h, 1 h and 0.5 h before every kickoff
   means 10 to 14 downloads of a 5 MB file on a Sunday against Sleeper's
   once-a-day ask. nflverse is allowed but arrives the next morning.
2. **Under 1,000 writes a Sunday.** Would pass (see below).
3. **No schema change.** Would pass: an inactive could be written into the
   existing `player_injury_reports` rows as `Out`, which the shared
   `weekAvailability` rule already reads.

## Write estimate per game day

- Sleeper list, extra download: it writes only players whose row changed. On a
  game day that is the inactives in that window plus ordinary news, roughly 50
  to 150 players. With the table's indexes, about 200 to 600 rows written each.
  Three extra Sunday downloads would land near or over 1,000.
- nflverse weekly rosters: about 60 skill-position inactives a week, so about
  60 to 70 rows on a Sunday. Cheap, but too late to matter, and the 8 MB file
  is too big to parse inside one free-plan Worker run.

## What it would take, and what was done

- **Done (Alex approved, 13 November):** Sunday's one Sleeper download moves
  from 11:45 AM to 12:15 PM, retries at 12:30 and 12:45 PM only if the one
  before failed. Still one download per Eastern day; every other day is
  unchanged. It gives Sleeper 45 minutes after the 1 PM inactives and is still
  before the 1 PM lock. A player Sleeper marks `Out` (including "Coach's
  Decision") already reaches start/sit as Out through the existing injury
  data: the newer, worse status beats Friday's Questionable, and the shared
  `weekAvailability` rule zeroes him. No shared function was edited.
  Files: `core/sleeper/playerListClock.ts`, the worker comment, and tests
  `playerListClock.test.ts`, `playerListClock.worker.test.ts`,
  `inactives.round27.test.ts` (inactive, active, source missing, stale).
- **Not done, by decision:** later games (Sunday 4 PM, Sunday night, Monday,
  Thursday). Covering them needs three or four more Sleeper downloads a week,
  past Sleeper's once-a-day ask.
- **Paid feed:** ruled out ($0 only).
