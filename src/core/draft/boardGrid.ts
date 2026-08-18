/**
 * The draft board as a board: rounds down, managers across.
 *
 * This is a pure view transformation and nothing else. It computes no score,
 * reads no ADP, runs no simulation and asks nothing of Sleeper — it takes the
 * draft state the board response already carries and arranges it into the grid
 * a fantasy drafter recognises, so that "who is hoarding running backs" and
 * "where did the receiver run start" are answered by looking rather than by
 * counting.
 *
 * Two facts drive everything here, and both are easy to get subtly wrong:
 *
 * **The snake is a fact about pick numbers, not about columns.** A manager's
 * column must be the same column in every round — that is the whole reason a
 * board is a board, because a roster reads vertically. So the columns are draft
 * slots, fixed, and the snake shows up as the pick *numbers* running left to
 * right in odd rounds and right to left in even ones. Reordering the columns
 * every other round to make the numbers ascend would destroy the only thing the
 * layout is for.
 *
 * **Ownership is Sleeper's to state, not ours to assume.** A pick that has been
 * made belongs to the manager Sleeper says made it. A pick that has not been
 * made belongs to whoever the ownership model says owns it — which is the seat,
 * unless the league published a trade. Neither is inferred from the other, and
 * this module invents no third answer: it is handed the resolved owner for
 * completed picks and an owner lookup for future ones, both produced by the
 * existing `nextpick/ownership.ts` model that the rest of the draft already
 * uses.
 */

/*
 * The snake itself is not redefined here.
 *
 * `slotAtPick` already answers "whose seat is pick 27" for the `Next` model,
 * the demand estimate and the horizon, and a board that computed it a second
 * time would be a second place for the answer to drift. This module imports it
 * and adds only the arrangement.
 */
import { slotAtPick } from './nextpick/ownership.ts';

/** A column: one drafting manager, in a fixed seat. */
export interface BoardManager {
  /** 1-based draft slot. Stable for the whole draft; the column never moves. */
  slot: number;
  /** Sleeper's display name for the manager, or a `Team 4` fallback. */
  name: string;
  /** The reader's own seat, which the board emphasises quietly. */
  isMine: boolean;
}

/** One completed pick, as the board needs it. Nothing about ranking travels here. */
export interface BoardPick {
  pickNo: number;
  playerId: string;
  name: string;
  position: string;
  team: string;
  /**
   * The manager who actually made it, as Sleeper reports.
   *
   * Resolved upstream from `slot_to_roster_id` and the pick's roster, falling
   * back to the seat it sits in. It is authoritative: if it disagrees with what
   * the snake would have predicted, the pick was traded and Sleeper is right.
   */
  ownerSlot: number;
}

/** The player in a cell, once his name has been shortened for the space. */
export interface BoardCellPlayer {
  playerId: string;
  /** The full name, which is what a screen reader is given. */
  name: string;
  /** `J. Hurts` — see {@link shortPlayerNames}. */
  shortName: string;
  position: string;
  team: string;
}

/** One selection: a pick number, whose it is, and who was taken with it. */
export interface BoardEntry {
  pickNo: number;
  round: number;
  /** `6.04` — the round and the position within it, in the usual convention. */
  label: string;
  /** The column this entry is drawn in: the manager who owns the pick. */
  slot: number;
  /** The seat the pick number belongs to. Differs from `slot` only after a trade. */
  seatSlot: number;
  traded: boolean;
  player: BoardCellPlayer | null;
  state: 'done' | 'current' | 'future';
  /** The most recent completed pick in the whole draft. At most one is true. */
  latest: boolean;
}

/**
 * One cell of the grid.
 *
 * Almost always exactly one entry. A manager who traded a round away has none —
 * drawn quiet and empty rather than filled with an apology — and a manager who
 * traded one *in* has two, which stack. Modelling the cell as a list is what
 * keeps those two cases from being special cases.
 */
export interface BoardCell {
  round: number;
  slot: number;
  entries: BoardEntry[];
}

export interface BoardRow {
  round: number;
  cells: BoardCell[];
}

/** How a manager's roster is shaping up: `2 RB · 3 WR · 1 TE`. */
export interface BoardComposition {
  slot: number;
  counts: { position: string; count: number }[];
}

export interface DraftBoardGrid {
  managers: BoardManager[];
  rows: BoardRow[];
  /** Where the pick on the clock sits, or null once the draft is finished. */
  current: { round: number; slot: number; pickNo: number } | null;
  /** Where the last completed pick sits, or null before anybody has picked. */
  latest: { round: number; slot: number; pickNo: number } | null;
  composition: BoardComposition[];
}

export interface BoardGridInput {
  teams: number;
  rounds: number;
  /** `snake` unless the draft is linear. Only the snake reverses even rounds. */
  type: string;
  managers: BoardManager[];
  picks: BoardPick[];
  /** The pick on the clock. Anything past the last pick means nothing is. */
  currentPick: number;
  /**
   * Owner slot per pick number, indexed from pick 1, when the draft has trades.
   *
   * Absent in the overwhelmingly common case, where the seat owns its own picks
   * and the snake answers it. Supplied by the server only when Sleeper actually
   * published a trade, so this module never has to guess which of two models is
   * in force.
   */
  pickOwners?: (number | null)[] | null;
  /** True when the draft is over: no pick is on the clock, whatever the count. */
  complete?: boolean;
}

