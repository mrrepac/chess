import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import { clampDifficulty, DIFFICULTY_PROFILES } from "./types";
import type {
  AppliedResult, Difficulty, GameOutcome, MoveRequest, PlayerColor, RecordedResult,
  SavedGame, WorkerResponse
} from "./types";

export type { GameOutcome };

/** Bundled at build time: the search worker as source (see esbuild.config.mjs). */
declare const ENGINE_WORKER_SOURCE: string;

let workerUrl: string | null = null;
function ensureWorkerUrl(): string {
  if (!workerUrl) {
    const blob = new Blob([ENGINE_WORKER_SOURCE], { type: "text/javascript" });
    workerUrl = URL.createObjectURL(blob);
  }
  return workerUrl;
}

function releaseWorkerUrl(): void {
  if (!workerUrl) return;
  URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}

let nextRequestId = 1;

export type Listener = () => void;
export const DEFAULT_CLOCK_MINUTES = 10;
/** Undoing a loss on time hands back this much, so the position is playable
 *  again instead of expiring the instant it is restored. */
const UNDO_AFTER_TIMEOUT_MS = 30 * 1000;

/** Marks a game whose result must not move the difficulty: it was already over
 *  when this save was written, so there is nothing to apply and nothing to take
 *  back. `from === to` is the "already accounted for" shape (see AppliedResult). */
const RESULT_ALREADY_COUNTED: AppliedResult = {
  from: 0, to: 0, streakBefore: 0, superseded: true
};

/** The same idea for the per-level tally: level 0 is no level, so undoing this
 *  game takes nothing back out of the counters. */
const RESULT_OUTSIDE_STATS: RecordedResult = { level: 0, outcome: "draw" };

/**
 * Owns the live board and talks to the bot. Deliberately free of any
 * `obsidian` import so it can be tested headlessly, the same way search.ts is.
 */
export class GameController {
  chess = new Chess();
  humanColor: PlayerColor = "w";
  /** Fixed for the lifetime of this game; settings only choose the next one. */
  gameDifficulty: Difficulty = 5;
  thinking = false;
  resigned = false;
  /** 0 disables the clock entirely. */
  clockMs = DEFAULT_CLOCK_MINUTES * 60 * 1000;
  /** Fischer increment: added to the human clock after each of their moves. */
  incrementMs = 0;
  humanTimeMs = DEFAULT_CLOCK_MINUTES * 60 * 1000;
  humanClockStartedAt: number | null = null;
  timedOut = false;
  /** Set when the search backend could not be started at all. */
  engineError: string | null = null;
  /** The engine's own score for its last move, in centipawns from white's
   *  point of view, with the depth it actually reached. */
  lastEval: { cp: number; depth: number } | null = null;
  /** The move the board highlights. Kept here because the only way to ask
   *  chess.js for it is to rebuild the whole verbose history, which costs 6 ms
   *  in a 120-ply game — paid on every repaint, including picking up a piece. */
  lastMove: Move | null = null;
  /** The bot's last move came out of the opening book, so `lastEval` is empty
   *  by design rather than because the search failed to report one. */
  lastMoveFromBook = false;
  /** Set by adaptive difficulty once this game's result has been counted. */
  resultApplied: AppliedResult | null = null;
  /** Set once this game has gone into the per-level tally. */
  statsRecorded: RecordedResult | null = null;

  private listeners = new Set<Listener>();
  private activeWorker: Worker | null = null;
  private cancelActiveRequest: (() => void) | null = null;
  private searchGeneration = 0;
  /** Several Obsidian leaves can show the shared controller at once. The clock
   *  pauses only when the last of those boards closes. */
  private openBoardCount = 0;

