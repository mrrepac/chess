import type { PieceSymbol, Square } from "chess.js";

export type PlayerColor = "w" | "b";
export type PlayerColorChoice = PlayerColor | "random";
export type BoardOrientation = "player" | "white" | "black";

/** 1 = should lose to a beginner, 10 = plays every game near its best. */
export type Difficulty = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Result from the person's point of view; null while the game is still live. */
export type GameOutcome = "win" | "loss" | "draw";

/** Finished games at one difficulty level, from the person's point of view. */
export interface LevelRecord {
  wins: number;
  losses: number;
  draws: number;
}

/** Keyed by level. A level nobody has played is absent rather than zeroed. */
export type LevelStats = Partial<Record<Difficulty, LevelRecord>>;

/**
 * The tally entry a finished game has already contributed, recorded on the game
 * itself for the same reason `AppliedResult` is: reopening the vault must not
 * count the same game twice, and undoing back into a live position takes it
 * back out again.
 */
export interface RecordedResult {
  /** The level the game was played at. 0 marks a game that belongs to no
   *  bucket — it was already over when the save was written. */
  level: number;
  outcome: GameOutcome;
}

/**
 * What adaptive difficulty did with a finished game's result, recorded on the
 * game itself so that (a) reopening the vault does not count the same result
 * twice, and (b) undoing back into a live position takes it all back.
 * `from === to` means the streak had not reached the threshold yet — the result
 * was counted, but the level did not move.
 */
export interface AppliedResult {
  from: number;
  to: number;
  /** Streak before this game, so undo can restore it exactly. */
  streakBefore: number;
  /** A manual level choice made after this result owns the current level and
   *  streak. Undo may still reopen the game, but must not overwrite that newer
   *  choice with this result's old state. */
  superseded?: boolean;
}

export interface SavedGame {
  fen: string;
  /** SAN history from the initial position, used to restore undo and last-move state. */
  sanHistory: string[];
  playerColor: PlayerColor;
  /** Bot level fixed when this game began. */
  difficulty?: Difficulty;
  /** Optional for compatibility with saves created before resignation was persisted. */
  resigned?: boolean;
  /** Time control this game was started with; 0 means the game has no clock. */
  clockMs?: number;
  /** Seconds added to the human clock after each of their moves. */
  incrementMs?: number;
  /** Human player's remaining clock; optional for saves from older versions. */
  humanTimeMs?: number;
  timedOut?: boolean;
  /** Absent while the game is still being played, and in saves from before
   *  adaptive difficulty existed. */
  resultApplied?: AppliedResult | null;
  /** Absent while the game is still being played, and in saves from before the
   *  per-level tally existed. */
  statsRecorded?: RecordedResult | null;
}

export interface ChessBotSettings {
  difficulty: Difficulty;
  playerColor: PlayerColorChoice;
  /** Which side is drawn at the bottom of the board. */
  boardOrientation: BoardOrientation;
  soundEnabled: boolean;
  soundVolume: number;
  /** Minutes on the human player's clock for a new game; 0 plays without one. */
  timeControlMinutes: number;
  /** Seconds added to the human clock after each of their moves; 0 is off. */
  incrementSeconds: number;
  /** Draw an arrow across the board for the bot's last move. */
  showMoveArrow: boolean;
  /** Move the level a step once the same result repeats often enough. */
  adaptiveDifficulty: boolean;
  /** How many wins (or losses) in a row it takes to move the level. */
  adaptiveThreshold: number;
  /** Positive = wins in a row, negative = losses in a row, 0 = no streak. */
  resultStreak: number;
  /** Wins, losses and draws per level, over every game ever finished. */
  levelStats: LevelStats;
  savedGame: SavedGame | null;
}

export const DEFAULT_SETTINGS: ChessBotSettings = {
  difficulty: 5,
  playerColor: "w",
  boardOrientation: "player",
  soundEnabled: true,
  soundVolume: 55,
  timeControlMinutes: 10,
  incrementSeconds: 0,
  showMoveArrow: true,
  adaptiveDifficulty: false,
  adaptiveThreshold: 3,
  resultStreak: 0,
  levelStats: {},
  savedGame: null
};

export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 10;
export const MIN_ADAPTIVE_THRESHOLD = 1;
export const MAX_ADAPTIVE_THRESHOLD = 5;

export function clampDifficulty(value: unknown): Difficulty {
  const level = Math.round(Number(value));
  if (!Number.isFinite(level)) return DEFAULT_SETTINGS.difficulty;
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, level)) as Difficulty;
}

export function clampAdaptiveThreshold(value: unknown): number {
  const games = Math.round(Number(value));
  if (!Number.isFinite(games)) return DEFAULT_SETTINGS.adaptiveThreshold;
  return Math.min(MAX_ADAPTIVE_THRESHOLD, Math.max(MIN_ADAPTIVE_THRESHOLD, games));
}

