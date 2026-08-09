import type { Chess, Color, PieceSymbol, Square } from "chess.js";

/**
 * The search talks to chess.js through its *internal* move generator instead of
 * the public `moves({ verbose: true })` / `move()` pair.
 *
 * The public API is unusable for a search: every verbose `Move` object it hands
 * back re-generates the whole legal move list (to disambiguate SAN) and builds
 * two full FEN strings (`before`/`after`), with a make/undo in between. Measured
 * on this machine that is ~1.5 ms per node against ~44 µs for the internal path
 * — a 35x tax paid on every single node, which is why the bot used to bottom out
 * at depth 2 no matter what the difficulty profile asked for.
 *
 * The internal names are private, so `tests/engine.test.mjs` pins them: it
 * asserts the shape below still exists and that generating + making + unmaking
 * through it matches the public API move-for-move (castling, en passant and
 * promotions included). chess.js is pinned to an exact version for the same
 * reason. If a future version renames these, the test fails loudly at build
 * time rather than the bot silently refusing to move.
 */
export interface InternalMove {
  color: Color;
  from: number;
  to: number;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  flags: number;
}

interface InternalPiece {
  type: PieceSymbol;
  color: Color;
}

/**
 * The surface of chess.js that the search depends on. Declared standalone
 * rather than `extends Chess`: TypeScript refuses to widen a class's private
 * members, so the interface lists exactly what the search touches.
 */
export interface EngineBoard {
  turn(): Color;
  isCheck(): boolean;
  _moves(options?: { legal?: boolean; piece?: PieceSymbol; square?: Square }): InternalMove[];
  _makeMove(move: InternalMove): void;
  _undoMove(): InternalMove | null;
  /** 0x88 board: 128 slots, `i & 0x88` marks the off-board half. */
  _board: (InternalPiece | undefined)[];
  /** Zobrist hash of the current position; maintained by _makeMove/_undoMove. */
  _hash: bigint;
  /** Plies since the last capture or pawn move. */
  _halfMoves: number;
  _positionCount: Map<bigint, number>;
}

const REQUIRED_INTERNALS = ["_moves", "_makeMove", "_undoMove"] as const;

/** True when this chess.js build still exposes everything the search needs. */
export function hasInternalApi(chess: Chess): boolean {
  const candidate = chess as unknown as Partial<EngineBoard>;
  if (!REQUIRED_INTERNALS.every(name => typeof candidate[name] === "function")) return false;
  return Array.isArray(candidate._board)
    && typeof candidate._hash === "bigint"
    && typeof candidate._halfMoves === "number"
    && candidate._positionCount instanceof Map;
}

export function asEngineBoard(chess: Chess): EngineBoard {
  if (!hasInternalApi(chess)) {
    throw new Error("chess.js internal search API is missing — see src/engine-board.ts");
  }
  return chess as unknown as EngineBoard;
}

const FILE_LETTERS = "abcdefgh";
const RANK_DIGITS = "87654321";

/** 0x88 square index -> algebraic, mirroring chess.js's own `algebraic()`. */
export function toAlgebraic(square: number): Square {
  return `${FILE_LETTERS[square & 15]}${RANK_DIGITS[square >> 4]}` as Square;
}
