// Bundled standalone by esbuild and injected into main.ts as a source string
// (see esbuild.config.mjs), then turned into a Blob URL at runtime. Must not
// import anything from the plugin itself — only obsidian-free modules.
import { Chess } from "chess.js";
import { findMove } from "./search";
import type { MoveRequest, WorkerResponse } from "./types";

/**
 * Replaying the game gives chess.js the position history the search needs to
 * recognise repetitions. The FEN is the fallback: it always yields a playable
 * position, just one that cannot see a repetition coming.
 */
function buildPosition(fen: string, sanHistory: string[]): Chess {
  if (Array.isArray(sanHistory) && sanHistory.length > 0) {
    try {
      const replay = new Chess();
      for (const san of sanHistory) replay.move(san);
      if (replay.fen() === fen) return replay;
    } catch {
      // fall through to the FEN
    }
  }
  return new Chess(fen);
}

self.onmessage = (e: MessageEvent<MoveRequest>) => {
  const { id, fen, sanHistory, profile } = e.data;
  try {
    const chess = buildPosition(fen, sanHistory);
    const { move, evalCp, depthReached, fromBook } = findMove(chess, profile);
    const response: WorkerResponse = {
      id, ok: true,
      from: move.from, to: move.to,
      promotion: move.promotion,
      evalCp, depthReached, fromBook
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};
