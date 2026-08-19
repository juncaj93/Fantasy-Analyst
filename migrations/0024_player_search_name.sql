-- The spaceless form of a player's lookup key, so search recall can see what
-- the matcher can match.
--
-- `core/search/players.ts` accepts a query word that matches the name with its
-- spaces squeezed out: `amonra` finds `amon ra st brown`, `stbrown` finds `st
-- brown`. That tier exists because dropping a hyphen is the single most common
-- thing somebody does to a hyphenated name, and it works everywhere the whole
-- player list is already in memory -- the draft board, for instance.
--
-- It did not work on the screens that search through the *server*. Players and
-- the Team comparison picker both go to `/api/players?q=`, and the database can
-- only recall candidates it can index for. `normalized_name` holds `amon ra st
-- brown`, so `LIKE '%amonra%'` finds nothing, the row is never handed to the
-- matcher, and the same query that works on Draft returns "nobody matching" two
-- screens away. One matcher, two answers, which is the failure this whole
-- workstream is about.
--
-- Generated rather than written, so it cannot drift from the column it is
-- derived from and needs nothing in the upsert path. VIRTUAL rather than
-- STORED, because SQLite refuses to add a STORED generated column to a table
-- that already has rows -- see migration 0020, which learned that the
-- expensive way. An index over a VIRTUAL column materialises the value inside
-- the index, so the lookup is a plain B-tree search and only a write pays for
-- the REPLACE.
--
-- Nothing about scoring, ranking or any football output changes. This decides
-- only which candidates the matcher is allowed to see.

ALTER TABLE players
  ADD COLUMN search_name TEXT
  GENERATED ALWAYS AS (REPLACE(normalized_name, ' ', '')) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_players_search_name ON players (search_name);
