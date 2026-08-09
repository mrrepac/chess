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

  const assetsSrc = await bundle("src/piece-assets.ts");
  const { PIECE_IMAGES } = load(assetsSrc);
  const expectedPieces = ["wk", "wq", "wr", "wb", "wn", "wp", "bk", "bq", "br", "bb", "bn", "bp"];
  s.check("the piece set contains all 12 SVG pieces", () =>
    expectedPieces.every(key => PIECE_IMAGES[key]?.startsWith("data:image/svg+xml;base64,")));

  // The vendoring script strips Inkscape's editor state out of the artwork.
  // A drawing that lost a path on the way in would still be a valid data URI.
  s.check("every piece still carries a drawing", () =>
    expectedPieces.every(key => {
      const svg = Buffer.from(PIECE_IMAGES[key].split(",")[1], "base64").toString("utf8");
      return svg.startsWith("<svg") && svg.endsWith("</svg>") && /<path[\s/>]/.test(svg)
        && !svg.includes("sodipodi:") && !svg.includes("inkscape:");
    }));

  // --- the private chess.js API the search is built on -----------------------
  // These pin the assumptions in src/engine-board.ts. If a chess.js upgrade
  // renames or reshapes them, this fails here rather than leaving the bot
  // unable to move inside Obsidian.
  const boardSrc = await bundle("src/engine-board.ts");
  const { hasInternalApi, toAlgebraic } = load(boardSrc);

  s.check("chess.js still exposes the internal search API", () => hasInternalApi(new Chess()));

  s.check("internal move generation matches the public API", () => {
    const positions = [
      new Chess(),
      new Chess("r3k2r/pppq1ppp/2n1bn2/2b1p3/2B1P3/2N2N2/PPPPQPPP/R3K2R w KQkq - 0 8"), // castling both sides
      new Chess("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3"),        // en passant
      new Chess("8/3P2k1/8/8/8/8/6K1/8 w - - 0 1")                                       // promotion
    ];
    return positions.every(chess => {
      const publicMoves = chess.moves({ verbose: true })
        .map(m => `${m.from}${m.to}${m.promotion ?? ""}`).sort();
      const internalMoves = chess._moves({ legal: true })
        .map(m => `${toAlgebraic(m.from)}${toAlgebraic(m.to)}${m.promotion ?? ""}`).sort();
      return publicMoves.join(",") === internalMoves.join(",");
    });
  });

  s.check("internal make/unmake restores the position exactly", () => {
    const chess = new Chess("r3k2r/pppq1ppp/2n1bn2/2b1p3/2B1P3/2N2N2/PPPPQPPP/R3K2R w KQkq - 0 8");
    const before = chess.fen();
    const hashBefore = chess._hash;
    for (const move of chess._moves({ legal: true })) {
      chess._makeMove(move);
      chess._undoMove();
      if (chess.fen() !== before || chess._hash !== hashBefore) return false;
    }
    return true;
  });

  const rulesSrc = await bundle("src/rules.ts");
  // The reasons are localized, so the module now reaches for the app language.
  const enObsidian = { moment: { locale: () => "en" } };
  const ruObsidian = { moment: { locale: () => "ru" } };
  const { illegalMoveReason } = load(rulesSrc, { modules: { obsidian: enObsidian } });

  s.check("illegal moves explain blockers and king safety", () => {
    const opening = new Chess();
    const blocked = illegalMoveReason(opening, "c1", "h6");
    const pawn = illegalMoveReason(opening, "e2", "f3");
    const pinned = new Chess("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
    const exposesKing = illegalMoveReason(pinned, "e2", "f2");
    return blocked === "The piece's path is blocked."
      && pawn === "A pawn moves forward and captures diagonally."
      && exposesKing === "The king would be left in check.";
  });

  // The catalogue wants an English interface; the Russian one is what this
  // vault actually plays in. A key present in one table and missing from the
  // other would surface as an English string in a Russian sentence.
  const ruRules = load(rulesSrc, { modules: { obsidian: ruObsidian } });
  s.check("a Russian app gets the Russian reason", () =>
    ruRules.illegalMoveReason(new Chess(), "c1", "h6") === "Путь фигуры перекрыт.");

  const searchSrc = await bundle("src/search.ts");
  const { findMove, rankRootMoves } = load(searchSrc);

  const isLegal = (chess, move) =>
    chess.moves({ verbose: true }).some(m =>
      m.from === move.from && m.to === move.to && (m.promotion ?? undefined) === move.promotion);

  s.check("returns a legal move from the starting position", () => {
    const chess = new Chess();
    const { move } = findMove(chess, DIFFICULTY_PROFILES[1], () => 0.99);
    return isLegal(chess, move);
  });

  s.check("every difficulty returns a legal move", () =>
    levels.every(lvl => {
      const chess = new Chess("r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2P1PN2/PP1NBPPP/R1BQ1RK1 w - - 0 10");
      return isLegal(chess, findMove(chess, DIFFICULTY_PROFILES[lvl], () => 0.99).move);
    }));

  s.check("finds Fool's Mate (mate in one) at max difficulty", () => {
    const chess = new Chess();
    chess.load("rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2");
    const { move } = findMove(chess, DIFFICULTY_PROFILES[10], () => 0.99);
    chess.move(move);
    return chess.isCheckmate();
  });

  s.check("promotes when promotion is the winning move", () => {
    const chess = new Chess("8/3P2k1/8/8/8/8/6K1/8 w - - 0 1");
    const { move } = findMove(chess, DIFFICULTY_PROFILES[8], () => 0.99);
    return move.from === "d7" && move.to === "d8" && move.promotion === "q";
  });

  // --- the ranking defect this rewrite was built around ----------------------
  // With a narrowing root window every move after the best one scored exactly
  // the best move's score, so "one of the top N" degenerated into "any move".
  s.check("root ranking has real spread, not one score repeated", () => {
    // Rxa8+ wins a rook; every other move is worse, and by differing amounts.
    // The old narrowing root window gave all 15 moves the *same* score, so
    // "one of the top N" was really "any of the 15".
    const chess = new Chess("r3k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    const ranked = rankRootMoves(chess, DIFFICULTY_PROFILES[5]);
    const distinct = new Set(ranked.map(r => r.score)).size;
    const best = ranked[0];
    // Symmetric moves legitimately tie, so this is about there being groups at
    // all: it used to be exactly 1 distinct score across all 15 moves.
    return distinct >= 5
      && best.move.from === "a1" && best.move.to === "a8"
      && ranked[1].score < best.score
      && best.score - ranked[ranked.length - 1].score > 500;
  });

  s.check("the second-best root move is genuinely second-best", () => {
    // Level 5 plays one of the top two, so what sits at index 1 matters. With
    // a flat ranking it was whatever move generation happened to emit next
    // (Ra2); it should be a rook developing move that keeps the material.
    const chess = new Chess("r3k3/8/8/8/8/8/8/R3K3 w - - 0 1");
    const ranked = rankRootMoves(chess, DIFFICULTY_PROFILES[5]);
    const second = `${ranked[1].move.from}${ranked[1].move.to}`;
    return second !== "a1a2" && ranked[1].score > ranked[ranked.length - 1].score;
  });

  s.check("top levels vary their opening instead of replaying one game", () => {
    const openings = new Set();
    for (let i = 0; i < 25; i++) {
      const chess = new Chess();
      const { move } = findMove(chess, DIFFICULTY_PROFILES[9]);
      openings.add(`${move.from}${move.to}`);
    }
    return openings.size > 1;
  });

  s.check("a clearly best move is still played despite that variation", () => {
    for (let i = 0; i < 10; i++) {
      const chess = new Chess("r3k3/8/8/8/8/8/8/R3K3 w - - 0 1");
      const { move } = findMove(chess, DIFFICULTY_PROFILES[9]);
      if (move.from !== "a1" || move.to !== "a8") return false;
    }
    return true;
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

  s.check("keeps inside its time budget", () => {
    const chess = new Chess("r1bq1rk1/pp1nbppp/2n1p3/2ppP3/3P1P2/2NB1N2/PPP3PP/R1BQ1RK1 w - - 0 9");
    const profile = DIFFICULTY_PROFILES[10];
    const started = Date.now();
    findMove(chess, profile, () => 0.99);
    // The deadline is polled every 512 nodes, so a little overshoot is normal;
    // the old search blew past its budget by 6-12x.
    return Date.now() - started < profile.timeBudgetMs * 1.5;
  });

  // --- repetition bookkeeping ----------------------------------------------
  s.check("leaves the board exactly as it found it", () => {
    // The repetition counter is updated on every make/unmake; a mismatch there
    // silently corrupts the position the caller still owns.
    const chess = new Chess("r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2P1PN2/PP1NBPPP/R1BQ1RK1 w - - 0 10");
    const before = chess.fen();
    const historyBefore = chess.history().join(" ");
    findMove(chess, DIFFICULTY_PROFILES[8], () => 0.99);
    return chess.fen() === before && chess.history().join(" ") === historyBefore;
  });

  s.check("a second occurrence is not scored as a threefold draw", () => {
    const chess = new Chess("4k3/8/8/8/8/8/4K3/3Q4 w - - 0 1");
    const repeated = new Chess(chess.fen());
    repeated.move({ from: "d1", to: "d2" });
    // Pretend the child position has occurred once before. Making Qd2 during
    // search brings its count to two, which is not yet a claimable draw.
    chess._positionCount.set(repeated._hash, 1);
    const profile = {
      ...DIFFICULTY_PROFILES[1], depth: 1, quiescence: false,
      topN: 1, blunderChance: 0, openingBook: false
    };
    const result = rankRootMoves(chess, profile)
      .find(entry => entry.move.from === "d1" && entry.move.to === "d2");
    return result && result.score > 500;
  });

  // --- opening book ---------------------------------------------------------
  const bookSrc = await bundle("src/opening-book.ts");
  const { openingBook, bookMove, brokenBookLines } = load(bookSrc);

  s.check("every line in the book plays to its end", () => {
    // buildBook() drops the rest of a line it cannot play, so a typo would
    // silently shorten the book rather than fail. It records what it dropped.
    const broken = brokenBookLines();
    return broken.length === 0;
  }, brokenBookLines().join(" | "));

  s.check("the book answers the starting position with real first moves", () => {
    const moves = openingBook().get("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    const played = moves?.map(m => `${m.from}${m.to}`).sort().join(",");
    return played === "c2c4,d2d4,e2e4,g1f3";
  });

  s.check("every book move is legal in the position it is filed under", () => {
    for (const [key, moves] of openingBook()) {
      const chess = new Chess(`${key} 0 1`);
      const legal = new Set(chess.moves({ verbose: true }).map(m => `${m.from}${m.to}`));
      for (const move of moves) {
        if (!legal.has(`${move.from}${move.to}`)) return false;
      }
    }
    return true;
  });

  s.check("the book runs out instead of guessing", () => {
    const chess = new Chess();
    // A first move no line starts with: the book must have nothing to say.
    chess.move("h4");
    return bookMove(chess) === null;
  });

  s.check("levels with the book on play it, levels without it do not", () => {
    const withBook = findMove(new Chess(), DIFFICULTY_PROFILES[8], () => 0.5);
    const without = findMove(new Chess(), DIFFICULTY_PROFILES[1], () => 0.5);
    return withBook.fromBook === true && !without.fromBook;
  });

  s.check("the book varies the opening rather than repeating one move", () => {
    const first = new Set();
    for (let i = 0; i < 30; i++) {
      first.add(JSON.stringify(findMove(new Chess(), DIFFICULTY_PROFILES[10]).move));
    }
    return first.size >= 3;
  });

  s.check("a book move costs no thinking time", () => {
    const started = Date.now();
    findMove(new Chess(), DIFFICULTY_PROFILES[10], () => 0.5);
    // Level 10 would otherwise spend its whole four-second budget on move one.
    return Date.now() - started < 250;
  });

  s.check("a game history full of repetitions does not derail the search", () => {
    const chess = new Chess();
    // Shuffle knights back and forth: the same position occurs several times.
    for (const san of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) chess.move(san);
    const { move } = findMove(chess, DIFFICULTY_PROFILES[7], () => 0.99);
    return isLegal(chess, move);
  });

  return s.report();
}
