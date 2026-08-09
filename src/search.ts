import { Chess, type Move } from "chess.js";
import { evaluate } from "./evaluation";
import type { DifficultyProfile } from "./types";

const MATE_SCORE = 100000;
const CAPTURE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

class SearchTimeout extends Error {}

interface ScoredMove {
  move: Move;
  score: number;
}

/** Captures first (highest-value victim first) so alpha-beta cuts harder. */
function orderMoves(moves: Move[]): Move[] {
  return [...moves].sort((a, b) => {
    const av = a.captured ? CAPTURE_VALUE[a.captured] : -1;
    const bv = b.captured ? CAPTURE_VALUE[b.captured] : -1;
    return bv - av;
  });
}

function checkDeadline(nodeCounter: { n: number }, mask: number, deadline: number): void {
  if (++nodeCounter.n % mask === 0 && Date.now() > deadline) throw new SearchTimeout();
}

/** Capture-only extension at the leaf, so the bot sees past its own captures
 *  instead of walking a piece into an obvious recapture. */
function quiescence(
  chess: Chess, alpha: number, beta: number, color: 1 | -1,
  deadline: number, nodeCounter: { n: number }, ply: number
): number {
  checkDeadline(nodeCounter, 4096, deadline);

  const moves = orderMoves(chess.moves({ verbose: true }) as Move[]);
  if (moves.length === 0) {
    return chess.isCheckmate() ? -MATE_SCORE + ply : 0;
  }

  // Stand-pat is illegal while in check. Search every legal evasion, including
  // quiet king moves and blocks, before returning to capture-only extensions.
  if (chess.isCheck()) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      let score: number;
      try {
        score = -quiescence(chess, -beta, -alpha, (-color) as 1 | -1, deadline, nodeCounter, ply + 1);
      } finally {
        chess.undo();
      }
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  const standPat = color * evaluate(chess);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  const captures = moves.filter(m => m.captured);
  for (const m of captures) {
    chess.move(m);
    let score: number;
    try {
      score = -quiescence(chess, -beta, -alpha, (-color) as 1 | -1, deadline, nodeCounter, ply + 1);
    } finally {
      // a timeout thrown mid-recursion must not leave this move applied —
      // every frame's finally runs during unwind, so the board always ends
      // up back where the caller left it, timeout or not
      chess.undo();
    }
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(
  chess: Chess, depth: number, alpha: number, beta: number, color: 1 | -1, ply: number,
  profile: DifficultyProfile, deadline: number, nodeCounter: { n: number }
): number {
  checkDeadline(nodeCounter, 2048, deadline);

  const moves = orderMoves(chess.moves({ verbose: true }) as Move[]);
  if (moves.length === 0) {
    if (chess.isCheckmate()) return -MATE_SCORE + ply;
    return 0; // stalemate or other no-move draw
  }
  if (depth === 0) {
    return profile.quiescence
      ? quiescence(chess, alpha, beta, color, deadline, nodeCounter, ply)
      : color * evaluate(chess);
  }

  let best = -Infinity;
  for (const m of moves) {
    chess.move(m);
    let score: number;
    try {
      score = -negamax(chess, depth - 1, -beta, -alpha, (-color) as 1 | -1, ply + 1, profile, deadline, nodeCounter);
    } finally {
      chess.undo();
    }
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

/** Pick from the ranked root moves per the difficulty profile: usually one of
 *  the top N, occasionally (blunderChance) one drawn from the weak end of the
 *  list instead — a real, exploitable mistake rather than "second best." */
function pickMove(ranked: ScoredMove[], profile: DifficultyProfile, rng: () => number): ScoredMove {
  if (profile.blunderChance > 0 && rng() < profile.blunderChance) {
    const poolSize = Math.max(1, Math.round(ranked.length * profile.blunderPoolFraction));
    const pool = ranked.slice(ranked.length - poolSize);
    return pool[Math.floor(rng() * pool.length)];
  }
  const topN = Math.min(profile.topN, ranked.length);
  const pool = ranked.slice(0, topN);
  return pool[Math.floor(rng() * pool.length)];
}

export interface SearchResult {
  move: Move;
  evalCp: number;
  depthReached: number;
}

/**
 * Iterative-deepening alpha-beta from the current position (chess.turn()'s
 * side to move). `rng` is injectable so tests can seed determinism.
 */
export function findMove(chess: Chess, profile: DifficultyProfile, rng: () => number = Math.random): SearchResult {
  const rootMoves = orderMoves(chess.moves({ verbose: true }) as Move[]);
  if (rootMoves.length === 0) throw new Error("no legal moves in this position");

  const deadline = Date.now() + profile.timeBudgetMs;
  const color: 1 | -1 = chess.turn() === "w" ? 1 : -1;

  let ranked: ScoredMove[] = rootMoves.map(move => ({ move, score: 0 }));
  let depthReached = 0;

  for (let depth = 1; depth <= profile.depth; depth++) {
    const nodeCounter = { n: 0 };
    const scored: ScoredMove[] = [];
    try {
      const ordered = [...ranked].sort((a, b) => b.score - a.score).map(sm => sm.move);
      let alpha = -Infinity;
      const beta = Infinity;
      for (const move of ordered) {
        chess.move(move);
        let score: number;
        try {
          score = -negamax(chess, depth - 1, -beta, -alpha, (-color) as 1 | -1, 1, profile, deadline, nodeCounter);
        } finally {
          chess.undo();
        }
        scored.push({ move, score });
        if (score > alpha) alpha = score;
      }
    } catch (e) {
      if (e instanceof SearchTimeout) break;
      throw e;
    }
    ranked = scored;
    depthReached = depth;
  }

  ranked.sort((a, b) => b.score - a.score);
  const chosen = pickMove(ranked, profile, rng);
  // evalCp reflects the move actually chosen (which may be a deliberate
  // blunder), not the best move the search found — otherwise the reported
  // score would silently disagree with the move being played.
  return { move: chosen.move, evalCp: color * chosen.score, depthReached };
}
