import type { Chess, PieceSymbol, Square } from "chess.js";
import { evaluate } from "./evaluation";
import { bookMove } from "./opening-book";
import { asEngineBoard, toAlgebraic } from "./engine-board";
import type { EngineBoard, InternalMove } from "./engine-board";
import type { DifficultyProfile } from "./types";

const MATE_SCORE = 100000;
const PIECE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

/** Quiescence can only extend this far past the root before it must stand pat. */
const MAX_QUIESCENCE_PLY = 40;
/** Deadline is polled every 512 nodes; at ~50 µs/node that is ~25 ms of slack. */
const DEADLINE_POLL_MASK = 511;

class SearchTimeout extends Error {}

interface ScoredMove {
  move: InternalMove;
  score: number;
}

/*
 * Transposition table. Chess trees re-reach the same position along many move
 * orders; without a table the bot pays full price for each of them and stalls
 * around depth 3-4, which is why every level above 7 used to play identically.
 * Flat typed arrays keep it allocation-free: ~4 MB, sized for mobile too.
 */
const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = BigInt(TT_SIZE - 1);
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

const ttKeys = new BigUint64Array(TT_SIZE);
const ttScores = new Int32Array(TT_SIZE);
const ttDepths = new Int8Array(TT_SIZE);
const ttFlags = new Uint8Array(TT_SIZE);
const ttFrom = new Uint8Array(TT_SIZE);
const ttTo = new Uint8Array(TT_SIZE);
const ttGenerations = new Uint16Array(TT_SIZE);
/** Bumped per search so entries from an earlier one are ignored: draw scores
 *  depend on the game history, which differs between searches. */
let ttGeneration = 0;

function ttIndex(hash: bigint): number {
  return Number(hash & TT_MASK);
}

/** Mate scores are relative to the node they were found at, so they have to be
 *  stored ply-independent and re-based on the way out. */
function scoreToTT(score: number, ply: number): number {
  if (score > MATE_SCORE - 1000) return score + ply;
  if (score < -MATE_SCORE + 1000) return score - ply;
  return score;
}

function scoreFromTT(score: number, ply: number): number {
  if (score > MATE_SCORE - 1000) return score - ply;
  if (score < -MATE_SCORE + 1000) return score + ply;
  return score;
}

interface SearchContext {
  board: EngineBoard;
  deadline: number;
  nodes: number;
  quiescence: boolean;
  /** Position hash -> how many times it has occurred, game history included. */
  repetitions: Map<bigint, number>;
}

/**
 * MVV-LVA: take the most valuable victim with the least valuable attacker, and
 * try promotions early. Good ordering is what makes alpha-beta cut at all.
 */
function moveScore(move: InternalMove): number {
  let score = 0;
  if (move.captured) score += PIECE_VALUE[move.captured] * 10 - PIECE_VALUE[move.piece];
  if (move.promotion) score += PIECE_VALUE[move.promotion];
  return score;
}

/** `hashMove` — the move the table already liked here — is tried first; it is
 *  by far the cheapest way to get an early cutoff. */
function orderMoves(moves: InternalMove[], hashFrom = -1, hashTo = -1): InternalMove[] {
  return moves.sort((a, b) => {
    const aHash = a.from === hashFrom && a.to === hashTo ? 1_000_000 : 0;
    const bHash = b.from === hashFrom && b.to === hashTo ? 1_000_000 : 0;
    return (bHash + moveScore(b)) - (aHash + moveScore(a));
  });
}

function checkDeadline(ctx: SearchContext): void {
  if ((++ctx.nodes & DEADLINE_POLL_MASK) === 0 && Date.now() > ctx.deadline) throw new SearchTimeout();
}

/**
 * A position that repeats, or that trips the fifty-move counter, is a draw and
 * must score 0 — otherwise the bot happily shuffles in a won game and never
 * sees a perpetual as the escape it is when losing. chess.js includes the
 * current position in this count, so only the third occurrence is a rule draw;
 * the opponent can still deviate after the second.
 */
function isDrawByRule(ctx: SearchContext): boolean {
  if (ctx.board._halfMoves >= 100) return true;
  return (ctx.repetitions.get(ctx.board._hash) ?? 0) >= 3;
}

function makeMove(ctx: SearchContext, move: InternalMove): void {
  ctx.board._makeMove(move);
  const hash = ctx.board._hash;
  ctx.repetitions.set(hash, (ctx.repetitions.get(hash) ?? 0) + 1);
}

function unmakeMove(ctx: SearchContext): void {
  const hash = ctx.board._hash;
  const count = ctx.repetitions.get(hash) ?? 0;
  if (count <= 1) ctx.repetitions.delete(hash);
  else ctx.repetitions.set(hash, count - 1);
  ctx.board._undoMove();
}

/** Capture-only extension at the leaf, so the bot sees past its own captures
 *  instead of walking a piece into an obvious recapture. Fail-soft: it returns
 *  the best score it actually saw, never a bare window bound. */
