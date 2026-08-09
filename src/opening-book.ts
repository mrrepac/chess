import { Chess, type Move } from "chess.js";
import type { SearchMove } from "./search";

/**
 * A small opening book, written as mainline theory in SAN and turned into a
 * position table at runtime.
 *
 * Why it exists: the search has no idea what an opening is. Left to itself it
 * spends its whole time budget on move one, and — because the top levels always
 * play the highest-scoring move — it tends to walk into the same few positions
 * game after game. A book fixes both for a few kilobytes, which is far cheaper
 * than the extra ply of depth it would take to get the same effect.
 *
 * Lines rather than a position dump: this is ordinary published theory anyone
 * can write down, it stays readable and editable, and transpositions merge by
 * themselves because the table is keyed by position.
 */
const BOOK_LINES = [
  // --- 1.e4 e5 ---
  "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6",       // Ruy Lopez, Morphy Defence
  "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6",     // Ruy Lopez, Exchange
  "e4 e5 Nf3 Nc6 Bb5 Nf6",              // Ruy Lopez, Berlin
  "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6",       // Italian Game
  "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5",       // Two Knights
  "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6",     // Scotch
  "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4",     // Petroff
  "e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7",       // Philidor
  "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4",      // Four Knights
  "e4 e5 Nc3 Nf6 f4 d5",                // Vienna
  "e4 e5 Bc4 Nf6 d3 Bc5",               // Bishop's Opening
  "e4 e5 f4 exf4 Nf3 g5",               // King's Gambit Accepted

  // --- 1.e4 c5 ---
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6",  // Najdorf
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6",  // Dragon
  "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5", // Sveshnikov
  "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nf6 Nc3 d6",  // Scheveningen
  "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7",           // Closed Sicilian
  "e4 c5 c3 d5 exd5 Qxd5 d4 Nf6",          // Alapin
  "e4 c5 Nf3 d6 Bb5+ Bd7",                 // Moscow Variation

  // --- 1.e4 e6 ---
  "e4 e6 d4 d5 Nc3 Bb4 e5 c5",          // French, Winawer
  "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7",        // French, Classical
  "e4 e6 d4 d5 Nd2 c5 exd5 exd5",       // French, Tarrasch
  "e4 e6 d4 d5 e5 c5 c3 Nc6",           // French, Advance
  "e4 e6 d4 d5 exd5 exd5 Nf3 Nf6",      // French, Exchange

  // --- 1.e4 c6 ---
  "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5",      // Caro-Kann, Classical
  "e4 c6 d4 d5 e5 Bf5 Nf3 e6",          // Caro-Kann, Advance
  "e4 c6 d4 d5 exd5 cxd5 c4 Nf6",       // Panov Attack
  "e4 c6 Nf3 d5 Nc3 Bg4",               // Caro-Kann, Two Knights

  // --- other replies to 1.e4 ---
  "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7",        // Pirc
  "e4 g6 d4 Bg7 Nc3 d6 Nf3 Nf6",        // Modern
  "e4 Nf6 e5 Nd5 d4 d6 Nf3 g6",         // Alekhine
  "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6",     // Scandinavian

  // --- 1.d4 d5 ---
  "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7",        // Queen's Gambit Declined
  "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6",        // Queen's Gambit Accepted
  "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4",       // Slav
  "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6",         // Semi-Slav
  "d4 d5 c4 e6 Nc3 c5",                 // Tarrasch Defence
  "d4 d5 c4 e6 Nf3 Nf6 g3 Be7",         // Catalan
  "d4 d5 Nf3 Nf6 Bf4 e6",               // London System

  // --- 1.d4 Nf6 ---
  "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O",        // Nimzo-Indian
  "d4 Nf6 c4 e6 Nf3 b6 g3 Ba6",         // Queen's Indian
  "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6",         // King's Indian
  "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5",      // Grünfeld
  "d4 Nf6 c4 c5 d5 b5",                 // Benko Gambit
  "d4 Nf6 Nf3 g6 Bf4 Bg7",              // London vs the King's Indian

  // --- Dutch ---
  "d4 f5 g3 Nf6 Bg2 g6",                // Leningrad Dutch
  "d4 e6 c4 f5 Nc3 Nf6",                // Dutch by transposition

  // --- flank openings ---
  "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5",        // English, Four Knights
  "c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6",        // Symmetrical English
  "c4 Nf6 Nc3 e6 e4 c5",                // English, Mikenas
  "c4 e6 Nc3 d5 d4 Nf6",                // English into the QGD
  "Nf3 d5 d4 Nf6 c4 e6",                // Réti into the QGD
  "Nf3 Nf6 c4 g6 Nc3 d5",               // Réti, King's Indian setup
  "Nf3 c5 c4 Nc6 Nc3 g6"                // Réti into the English
];

/** Longest line above, in plies. Positions past this cannot be in the book, so
 *  the lookup can answer without building the table at all. */
const MAX_BOOK_PLY = 10;

let book: Map<string, SearchMove[]> | null = null;
/** Lines buildBook() could not play to the end. Always empty in a shipped
 *  build — tests/engine.test.mjs fails on anything in here, which is how a
 *  typo in the table above gets caught instead of silently truncating a line. */
const brokenLines: string[] = [];

/** Piece placement, side to move, castling rights and en passant square — the
 *  whole position, minus the move counters that a transposition would differ in. */
function positionKey(fen: string): string {
  return fen.split(" ", 4).join(" ");
}

function buildBook(): Map<string, SearchMove[]> {
  const table = new Map<string, SearchMove[]>();
  for (const line of BOOK_LINES) {
    const chess = new Chess();
    for (const san of line.split(" ")) {
      const key = positionKey(chess.fen());
      let move: Move;
      try {
        move = chess.move(san);
      } catch {
        brokenLines.push(`${line} (at ${san})`);
        break;
      }
      const entry = table.get(key);
      if (!entry) table.set(key, [{ from: move.from, to: move.to }]);
      else if (!entry.some(m => m.from === move.from && m.to === move.to)) {
        entry.push({ from: move.from, to: move.to });
      }
    }
  }
  return table;
}

/** Exposed for the test that checks every line is legal from move one. */
export function openingBook(): Map<string, SearchMove[]> {
  return (book ??= buildBook());
}

/** Lines that did not survive the replay. Build the book first. */
export function brokenBookLines(): string[] {
  openingBook();
  return brokenLines;
}

/**
 * A book move for this position, chosen at random among the ones theory gives,
 * or null once the game has left the book. Picking at random is the point as
 * much as the theory is: it is what stops the top levels replaying one game.
 */
export function bookMove(chess: Chess, rng: () => number = Math.random): SearchMove | null {
  const ply = (chess.moveNumber() - 1) * 2 + (chess.turn() === "w" ? 0 : 1);
  if (ply >= MAX_BOOK_PLY) return null;
  const moves = openingBook().get(positionKey(chess.fen()));
  if (!moves || moves.length === 0) return null;
  return moves[Math.floor(rng() * moves.length)];
}
