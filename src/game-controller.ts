import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import { DIFFICULTY_PROFILES } from "./types";
import type { Difficulty, MoveRequest, PlayerColor, SavedGame, WorkerResponse } from "./types";

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

let nextRequestId = 1;

export type Listener = () => void;
export const HUMAN_CLOCK_MS = 10 * 60 * 1000;

/**
 * Owns the live board and talks to the bot. Deliberately free of any
 * `obsidian` import so it can be tested headlessly, the same way search.ts is.
 */
export class GameController {
  chess = new Chess();
  humanColor: PlayerColor = "w";
  thinking = false;
  resigned = false;
  humanTimeMs = HUMAN_CLOCK_MS;
  humanClockStartedAt: number | null = Date.now();
  timedOut = false;

  private listeners = new Set<Listener>();
  private activeWorker: Worker | null = null;
  private cancelActiveRequest: (() => void) | null = null;
  private searchGeneration = 0;

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

  newGame(humanColor: PlayerColor): void {
    this.abortBotSearch();
    this.chess = new Chess();
    this.humanColor = humanColor;
    this.resigned = false;
    this.humanTimeMs = HUMAN_CLOCK_MS;
    this.humanClockStartedAt = humanColor === "w" ? Date.now() : null;
    this.timedOut = false;
    this.notify();
  }

  restore(saved: SavedGame): void {
    this.abortBotSearch();

    // Loading a FEN alone discards chess.js history. Prefer replaying SAN from
    // the initial position, but fall back to the FEN for legacy/partial saves.
    let restored: Chess | null = null;
    if (Array.isArray(saved.sanHistory)) {
      try {
        const replay = new Chess();
        for (const san of saved.sanHistory) replay.move(san);
        if (replay.fen() === saved.fen) restored = replay;
      } catch {
        // The final FEN below is still enough to recover the playable position.
      }
    }
    this.chess = restored ?? new Chess(saved.fen);
    this.humanColor = saved.playerColor;
    this.resigned = saved.resigned ?? false;
    this.humanTimeMs = saved.humanTimeMs ?? HUMAN_CLOCK_MS;
    this.timedOut = saved.timedOut ?? false;
    if (!this.resigned && !this.timedOut && !this.chess.isGameOver() && this.chess.turn() === this.humanColor) {
      const anchor = saved.humanClockStartedAt ?? Date.now();
      this.humanTimeMs = Math.max(0, this.humanTimeMs - Math.max(0, Date.now() - anchor));
      this.humanClockStartedAt = Date.now();
      if (this.humanTimeMs === 0) this.timedOut = true;
    } else {
      this.humanClockStartedAt = null;
    }
    this.notify();
  }

  serialize(): SavedGame {
    return {
      fen: this.chess.fen(),
      sanHistory: this.chess.history(),
      playerColor: this.humanColor,
      resigned: this.resigned,
      humanTimeMs: this.remainingHumanTimeMs,
      humanClockStartedAt: this.humanClockStartedAt === null ? null : Date.now(),
      timedOut: this.timedOut
    };
  }

  get remainingHumanTimeMs(): number {
    if (this.humanClockStartedAt === null) return this.humanTimeMs;
    return Math.max(0, this.humanTimeMs - (Date.now() - this.humanClockStartedAt));
  }

  get isGameOver(): boolean {
    return this.resigned || this.timedOut || this.chess.isGameOver();
  }

  get isHumanTurn(): boolean {
    return !this.isGameOver && !this.thinking && this.chess.turn() === this.humanColor;
  }

  resign(): boolean {
    if (this.isGameOver) return false;
    this.abortBotSearch();
    this.pauseHumanClock();
    this.resigned = true;
    this.notify();
    return true;
  }

  legalMovesFrom(square: Square): Move[] {
    return this.chess.moves({ square, verbose: true }) as Move[];
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
    this.pauseHumanClock();
    this.notify();
    return move;
  }

  /** Pops the bot's reply (if it landed) and the human move under it, so undo
   *  always hands the turn straight back to the human to try something else. */
  undoHumanTurn(): boolean {
    const historyLength = this.chess.history().length;
    if (historyLength === 0) return false;
    // If it is already the human's turn, the latest move was the bot's. A
    // second ply must exist or there is no human move to undo (e.g. the bot's
    // opening move when the person chose black).
    if (this.chess.turn() === this.humanColor && historyLength < 2) return false;
    this.abortBotSearch();
    this.pauseHumanClock();
    this.resigned = false;
    this.timedOut = false;
    this.chess.undo();
    if (this.chess.turn() !== this.humanColor && this.chess.history().length > 0) {
      this.chess.undo();
    }
    if (this.chess.turn() === this.humanColor) this.humanClockStartedAt = Date.now();
    this.notify();
    return true;
  }

  async requestBotMove(difficulty: Difficulty): Promise<Move | null> {
    if (this.isGameOver || this.thinking || this.chess.turn() === this.humanColor) return null;
    const profile = DIFFICULTY_PROFILES[difficulty];
    if (!profile) return null;
    const requestedFen = this.chess.fen();
    const generation = ++this.searchGeneration;
    this.thinking = true;
    this.notify();

    const worker = new Worker(ensureWorkerUrl());
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
        const request: MoveRequest = { id, fen: this.chess.fen(), profile };
        worker.postMessage(request);
      });
      if (!response || generation !== this.searchGeneration) return null;
      if (response.id !== id || this.chess.fen() !== requestedFen) return null;
      if (!response.ok) throw new Error(response.error);
      if (this.isGameOver || this.chess.turn() === this.humanColor) return null;
      try {
        return this.chess.move({ from: response.from, to: response.to, promotion: response.promotion });
      } catch {
        return null;
      }
    } catch {
      // A worker failure must not become an unhandled rejection in the view.
      return null;
    } finally {
      worker.terminate();
      if (this.activeWorker === worker) this.activeWorker = null;
      if (generation === this.searchGeneration) {
        this.cancelActiveRequest = null;
        this.thinking = false;
        if (!this.isGameOver && this.chess.turn() === this.humanColor && this.humanClockStartedAt === null) {
          this.humanClockStartedAt = Date.now();
        }
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

  private pauseHumanClock(): void {
    this.humanTimeMs = this.remainingHumanTimeMs;
    this.humanClockStartedAt = null;
  }
}