/** `6.04`: the round, and which pick of that round it is. */
export function pickLabel(pickNo: number, teams: number): string {
  if (teams < 1 || pickNo < 1) return '';
  const round = Math.ceil(pickNo / teams);
  const inRound = ((pickNo - 1) % teams) + 1;
  return `${round}.${String(inRound).padStart(2, '0')}`;
}

/**
 * The board, as rounds of cells.
 *
 * Every pick in the draft gets exactly one entry, placed in the column of the
 * manager who owns it. Completed picks are placed by what Sleeper reported;
 * future picks by the ownership map, or by the seat when there is none.
 */
export function buildDraftBoardGrid(input: BoardGridInput): DraftBoardGrid {
  const teams = Math.max(1, Math.floor(input.teams));
  const rounds = Math.max(1, Math.floor(input.rounds));
  const total = teams * rounds;
  const managers = normalizeManagers(input.managers, teams);
  const slots = new Set(managers.map((m) => m.slot));

  const done = new Map<number, BoardPick>();
  for (const pick of input.picks) {
    if (pick.pickNo < 1 || pick.pickNo > total) continue;
    done.set(pick.pickNo, pick);
  }
  const shortNames = shortPlayerNames([...done.values()]);

  /*
   * Who each pick belongs to.
   *
   * The seat first, then the published ownership map where there is one, then
   * — last and strongest — what actually happened. A pick that has been made
   * carries its own owner, and no model gets to overrule an event.
   */
  const ownerOf = (pickNo: number): number => {
    const made = done.get(pickNo);
    if (made && slots.has(made.ownerSlot)) return made.ownerSlot;
    const declared = input.pickOwners?.[pickNo - 1];
    if (declared != null && slots.has(declared)) return declared;
    return slotAtPick(pickNo, teams, input.type);
  };

  const latestPickNo = done.size === 0 ? null : Math.max(...done.keys());
  /*
   * The pick on the clock, or nothing.
   *
   * A finished draft has no cell to outline, and neither does a `currentPick`
   * past the end of the board — which is the same state arriving by counting
   * rather than by status. Both are the absence of a current cell, and the board
   * must not draw one in either.
   */
  const currentPickNo =
    input.complete === true || input.currentPick < 1 || input.currentPick > total ? null : input.currentPick;

  const cells = new Map<string, BoardCell>();
  for (const manager of managers) {
    for (let round = 1; round <= rounds; round++) {
      cells.set(`${round}:${manager.slot}`, { round, slot: manager.slot, entries: [] });
    }
  }

  for (let pickNo = 1; pickNo <= total; pickNo++) {
    const round = Math.ceil(pickNo / teams);
    const seatSlot = slotAtPick(pickNo, teams, input.type);
    const slot = ownerOf(pickNo);
    const cell = cells.get(`${round}:${slot}`);
    if (!cell) continue;
    const made = done.get(pickNo);
    cell.entries.push({
      pickNo,
      round,
      label: pickLabel(pickNo, teams),
      slot,
      seatSlot,
      traded: slot !== seatSlot,
      player: made
        ? {
            playerId: made.playerId,
            name: made.name,
            shortName: shortNames.get(made.playerId) ?? made.name,
            position: (made.position ?? '').toUpperCase(),
            team: made.team,
          }
        : null,
      /*
       * Done, on the clock, or still to come.
       *
       * A pick with a player on it is done whatever the counter says: a board
       * that showed a drafted player in a cell marked "future" would be calling
       * Sleeper a liar about something Sleeper alone knows.
       */
      state: made ? 'done' : pickNo === currentPickNo ? 'current' : 'future',
      latest: made != null && pickNo === latestPickNo,
    });
  }

  const rows: BoardRow[] = [];
  for (let round = 1; round <= rounds; round++) {
    rows.push({
      round,
      cells: managers.map((m) => cells.get(`${round}:${m.slot}`) ?? { round, slot: m.slot, entries: [] }),
    });
  }

  const locate = (pickNo: number | null) => {
    if (pickNo == null) return null;
    const slot = ownerOf(pickNo);
    return { round: Math.ceil(pickNo / teams), slot, pickNo };
  };

  return {
    managers,
    rows,
    current: locate(currentPickNo),
    latest: locate(latestPickNo),
    composition: compositionBySlot(managers, done, ownerOf),
  };
}

/** One column per seat, named, with anything missing filled in as `Team 4`. */
function normalizeManagers(managers: BoardManager[], teams: number): BoardManager[] {
  const bySlot = new Map<number, BoardManager>();
  for (const manager of managers) {
    if (manager.slot < 1 || manager.slot > teams) continue;
    if (!bySlot.has(manager.slot)) bySlot.set(manager.slot, manager);
  }
  return Array.from({ length: teams }, (_, i) => {
    const slot = i + 1;
    const found = bySlot.get(slot);
    return {
      slot,
      name: found?.name?.trim() || `Team ${slot}`,
      isMine: found?.isMine === true,
    };
  });
}