  get clockEnabled(): boolean {
    return this.clockMs > 0;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Invalidates the pending engine response and lets its awaiting promise finish. */
  private abortBotSearch(): void {
    this.searchGeneration++;
    this.activeWorker?.terminate();
    this.activeWorker = null;
    const cancel = this.cancelActiveRequest;
    this.cancelActiveRequest = null;
    cancel?.();
    this.thinking = false;
  }

  /** Stops work that belongs to the plugin instance and releases the module's
   *  Blob URL. Called when Obsidian disables or reloads the plugin. */
  dispose(): void {
    this.abortBotSearch();
    this.pauseHumanClock();
    this.listeners.clear();
    releaseWorkerUrl();
  }

  newGame(
    humanColor: PlayerColor,
    clockMs = this.clockMs,
    incrementMs = this.incrementMs,
    difficulty: Difficulty = this.gameDifficulty
  ): void {
    this.abortBotSearch();
    this.chess = new Chess();
    this.humanColor = humanColor;
    this.gameDifficulty = clampDifficulty(difficulty);
    this.resigned = false;
    this.clockMs = clockMs;
    this.incrementMs = incrementMs;
    this.humanTimeMs = clockMs;
    this.humanClockStartedAt = null;
    this.timedOut = false;
    this.engineError = null;
    this.lastEval = null;
    this.lastMove = null;
    this.lastMoveFromBook = false;
    this.resultApplied = null;
    this.statsRecorded = null;
    // No resumeHumanClock() here: the clock is a thinking-time budget and only
    // starts once the person has actually played (see clockStarted).
    this.notify();
  }

  /** Rebuilds a saved game. Returns false if the save was unusable and a fresh
   *  game had to be started instead — a hand-edited or truncated data.json used
   *  to throw out of here and take the whole plugin's onload down with it. */
  restore(saved: SavedGame, fallbackDifficulty: Difficulty = this.gameDifficulty): boolean {
    this.abortBotSearch();

    // Loading a FEN alone discards chess.js history. Prefer replaying SAN from
    // the initial position, but fall back to the FEN for legacy/partial saves.
    let restored: Chess | null = null;
    let replayedLast: Move | null = null;
    if (Array.isArray(saved.sanHistory)) {
      try {
        const replay = new Chess();
        let last: Move | null = null;
        for (const san of saved.sanHistory) last = replay.move(san);
        if (replay.fen() === saved.fen) {
          restored = replay;
          replayedLast = last;
        }
      } catch {
        // The final FEN below is still enough to recover the playable position.
      }
    }
    if (!restored) {
      try {
        restored = new Chess(saved.fen);
      } catch {
        this.newGame(
          saved.playerColor === "b" ? "b" : "w",
          saved.clockMs ?? this.clockMs,
          saved.incrementMs ?? this.incrementMs,
          clampDifficulty(saved.difficulty ?? fallbackDifficulty)
        );
        return false;
      }
    }
    this.chess = restored;
    this.lastMove = replayedLast;
    this.humanColor = saved.playerColor === "b" ? "b" : "w";
    this.gameDifficulty = clampDifficulty(saved.difficulty ?? fallbackDifficulty);
    this.resigned = saved.resigned ?? false;
    this.timedOut = saved.timedOut ?? false;
    this.engineError = null;
    this.lastEval = null;
    this.lastMoveFromBook = false;
    this.clockMs = saved.clockMs ?? DEFAULT_CLOCK_MINUTES * 60 * 1000;
    this.incrementMs = saved.incrementMs ?? 0;
    // The clock only runs while the board is on screen. Wall time that passed
    // with Obsidian closed is not the player's thinking time — draining it here
    // meant coming back the next day to a game already lost on time.
    this.humanTimeMs = saved.humanTimeMs ?? this.clockMs;
    this.humanClockStartedAt = null;
    // A game that was already finished before adaptive difficulty was watching
    // must not retroactively move the level on the next vault start.
    this.resultApplied = saved.resultApplied ?? (this.isGameOver ? RESULT_ALREADY_COUNTED : null);
    this.statsRecorded = saved.statsRecorded ?? (this.isGameOver ? RESULT_OUTSIDE_STATS : null);
    this.notify();
    return true;
  }

  serialize(): SavedGame {
    return {
      fen: this.chess.fen(),
      sanHistory: this.chess.history(),
      playerColor: this.humanColor,
      difficulty: this.gameDifficulty,
      resigned: this.resigned,
      clockMs: this.clockMs,
      incrementMs: this.incrementMs,
      humanTimeMs: this.remainingHumanTimeMs,
      timedOut: this.timedOut,
      resultApplied: this.resultApplied,
      statsRecorded: this.statsRecorded
    };
  }

  get remainingHumanTimeMs(): number {
    if (!this.clockEnabled) return Infinity;
    if (this.humanClockStartedAt === null) return this.humanTimeMs;
    return Math.max(0, this.humanTimeMs - (Date.now() - this.humanClockStartedAt));
  }

  get isGameOver(): boolean {
    return this.resigned || this.timedOut || this.chess.isGameOver();
  }

  /** How the game ended, from the point of view of the person playing. */
  get outcome(): GameOutcome | null {
    if (this.resigned || this.timedOut) return "loss";
    if (this.chess.isCheckmate()) return this.chess.turn() === this.humanColor ? "loss" : "win";
    if (this.chess.isGameOver()) return "draw";
    return null;
  }

  /** Half-moves the person has played. Derived from the position rather than
   *  the move list, so it is also right for a game restored from a bare FEN. */
  get humanMovesPlayed(): number {
    const ply = (this.chess.moveNumber() - 1) * 2 + (this.chess.turn() === "w" ? 0 : 1);
    return this.humanColor === "w" ? Math.ceil(ply / 2) : Math.floor(ply / 2);
  }

  /**
   * The clock is a budget for thinking about moves, so it does not start until
   * the first one is made. Opening the board, picking a colour and staring at
   * the initial position no longer costs the person anything.
   */
  get clockStarted(): boolean {
    return this.humanMovesPlayed > 0;
  }

  get isHumanTurn(): boolean {
    return !this.isGameOver && !this.thinking && this.chess.turn() === this.humanColor;
  }

  get historyLength(): number {
    return this.chess.history().length;
  }

  /** Replays a prefix of the real game for a read-only history view. The live
   *  Chess instance is never touched, so browsing cannot change the result,
   *  clock, statistics or the position play resumes from. */
  positionAtPly(ply: number): { chess: Chess; lastMove: Move | null } {
    const history = this.chess.history();
    const end = Math.min(history.length, Math.max(0, Math.trunc(ply)));
    const replay = new Chess();
    let lastMove: Move | null = null;
    for (let i = 0; i < end; i++) lastMove = replay.move(history[i]);
    return { chess: replay, lastMove };
  }

  /** Whether there is a played move for undo to take back. If it is already the
   *  human's turn the latest move was the bot's, so a second ply must exist or
   *  there is no human move under it (e.g. the bot's opening move against black). */
  private get hasMoveToUndo(): boolean {
    const historyLength = this.chess.history().length;
    if (historyLength === 0) return false;
    return !(this.chess.turn() === this.humanColor && historyLength < 2);
  }

  /**
   * Undo is also the only way back from resigning or losing on time, so it is
   * available for those even with no move to pop — resigning on move one used
   * to leave the board in a finished game the button silently refused to touch,
   * while the confirmation box promised the opposite.
   */
  get canUndo(): boolean {
    return this.hasMoveToUndo || this.resigned || this.timedOut;
  }

  resign(): boolean {
    if (this.isGameOver) return false;
    this.abortBotSearch();
    this.pauseHumanClock();
    this.resigned = true;
    this.notify();
    return true;
  }

  applyHumanMove(from: Square, to: Square, promotion?: PieceSymbol): Move | null {
    if (!this.isHumanTurn) return null;
    if (this.remainingHumanTimeMs <= 0) {
      this.expireHumanClock();
      return null;
    }
    let move: Move | null;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch {
      return null; // illegal move
    }
    this.lastMove = move;
    // The previous engine score describes the position before this move. Do
    // not show it while the bot thinks — or forever if this move ends the game.
    this.lastEval = null;
    this.lastMoveFromBook = false;
    this.pauseHumanClock();
    // Fischer increment, credited once the move is on the board — the order a
    // real clock does it in.
    if (this.clockEnabled && this.incrementMs > 0) this.humanTimeMs += this.incrementMs;
    this.notify();
    return move;
  }

  /** Pops the bot's reply (if it landed) and the human move under it, so undo
   *  always hands the turn straight back to the human to try something else.
   *  With nothing to pop it still lifts a resignation or a loss on time. */
  undoHumanTurn(): boolean {
    if (!this.canUndo) return false;
    const takingBackMoves = this.hasMoveToUndo;
    this.abortBotSearch();
    this.pauseHumanClock();
    // Hand the undone move's increment back, or a move could be played and
    // taken back over and over to print clock time.
    if (takingBackMoves && this.clockEnabled && this.incrementMs > 0) {
      this.humanTimeMs = Math.max(0, this.humanTimeMs - this.incrementMs);
    }
    if (this.timedOut) this.humanTimeMs = Math.max(this.humanTimeMs, UNDO_AFTER_TIMEOUT_MS);
    this.resigned = false;
    this.timedOut = false;
    this.lastEval = null;
    this.lastMoveFromBook = false;
    if (takingBackMoves) {
      this.chess.undo();
      if (this.chess.turn() !== this.humanColor && this.chess.history().length > 0) {
        this.chess.undo();
      }
      // Undo is user-initiated and rare, so rebuilding the verbose history here
      // is the one place where its cost does not matter.
      const history = this.chess.history({ verbose: true });
      this.lastMove = history[history.length - 1] ?? null;
    }
    if (this.chess.turn() === this.humanColor) this.resumeHumanClock();
    this.notify();
    return true;
  }

  async requestBotMove(): Promise<Move | null> {
    if (this.isGameOver || this.thinking || this.chess.turn() === this.humanColor) return null;
    const profile = DIFFICULTY_PROFILES[this.gameDifficulty];
    if (!profile) return null;
    const requestedFen = this.chess.fen();
    const generation = ++this.searchGeneration;
    this.thinking = true;
    this.engineError = null;
    this.notify();

    // Worker construction itself can fail (no Worker, blocked blob: URL). It
    // used to sit outside the try, so the rejection escaped into an unhandled
    // promise and the board stayed on "thinking" forever with nothing shown.
    let worker: Worker;
    try {
      worker = new Worker(ensureWorkerUrl());
    } catch (e) {
      this.thinking = false;
      this.engineError = e instanceof Error ? e.message : String(e);
      this.notify();
      return null;
    }
    this.activeWorker = worker;
    const id = nextRequestId++;
    try {
      const response = await new Promise<WorkerResponse | null>((resolve, reject) => {
        let settled = false;
        const finish = (value: WorkerResponse | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        this.cancelActiveRequest = () => finish(null);
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => finish(e.data);
        worker.onerror = (e) => {
          if (settled) return;
          settled = true;
          reject(new Error(e.message || "engine worker failed"));
        };
        const request: MoveRequest = {
          id,
          fen: this.chess.fen(),
          sanHistory: this.chess.history(),
          profile
        };
        worker.postMessage(request);
      });
      if (!response || generation !== this.searchGeneration) return null;
      if (response.id !== id || this.chess.fen() !== requestedFen) return null;
      if (!response.ok) throw new Error(response.error);
      if (this.isGameOver || this.chess.turn() === this.humanColor) return null;
      try {
        const move = this.chess.move({ from: response.from, to: response.to, promotion: response.promotion });
        this.lastMoveFromBook = response.fromBook === true;
        // A book move carries no search behind it, so there is no score to show.
        this.lastEval = this.lastMoveFromBook
          ? null
          : { cp: response.evalCp, depth: response.depthReached };
        this.lastMove = move;
        return move;
      } catch {
        return null;
      }
    } catch (e) {
      // A worker failure must not become an unhandled rejection in the view.
      if (generation === this.searchGeneration) {
        this.engineError = e instanceof Error ? e.message : String(e);
      }
      return null;
    } finally {
      worker.terminate();
      if (this.activeWorker === worker) this.activeWorker = null;
      if (generation === this.searchGeneration) {
        this.cancelActiveRequest = null;
        this.thinking = false;
        if (!this.isGameOver && this.chess.turn() === this.humanColor) this.resumeHumanClock();
        this.notify();
      }
    }
  }

  expireHumanClock(): boolean {
    if (this.isGameOver || this.remainingHumanTimeMs > 0) return false;
    this.humanTimeMs = 0;
    this.humanClockStartedAt = null;
    this.timedOut = true;
    this.notify();
    return true;
  }

  /** Starts the human clock if it is genuinely their turn to think. */
  resumeHumanClock(): void {
    if (!this.clockEnabled || this.humanClockStartedAt !== null) return;
    if (this.isGameOver || this.thinking || !this.clockStarted) return;
    if (this.chess.turn() !== this.humanColor) return;
    this.humanClockStartedAt = Date.now();
  }

  pauseHumanClock(): void {
    if (!this.clockEnabled) return;
    this.humanTimeMs = this.remainingHumanTimeMs;
    this.humanClockStartedAt = null;
  }

  /** A board leaf became visible/alive. The first one resumes shared play. */
  openBoard(): void {
    this.openBoardCount++;
    if (this.openBoardCount === 1) this.resumeHumanClock();
  }

  /** A board leaf closed. Other leaves keep the shared clock running. */
  closeBoard(): void {
    if (this.openBoardCount === 0) return;
    this.openBoardCount--;
    if (this.openBoardCount === 0) this.pauseHumanClock();
  }
}