function quiescence(ctx: SearchContext, alpha: number, beta: number, color: 1 | -1, ply: number): number {
  checkDeadline(ctx);
  if (isDrawByRule(ctx)) return 0;

  const inCheck = ctx.board.isCheck();
  const moves = ctx.board._moves({ legal: true });
  if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;
  if (ply >= MAX_QUIESCENCE_PLY) return color * evaluate(ctx.board);

  // Stand-pat is illegal while in check. Search every legal evasion, including
  // quiet king moves and blocks, before returning to capture-only extensions.
  let best: number;
  let candidates: InternalMove[];
  if (inCheck) {
    best = -Infinity;
    candidates = orderMoves(moves);
  } else {
    best = color * evaluate(ctx.board);
    if (best >= beta) return best;
    if (best > alpha) alpha = best;
    // Filter first, order second: a quiet node has ~35 legal moves and ~2 of
    // them are captures, and only the captures are ever searched here.
    candidates = orderMoves(moves.filter(m => m.captured || m.promotion));
  }

  for (const move of candidates) {
    makeMove(ctx, move);
    let score: number;
    try {
      score = -quiescence(ctx, -beta, -alpha, (-color) as 1 | -1, ply + 1);
    } finally {
      // A timeout thrown mid-recursion must not leave this move applied — every
      // frame's finally runs during unwind, so the board always ends up back
      // where the caller left it, timeout or not.
      unmakeMove(ctx);
    }
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function negamax(
  ctx: SearchContext, depth: number, alpha: number, beta: number, color: 1 | -1, ply: number
): number {
  checkDeadline(ctx);
  if (isDrawByRule(ctx)) return 0;

  const hash = ctx.board._hash;
  const slot = ttIndex(hash);
  const alphaOrig = alpha;
  let hashFrom = -1;
  let hashTo = -1;
  if (ttKeys[slot] === hash && ttGenerations[slot] === ttGeneration) {
    hashFrom = ttFrom[slot];
    hashTo = ttTo[slot];
    if (ttDepths[slot] >= depth) {
      const stored = scoreFromTT(ttScores[slot], ply);
      const flag = ttFlags[slot];
      if (flag === TT_EXACT) return stored;
      if (flag === TT_LOWER && stored > alpha) alpha = stored;
      else if (flag === TT_UPPER && stored < beta) beta = stored;
      if (alpha >= beta) return stored;
    }
  }

  // Hand off to quiescence before generating anything: it generates the same
  // legal move list itself, and this node has no other use for one. Doing it
  // the other way round paid for every leaf's move generation twice, which
  // measured 7-45% of the whole search depending on the position.
  if (depth === 0 && ctx.quiescence) return quiescence(ctx, alpha, beta, color, ply);

  const moves = orderMoves(ctx.board._moves({ legal: true }), hashFrom, hashTo);
  if (moves.length === 0) {
    if (ctx.board.isCheck()) return -MATE_SCORE + ply;
    return 0; // stalemate
  }
  if (depth === 0) return color * evaluate(ctx.board);

  let best = -Infinity;
  let bestMove = moves[0];
  for (const move of moves) {
    makeMove(ctx, move);
    let score: number;
    try {
      score = -negamax(ctx, depth - 1, -beta, -alpha, (-color) as 1 | -1, ply + 1);
    } finally {
      unmakeMove(ctx);
    }
    if (score > best) {
      best = score;
      bestMove = move;
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }

  // Depth-preferred replacement: a shallow entry never evicts a deeper one from
  // the same search.
  if (ttGenerations[slot] !== ttGeneration || ttDepths[slot] <= depth) {
    ttKeys[slot] = hash;
    ttScores[slot] = scoreToTT(best, ply);
    ttDepths[slot] = depth;
    ttFlags[slot] = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
    ttFrom[slot] = bestMove.from;
    ttTo[slot] = bestMove.to;
    ttGenerations[slot] = ttGeneration;
  }
  return best;
}

/** Pick from the ranked root moves per the difficulty profile: usually one of
 *  the top N, occasionally (blunderChance) one drawn from the weak end of the
 *  list instead — a real, exploitable mistake rather than "second best." */
/** Moves within this many centipawns of the best are treated as equal, so the
 *  strongest levels vary their play instead of replaying one identical game. */
const EQUAL_MOVE_MARGIN = 10;
/**
 * ...but only while the position is roughly balanced. Once something concrete
 * is on the board, near-equal scores stop meaning "either is fine": mate in one
 * and mate in two sit two points apart, and queening now versus queening in two
 * moves five. Treating those as interchangeable throws away the faster win.
 */
const EQUAL_MOVE_MAX_ADVANTAGE = 200;

function pickMove(ranked: ScoredMove[], profile: DifficultyProfile, rng: () => number): ScoredMove {
  if (profile.blunderChance > 0 && rng() < profile.blunderChance) {
    const poolSize = Math.max(1, Math.round(ranked.length * profile.blunderPoolFraction));
    const pool = ranked.slice(ranked.length - poolSize);
    return pool[Math.floor(rng() * pool.length)];
  }
  if (profile.topN === 1) {
    if (Math.abs(ranked[0].score) > EQUAL_MOVE_MAX_ADVANTAGE) return ranked[0];
    const cutoff = ranked[0].score - EQUAL_MOVE_MARGIN;
    const tied = ranked.filter(entry => entry.score >= cutoff);
    return tied[Math.floor(rng() * tied.length)];
  }
  const topN = Math.min(profile.topN, ranked.length);
  const pool = ranked.slice(0, topN);
  return pool[Math.floor(rng() * pool.length)];
}

export interface SearchMove {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
}

export interface SearchResult {
  move: SearchMove;
  evalCp: number;
  depthReached: number;
  /** True when the move came straight out of the book and nothing was searched. */
  fromBook?: boolean;
}

function describeMove(move: InternalMove): SearchMove {
  const out: SearchMove = { from: toAlgebraic(move.from), to: toAlgebraic(move.to) };
  if (move.promotion) out.promotion = move.promotion;
  return out;
}

/**
 * Iterative-deepening alpha-beta from the current position (chess.turn()'s side
 * to move). `rng` is injectable so tests can seed determinism.
 */
export function findMove(chess: Chess, profile: DifficultyProfile, rng: () => number = Math.random): SearchResult {
  if (profile.openingBook) {
    const opening = bookMove(chess, rng);
    if (opening) return { move: opening, evalCp: 0, depthReached: 0, fromBook: true };
  }
  const { ranked, depthReached, color } = searchRoot(chess, profile);
  const chosen = pickMove(ranked, profile, rng);
  // evalCp reflects the move actually chosen (which may be a deliberate
  // blunder), not the best move the search found — otherwise the reported
  // score would silently disagree with the move being played.
  return { move: describeMove(chosen.move), evalCp: color * chosen.score, depthReached };
}

/** The ranked root moves, best first. Exposed so tests can check that the
 *  ranking has real spread rather than only that the top move is right. */
export function rankRootMoves(chess: Chess, profile: DifficultyProfile): { move: SearchMove; score: number }[] {
  const { ranked, color } = searchRoot(chess, profile);
  return ranked.map(({ move, score }) => ({ move: describeMove(move), score: color * score }));
}

function searchRoot(chess: Chess, profile: DifficultyProfile): {
  ranked: ScoredMove[];
  depthReached: number;
  color: 1 | -1;
} {
  const board = asEngineBoard(chess);
  const rootMoves = orderMoves(board._moves({ legal: true }));
  if (rootMoves.length === 0) throw new Error("no legal moves in this position");

  ttGeneration = (ttGeneration + 1) & 0xffff;

  const repetitions = new Map(board._positionCount);
  // A board built straight from a FEN has no position history; make sure the
  // root itself is counted so a return to it still registers as a repetition.
  repetitions.set(board._hash, Math.max(1, repetitions.get(board._hash) ?? 0));

  const ctx: SearchContext = {
    board,
    deadline: Date.now() + profile.timeBudgetMs,
    nodes: 0,
    quiescence: profile.quiescence,
    repetitions
  };
  const color: 1 | -1 = board.turn() === "w" ? 1 : -1;

  /*
   * Levels that pick among several root moves need every root score to be
   * exact, so each root move gets a full window. Narrowing alpha across the
   * root (the usual optimisation) makes every move after the best one return a
   * bound equal to the best score instead of its own value: the ranking goes
   * flat, and "one of the top 3" silently degrades into "any move at all".
   * Levels that always play the best move keep the narrow window and the depth
   * it buys.
   */
  const needsExactRanking = profile.topN > 1 || profile.blunderChance > 0;

  let ranked: ScoredMove[] = rootMoves.map(move => ({ move, score: 0 }));
  let depthReached = 0;

  for (let depth = 1; depth <= profile.depth; depth++) {
    const scored: ScoredMove[] = [];
    try {
      const ordered = [...ranked].sort((a, b) => b.score - a.score).map(sm => sm.move);
      let rootAlpha = -Infinity;
      for (const move of ordered) {
        makeMove(ctx, move);
        let score: number;
        try {
          const childBeta = needsExactRanking ? Infinity : -rootAlpha;
          score = -negamax(ctx, depth - 1, -Infinity, childBeta, (-color) as 1 | -1, 1);
        } finally {
          unmakeMove(ctx);
        }
        scored.push({ move, score });
        if (!needsExactRanking && score > rootAlpha) rootAlpha = score;
      }
    } catch (e) {
      if (e instanceof SearchTimeout) break;
      throw e;
    }
    ranked = scored;
    depthReached = depth;
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, depthReached, color };
}
