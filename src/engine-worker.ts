// Bundled standalone by esbuild and injected into main.ts as a source string
// (see esbuild.config.mjs), then turned into a Blob URL at runtime. Must not
// import anything from the plugin itself — only obsidian-free modules.
import { Chess } from "chess.js";
import { findMove } from "./search";
import type { MoveRequest, WorkerResponse } from "./types";

self.onmessage = (e: MessageEvent<MoveRequest>) => {
  const { id, fen, profile } = e.data;
  try {
    const chess = new Chess(fen);
    const { move, evalCp, depthReached } = findMove(chess, profile);
    const response: WorkerResponse = {
      id, ok: true,
      from: move.from, to: move.to,
      promotion: move.promotion,
      evalCp, depthReached
    };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};
