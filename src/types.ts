import type { Color, PieceSymbol, Square } from "chess.js";

export type PlayerColor = "w" | "b";
export type PlayerColorChoice = PlayerColor | "random";

/** 1 = should lose to a beginner, 10 = plays every game near its best. */
export type Difficulty = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface SavedGame {
  fen: string;
  /** SAN history from the initial position, used to restore undo and last-move state. */
  sanHistory: string[];
  playerColor: PlayerColor;
  /** Optional for compatibility with saves created before resignation was persisted. */
  resigned?: boolean;
  /** Human player's remaining clock; optional for saves from older versions. */
  humanTimeMs?: number;
  /** Wall-clock anchor used while it is the human player's turn. */
  humanClockStartedAt?: number | null;
  timedOut?: boolean;
}

export interface ChessBotSettings {
  difficulty: Difficulty;
  playerColor: PlayerColorChoice;
  soundEnabled: boolean;
  soundVolume: number;
  savedGame: SavedGame | null;
}

export const DEFAULT_SETTINGS: ChessBotSettings = {
  difficulty: 5,
  playerColor: "w",
  soundEnabled: true,
  soundVolume: 55,
  savedGame: null
};

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
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  1: { depth: 1, timeBudgetMs: 150, quiescence: false, topN: 5, blunderChance: 0.35, blunderPoolFraction: 0.6 },
  2: { depth: 1, timeBudgetMs: 200, quiescence: false, topN: 4, blunderChance: 0.25, blunderPoolFraction: 0.5 },
  3: { depth: 2, timeBudgetMs: 300, quiescence: false, topN: 3, blunderChance: 0.15, blunderPoolFraction: 0.4 },
  4: { depth: 2, timeBudgetMs: 500, quiescence: true, topN: 3, blunderChance: 0.08, blunderPoolFraction: 0.35 },
  5: { depth: 3, timeBudgetMs: 700, quiescence: true, topN: 2, blunderChance: 0.04, blunderPoolFraction: 0.3 },
  6: { depth: 4, timeBudgetMs: 900, quiescence: true, topN: 2, blunderChance: 0.01, blunderPoolFraction: 0.25 },
  7: { depth: 5, timeBudgetMs: 1200, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0 },
  8: { depth: 6, timeBudgetMs: 1500, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0 },
  9: { depth: 7, timeBudgetMs: 2000, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0 },
  10: { depth: 8, timeBudgetMs: 3000, quiescence: true, topN: 1, blunderChance: 0, blunderPoolFraction: 0 }
};

/** Short RU label shown under the difficulty slider. */
export function describeDifficulty(level: Difficulty): string {
  const labels: Record<Difficulty, string> = {
    1: "1 — совсем новичок, постоянно зевает фигуры",
    2: "2 — очень слабый, легко обыграть",
    3: "3 — видит на один ход вперёд",
    4: "4 — замечает простые связки",
    5: "5 — играет разумно, иногда ошибается",
    6: "6 — крепкий любительский уровень",
    7: "7 — редко ошибается, считает тактику",
    8: "8 — уверенно находит тактику",
    9: "9 — сильный, мало слабостей",
    10: "10 — потолок движка (не гроссмейстер, но крепкий клубный игрок)"
  };
  return labels[level];
}

export interface MoveRequest {
  id: number;
  fen: string;
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
}

export interface MoveError {
  id: number;
  ok: false;
  error: string;
}

export type WorkerResponse = MoveResponse | MoveError;

export interface DisplayPiece {
  square: Square;
  type: PieceSymbol;
  color: Color;
}