/** `2 RB · 3 WR · 1 TE`, per manager, in the order the positions were taken. */
function compositionBySlot(
  managers: BoardManager[],
  done: Map<number, BoardPick>,
  ownerOf: (pickNo: number) => number,
): BoardComposition[] {
  const counts = new Map<number, Map<string, number>>();
  for (const manager of managers) counts.set(manager.slot, new Map());
  for (const [pickNo, pick] of [...done.entries()].sort((a, b) => a[0] - b[0])) {
    const slot = ownerOf(pickNo);
    const forSlot = counts.get(slot);
    if (!forSlot) continue;
    const position = (pick.position ?? '').toUpperCase();
    if (!position) continue;
    forSlot.set(position, (forSlot.get(position) ?? 0) + 1);
  }
  return managers.map((manager) => ({
    slot: manager.slot,
    counts: [...(counts.get(manager.slot) ?? new Map<string, number>())].map(([position, count]) => ({
      position,
      count,
    })),
  }));
}

/**
 * Suffixes that belong to the surname rather than ending it.
 *
 * `Marvin Harrison Jr.` is not a man called Marvin whose surname is `Jr.`, and
 * a board that printed `M. Jr.` would be useless in exactly the round where
 * two Harrisons are on the screen at once.
 */
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v']);

/**
 * Everything after the first token: `St. Brown`, `Harrison Jr.`, `McCaffrey`.
 *
 * The rule is deliberately structural rather than a list of particles. Sleeper
 * gives a first name and a last name and this app joins them, so a name's first
 * token is the given name and the rest is what identifies him — which handles
 * `Amon-Ra St. Brown`, `Michael Pittman Jr.` and `Marquise Brown` with one rule
 * and no dictionary to keep up to date.
 */
function surnameOf(tokens: string[]): string {
  return tokens.slice(1).join(' ');
}

/**
 * `J. Hurts`, from `Jalen Hurts`.
 *
 * Defences are named for their club rather than initialled: `Chicago Bears`
 * becomes `Bears`, because `C. Bears` reads as a person and no drafter thinks
 * of a defence that way. A single-token name is left whole — there is no first
 * name to reduce.
 */
export function shortPlayerName(name: string, position?: string | null, prefix = 1): string {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  if ((position ?? '').toUpperCase() === 'DEF') return tokens[tokens.length - 1]!;
  if (tokens.length === 1) return tokens[0]!;

  const first = tokens[0]!;
  const surname = surnameOf(tokens);
  // A name that is nothing but a suffix after the first token has no surname to
  // print, so the first name is the identifying part and stays whole.
  if (surname.split(/\s+/).every((t) => NAME_SUFFIXES.has(t.toLowerCase()))) return name.trim();

  const initials = first.slice(0, Math.max(1, Math.min(prefix, first.length)));
  // Once the prefix has eaten the whole first name there is no abbreviation
  // left to make, and the full name is the honest thing to print.
  return initials.length >= first.length ? `${first} ${surname}` : `${initials}. ${surname}`;
}

/**
 * Short names for a set of drafted players, lengthened only where they collide.
 *
 * Two receivers called `M. Brown` on the same board is worse than no
 * abbreviation at all, so a collision grows the initial one character at a time
 * — `Ma. Brown` and `Mar. Brown` — and stops the moment the group is
 * distinguishable. Everybody else keeps a single initial, which is the point.
 *
 * Deterministic by construction: the answer depends only on the set of names,
 * never on their order or on which of them was drafted first.
 */
export function shortPlayerNames(picks: { playerId: string; name: string; position: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const longest = picks.reduce((max, p) => Math.max(max, (p.name ?? '').trim().split(/\s+/)[0]?.length ?? 0), 1);

  let remaining = picks;
  for (let prefix = 1; prefix <= Math.max(1, longest) && remaining.length > 0; prefix++) {
    const groups = new Map<string, typeof remaining>();
    for (const pick of remaining) {
      const short = shortPlayerName(pick.name, pick.position, prefix);
      const group = groups.get(short);
      if (group) group.push(pick);
      else groups.set(short, [pick]);
    }
    const stillColliding: typeof remaining = [];
    for (const [short, group] of groups) {
      // A group of one is settled at this length. A group of several is not,
      // unless nothing longer would separate them — two players with the same
      // name are the same two players however much of it is printed.
      if (group.length === 1 || group.every((p) => p.name === group[0]!.name)) {
        for (const pick of group) out.set(pick.playerId, short);
      } else {
        stillColliding.push(...group);
      }
    }
    remaining = stillColliding;
  }
  // Anything that survived every length is genuinely indistinguishable; print
  // the fullest form rather than an initial that claims a difference.
  for (const pick of remaining) out.set(pick.playerId, pick.name.trim());
  return out;
}

/** `2 RB · 3 WR · 1 TE`, or an empty string for a manager with nothing yet. */
export function compositionLine(composition: BoardComposition | undefined): string {
  if (!composition || composition.counts.length === 0) return '';
  return composition.counts.map((c) => `${c.count} ${c.position}`).join(' · ');
}