/**
 * Reads the tally back out of data.json, which is a file a person can edit:
 * levels off the ladder, missing counters and negative counts are all dropped
 * rather than trusted into the settings.
 *
 * Always returns a fresh object, which is also what keeps `DEFAULT_SETTINGS`
 * from being spread in by reference and then quietly counted into.
 */
export function sanitizeLevelStats(raw: unknown): LevelStats {
  const stats: LevelStats = {};
  if (!raw || typeof raw !== "object") return stats;

  const count = (value: unknown): number => {
    const games = Math.round(Number(value));
    return Number.isFinite(games) && games > 0 ? games : 0;
  };

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < MIN_DIFFICULTY || level > MAX_DIFFICULTY) continue;
    if (!value || typeof value !== "object") continue;
    const record = value as Partial<LevelRecord>;
    const cleaned: LevelRecord = {
      wins: count(record.wins),
      losses: count(record.losses),
      draws: count(record.draws)
    };
    if (cleaned.wins + cleaned.losses + cleaned.draws > 0) stats[level as Difficulty] = cleaned;
  }
  return stats;
}

/** "4–2–1", compact enough to sit next to a level in a menu. Empty when the
 *  level has no games behind it. */
export function formatRecord(record: LevelRecord | undefined): string {
  if (!record) return "";
  const { wins, losses, draws } = record;
  if (wins + losses + draws === 0) return "";
  return `${wins}–${losses}–${draws}`;
}

/**
 * One row per level. The important lever for "genuinely beatable" at the low
 * end is `quiescence`, not depth: without a capture-only leaf extension the
 * bot happily walks a piece onto a square it just vacated a capture from,
 * because it never looks one ply past its own capture to see the recapture.
 * That reads as a real, human-relatable blunder rather than "lower Elo."
 */
export interface DifficultyProfile {
  depth: number;
  timeBudgetMs: number;
  /** Capture-only search extension at leaf nodes; off = exploitable tactical blindness. */
  quiescence: boolean;
  /** Root move is chosen uniformly among the top N by score (1 = always best). */
  topN: number;
  /** Probability [0,1] of ignoring the ranking and playing from the bottom of it instead. */
  blunderChance: number;
  /** Fraction of the bottom of the ranked legal-move list a blunder draws from. */
  blunderPoolFraction: number;
  /**
   * Play the opening from the book instead of searching it.
   *
   * Off at the bottom of the ladder on purpose: a level whose whole character
   * is "walks into things" should walk into them from move one, not emerge
   * from four moves of theory and only then start blundering.
   */
  openingBook: boolean;
}

/*
 * Depths and budgets are measured, not aspirational. Levels 1-6 pick among
 * several root moves, which forces a full window at the root and costs roughly
 * an order of magnitude per ply — depth 2-3 is what fits there. Levels 7-10
 * always play the best move, keep the narrow window, and reach depth 3-4 inside
 * their budget. Anything deeper ran into tens of seconds per move on a desktop,
 * so it is not promised here: the old table asked for depth 8 and quietly
 * delivered 2 at every level above 4.
 */
export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  1: { depth: 1, timeBudgetMs: 200, quiescence: false, topN: 5, blunderChance: 0.35, blunderPoolFraction: 0.6, openingBook: false },
  2: { depth: 1, timeBudgetMs: 250, quiescence: false, topN: 4, blunderChance: 0.25, blunderPoolFraction: 0.5, openingBook: false },
  3: { depth: 2, timeBudgetMs: 400, quiescence: false, topN: 3, blunderChance: 0.15, blunderPoolFraction: 0.4, openingBook: false },
  4: { depth: 2, timeBudgetMs: 700, quiescence: true, topN: 3, blunderChance: 0.08, blunderPoolFraction: 0.35, openingBook: false },
  5: { depth: 2, timeBudgetMs: 1000, quiescence: true, topN: 2, blunderChance: 0.04, blunderPoolFraction: 0.3, openingBook: true },
  6: { depth: 3, timeBudgetMs: 1500, quiescence: true, topN: 2, blunderChance: 0.02, blunderPoolFraction: 0.25, openingBook: true },
  7: { depth: 3, timeBudgetMs: 1200, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0, openingBook: true },
  8: { depth: 4, timeBudgetMs: 2000, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0, openingBook: true },
  9: { depth: 4, timeBudgetMs: 3000, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0, openingBook: true },
  10: { depth: 5, timeBudgetMs: 4000, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0, openingBook: true }
};

export interface MoveRequest {
  id: number;
  fen: string;
  /** SAN from the initial position. The search needs it to count repetitions:
   *  a board built from a FEN alone has no history, so it cannot tell that a
   *  move walks back into a position the game has already visited. */
  sanHistory: string[];
  profile: DifficultyProfile;
}

export interface MoveResponse {
  id: number;
  ok: true;
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
  evalCp: number;
  depthReached: number;
  /** The move came out of the opening book, so evalCp/depthReached are not a
   *  search result and must not be shown as one. */
  fromBook?: boolean;
}

export interface MoveError {
  id: number;
  ok: false;
  error: string;
}

export type WorkerResponse = MoveResponse | MoveError;
