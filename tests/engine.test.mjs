import { Chess } from "chess.js";
import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("engine");

  const typesSrc = await bundle("src/types.ts");
  const { DIFFICULTY_PROFILES } = load(typesSrc);

  const levels = Object.keys(DIFFICULTY_PROFILES).map(Number).sort((a, b) => a - b);
  s.check("difficulty table has 10 levels", levels.length === 10);
  s.check("depth is non-decreasing with level", () =>
    levels.every((lvl, i) => i === 0 || DIFFICULTY_PROFILES[lvl].depth >= DIFFICULTY_PROFILES[levels[i - 1]].depth));
  s.check("blunderChance is non-increasing with level", () =>
    levels.every((lvl, i) => i === 0 || DIFFICULTY_PROFILES[lvl].blunderChance <= DIFFICULTY_PROFILES[levels[i - 1]].blunderChance));
  s.check("top level has no blunder chance", DIFFICULTY_PROFILES[10].blunderChance === 0);
  s.check("bottom level has quiescence off", DIFFICULTY_PROFILES[1].quiescence === false);

  const assetsSrc = await bundle("src/staunty-assets.ts");
  const { STAUNTY_PIECES } = load(assetsSrc);
  const expectedPieces = ["wk", "wq", "wr", "wb", "wn", "wp", "bk", "bq", "br", "bb", "bn", "bp"];
  s.check("Staunty set contains all 12 original SVG pieces", () =>
    expectedPieces.every(key => STAUNTY_PIECES[key]?.startsWith("data:image/svg+xml;base64,")));

  const searchSrc = await bundle("src/search.ts");
  const { findMove } = load(searchSrc);

  s.check("returns a legal move from the starting position", () => {
    const chess = new Chess();
    const { move } = findMove(chess, DIFFICULTY_PROFILES[1], () => 0.99);
    return chess.moves({ verbose: true }).some(m => m.from === move.from && m.to === move.to);
  });

  s.check("finds Fool's Mate (mate in one) at max difficulty", () => {
    const chess = new Chess();
    chess.load("rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2");
    const { move } = findMove(chess, DIFFICULTY_PROFILES[10], () => 0.99);
    chess.move(move);
    return chess.isCheckmate();
  });

  s.check("level 1 blunder branch plays a clearly worse move than the best move", () => {
    // white to move, a free queen capture (Qxd5) is on the board
    const strongChess = new Chess("4k3/8/8/3q4/8/8/8/4K2Q w - - 0 1");
    // topN: 1 pins this to the single best move found, independent of rng
    const strong = findMove(strongChess, { ...DIFFICULTY_PROFILES[1], blunderChance: 0, topN: 1 }, () => 0);

    const weakChess = new Chess("4k3/8/8/3q4/8/8/8/4K2Q w - - 0 1");
    const weak = findMove(weakChess, DIFFICULTY_PROFILES[1], () => 0); // rng=0 always forces the blunder branch

    return weak.evalCp < strong.evalCp;
  });

  return s.report();
}
