import type { EngineBoard } from "./engine-board";

const PIECE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Index 0 = rank 8 (a8..h8), index 7 = rank 1 (a1..h1) — matches the 0x88 rank order.
const PAWN_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 25, 25, 10, 5, 5],
  [0, 0, 0, 20, 20, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -20, -20, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0]
];
const KNIGHT_PST = [
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50]
];
const BISHOP_PST = [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20]
];
const ROOK_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0]
];
const QUEEN_PST = [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20]
];
const KING_PST = [
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20]
];

const PST: Record<string, number[][]> = {
  p: PAWN_PST, n: KNIGHT_PST, b: BISHOP_PST, r: ROOK_PST, q: QUEEN_PST, k: KING_PST
};

const BISHOP_PAIR_BONUS = 30;
/** Small edge for having the move. Replaces the old mobility term, which only
 *  counted the side to move and so swung the score by up to ~80cp depending on
 *  whose turn a leaf happened to land on — a parity bias, not an evaluation. */
const TEMPO_BONUS = 10;

/**
 * Centipawns from white's perspective: positive favors white.
 *
 * Reads chess.js's raw 0x88 array rather than `board()`: no per-call allocation
 * of 64 cells, and no legal-move generation hiding inside the evaluation.
 */
export function evaluate(board: EngineBoard): number {
  let score = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  for (let i = 0; i <= 119; i++) {
    if (i & 0x88) {
      i += 7; // skip the off-board half of the 0x88 layout
      continue;
    }
    const cell = board._board[i];
    if (!cell) continue;
    const isWhite = cell.color === "w";
    const rank = i >> 4;
    const posRank = isWhite ? rank : 7 - rank;
    const value = PIECE_VALUE[cell.type] + PST[cell.type][posRank][i & 15];
    score += isWhite ? value : -value;
    if (cell.type === "b") {
      if (isWhite) whiteBishops++;
      else blackBishops++;
    }
  }

  if (whiteBishops >= 2) score += BISHOP_PAIR_BONUS;
  if (blackBishops >= 2) score -= BISHOP_PAIR_BONUS;

  return score + (board.turn() === "w" ? TEMPO_BONUS : -TEMPO_BONUS);
}
