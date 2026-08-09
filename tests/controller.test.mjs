import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("controller");
  const workers = [];
  let workerConstructorThrows = false;

  class WorkerStub {
    constructor() {
      if (workerConstructorThrows) throw new Error("Worker is not available");
      this.terminated = false;
      this.request = null;
      workers.push(this);
    }

    postMessage(request) {
      this.request = request;
    }

    terminate() {
      this.terminated = true;
    }
  }

  const src = await bundle("src/game-controller.ts", {
    ENGINE_WORKER_SOURCE: JSON.stringify("")
  });
  const { GameController, DEFAULT_CLOCK_MINUTES } = load(src, { globals: { Worker: WorkerStub } });

  s.check("restore rebuilds move history and undo state", () => {
    const original = new GameController();
    original.chess.move("e4");
    original.chess.move("e5");
    original.chess.move("Nf3");

    const restored = new GameController();
    restored.restore(original.serialize());
    const historyRestored = restored.chess.history().join(" ") === "e4 e5 Nf3";
    const undoWorked = restored.undoHumanTurn();
    return historyRestored && undoWorked && restored.chess.history().join(" ") === "e4 e5";
  });

  s.check("resignation survives serialization", () => {
    const original = new GameController();
    original.resign();
    const restored = new GameController();
    restored.restore(original.serialize());
    return restored.resigned && restored.isGameOver;
  });

  s.check("human clock expiry ends and survives the game", () => {
    const original = new GameController();
    original.humanTimeMs = 0;
    original.humanClockStartedAt = Date.now() - 1;
    const expired = original.expireHumanClock();

    const restored = new GameController();
    restored.restore(original.serialize());
    return expired && original.isGameOver && restored.timedOut && restored.remainingHumanTimeMs === 0;
  });

  s.check("the clock does not run while the plugin is not loaded", () => {
    const original = new GameController();
    original.newGame("w");
    original.humanTimeMs = 90_000;
    original.humanClockStartedAt = Date.now();
    const saved = original.serialize();
    // Simulate the vault being closed for a day before the save is read back.
    saved.humanTimeMs = 90_000;

    const restored = new GameController();
    restored.restore(saved);
    return restored.remainingHumanTimeMs === 90_000 && !restored.timedOut;
  });

  s.check("pausing and resuming only counts time at the board", async () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.applyHumanMove("e2", "e4");
    controller.chess.move("e5");
    controller.humanTimeMs = 60_000;
    controller.humanClockStartedAt = Date.now() - 5_000;
    controller.pauseHumanClock();
    const afterPause = controller.remainingHumanTimeMs;
    await new Promise(resolve => setTimeout(resolve, 30));
    const stillPaused = controller.remainingHumanTimeMs === afterPause;
    controller.resumeHumanClock();
    return stillPaused && afterPause <= 55_000 && controller.humanClockStartedAt !== null;
  });

  s.check("closing one of two boards keeps the shared clock running", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.applyHumanMove("e2", "e4");
    controller.chess.move("e5");
    controller.openBoard();
    controller.openBoard();
    controller.closeBoard();
    const stillRunning = controller.humanClockStartedAt !== null;
    controller.closeBoard();
    return stillRunning && controller.humanClockStartedAt === null;
  });

  // --- the clock starts with the first move, not with the game --------------
  s.check("a fresh game does not start the clock", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.resumeHumanClock();
    return !controller.clockStarted
      && controller.humanClockStartedAt === null
      && controller.remainingHumanTimeMs === controller.clockMs;
  });

  s.check("sitting on the initial position costs nothing", async () => {
    const controller = new GameController();
    controller.newGame("w", 60_000);
    controller.resumeHumanClock();
    await new Promise(resolve => setTimeout(resolve, 40));
    return controller.remainingHumanTimeMs === 60_000;
  });

  s.check("the clock runs once the person has played", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.applyHumanMove("e2", "e4");
    controller.chess.move("e5"); // the bot replies, handing the turn back
    controller.resumeHumanClock();
    return controller.clockStarted && controller.humanClockStartedAt !== null;
  });

  s.check("playing black, the bot's opening move does not start the clock", () => {
    const controller = new GameController();
    controller.newGame("b");
    controller.chess.move("e4"); // bot opens; the person has still not moved
    controller.resumeHumanClock();
    return !controller.clockStarted && controller.humanClockStartedAt === null;
  });

  s.check("a restored mid-game position knows the clock has started", () => {
    const controller = new GameController();
    controller.restore({
      fen: "r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2P1PN2/PP1NBPPP/R1BQ1RK1 w - - 0 10",
      sanHistory: [],
      playerColor: "w",
      clockMs: 600_000,
      humanTimeMs: 400_000
    });
    // No SAN history to replay: the ply count has to come from the position.
    controller.resumeHumanClock();
    return controller.clockStarted && controller.humanClockStartedAt !== null;
  });

  s.check("a game with no clock never times out", () => {
    const controller = new GameController();
    controller.newGame("w", 0);
    return !controller.clockEnabled
      && controller.remainingHumanTimeMs === Infinity
      && !controller.expireHumanClock()
      && !controller.isGameOver;
  });

  s.check("undo after a loss on time gives back a playable clock", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.chess.move("e4");
    controller.chess.move("e5");
    controller.humanTimeMs = 0;
    controller.humanClockStartedAt = null;
    controller.timedOut = true;

    const undone = controller.undoHumanTurn();
    // Used to re-expire on the very next clock tick and replay the loss sound.
    return undone && !controller.timedOut && controller.remainingHumanTimeMs > 0;
  });

  s.check("the clock survives a round trip through settings", () => {
    const original = new GameController();
    original.newGame("w", 5 * 60 * 1000);
    const restored = new GameController();
    restored.restore(original.serialize());
    return restored.clockMs === 5 * 60 * 1000 && restored.remainingHumanTimeMs === 5 * 60 * 1000;
  });

  s.check("default clock is the documented ten minutes", DEFAULT_CLOCK_MINUTES === 10);

  // --- Fischer increment ----------------------------------------------------
  s.check("the increment is credited after each of the person's moves", () => {
    const controller = new GameController();
    controller.newGame("w", 60_000, 5_000);
    controller.applyHumanMove("e2", "e4");
    return controller.remainingHumanTimeMs === 65_000;
  });

  s.check("undo takes the increment back", () => {
    // Otherwise a move could be played and taken back over and over to print
    // clock time out of nothing.
    const controller = new GameController();
    controller.newGame("w", 60_000, 5_000);
    for (let i = 0; i < 5; i++) {
      controller.applyHumanMove("e2", "e4");
      controller.undoHumanTurn();
    }
    return controller.remainingHumanTimeMs === 60_000;
  });

  s.check("no clock means no increment", () => {
    const controller = new GameController();
    controller.newGame("w", 0, 5_000);
    controller.applyHumanMove("e2", "e4");
    return controller.remainingHumanTimeMs === Infinity && controller.humanTimeMs === 0;
  });

  s.check("the increment survives a round trip through settings", () => {
    const original = new GameController();
    original.newGame("w", 300_000, 3_000);
    const restored = new GameController();
    restored.restore(original.serialize());
    return restored.incrementMs === 3_000;
  });

  s.check("the game keeps its starting difficulty through serialization", () => {
    const original = new GameController();
    original.newGame("w", 300_000, 0, 8);
    const restored = new GameController();
    restored.restore(original.serialize(), 2);
    return original.serialize().difficulty === 8 && restored.gameDifficulty === 8;
  });

  // --- a save a person can break by hand ------------------------------------
  s.check("a corrupt FEN falls back to a fresh game instead of throwing", () => {
    const controller = new GameController();
    const ok = controller.restore({ fen: "}{ not a fen", sanHistory: [], playerColor: "b" });
    return ok === false
      && controller.chess.fen().startsWith("rnbqkbnr/pppppppp")
      && controller.humanColor === "b";
  });

  s.check("the highlighted move survives a reload without rebuilding the history", () => {
    const original = new GameController();
    original.newGame("w");
    original.applyHumanMove("e2", "e4");
    const restored = new GameController();
    restored.restore(original.serialize());
    return original.lastMove?.san === "e4" && restored.lastMove?.san === "e4";
  });

  s.check("undo puts the highlight back on the move before it", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.applyHumanMove("e2", "e4");
    controller.chess.move("e5");
    controller.applyHumanMove("g1", "f3");
    controller.chess.move("Nc6");
    controller.undoHumanTurn();
    return controller.lastMove?.san === "e5";
  });

  s.check("history browsing never changes the live game", () => {
    const controller = new GameController();
    controller.newGame("w");
    for (const san of ["e4", "e5", "Nf3", "Nc6"]) controller.chess.move(san);
    const liveFen = controller.chess.fen();
    const viewed = controller.positionAtPly(2);
    return viewed.chess.history().join(" ") === "e4 e5"
      && viewed.lastMove?.san === "e5"
      && controller.chess.fen() === liveFen
      && controller.chess.history().join(" ") === "e4 e5 Nf3 Nc6";
  });

  // --- what the undo button is allowed to say about itself ------------------
  s.check("nothing to undo on a fresh board", () => {
    const controller = new GameController();
    controller.newGame("w");
    return !controller.canUndo && !controller.undoHumanTurn();
  });

  s.check("playing black, the bot's opening move alone is not undoable", () => {
    const controller = new GameController();
    controller.newGame("b");
    controller.chess.move("e4");
    return !controller.canUndo && !controller.undoHumanTurn();
  });

  s.check("a played move is undoable", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.applyHumanMove("e2", "e4");
    return controller.canUndo;
  });

  s.check("resigning on move one can still be taken back", () => {
    // The button used to refuse — there was no move under the resignation to
    // pop — while the confirmation box promised undo was the way out of it.
    const controller = new GameController();
    controller.newGame("w");
    controller.resign();
    const canUndo = controller.canUndo;
    const undone = controller.undoHumanTurn();
    return canUndo && undone
      && !controller.resigned
      && !controller.isGameOver
      && controller.chess.history().length === 0;
  });

  s.check("lifting a resignation on move one does not print clock time", () => {
    const controller = new GameController();
    controller.newGame("w", 60_000, 5_000);
    controller.resign();
    controller.undoHumanTurn();
    return controller.remainingHumanTimeMs === 60_000;
  });

  // --- the result adaptive difficulty reads ---------------------------------
  s.check("outcome is null while the game is live", () => {
    const controller = new GameController();
    controller.newGame("w");
    return controller.outcome === null;
  });

  s.check("resigning and running out of time both read as a loss", () => {
    const resignation = new GameController();
    resignation.newGame("w");
    resignation.resign();

    const expiry = new GameController();
    expiry.newGame("w");
    expiry.humanTimeMs = 0;
    expiry.expireHumanClock();

    return resignation.outcome === "loss" && expiry.outcome === "loss";
  });

  s.check("checkmate is read from the side that has to move", () => {
    const win = new GameController();
    win.newGame("w");
    win.chess.load("7k/8/6K1/8/8/8/8/3Q4 w - - 0 1");
    win.applyHumanMove("d1", "d8");

    const loss = new GameController();
    loss.newGame("b");
    loss.chess.load("7k/8/6K1/8/8/8/8/3Q4 w - - 0 1");
    loss.chess.move({ from: "d1", to: "d8" });

    return win.outcome === "win" && loss.outcome === "loss";
  });

  s.check("stalemate is a draw", () => {
    const controller = new GameController();
    controller.newGame("w");
    controller.chess.load("7k/8/6K1/8/8/8/8/3Q4 w - - 0 1");
    controller.applyHumanMove("d1", "d5");
    return controller.chess.isStalemate() && controller.outcome === "draw";
  });

  s.check("a save from before the clock rework still loads", () => {
    // data.json written by 0.1.0: no clockMs, and a wall-clock anchor that the
    // old restore() used to subtract elapsed real time from.
    const legacy = {
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      sanHistory: ["e4", "e5"],
      playerColor: "w",
      resigned: false,
      humanTimeMs: 534484,
      humanClockStartedAt: Date.now() - 86_400_000,
      timedOut: false
    };
    const controller = new GameController();
    controller.restore(legacy);
    return controller.chess.history().join(" ") === "e4 e5"
      && controller.clockMs === DEFAULT_CLOCK_MINUTES * 60 * 1000
      && controller.remainingHumanTimeMs === 534484
      && !controller.timedOut;
  });

  {
    const controller = new GameController();
    controller.newGame("b");
    const pending = controller.requestBotMove();
    const worker = workers.at(-1);

    controller.newGame("w");
    const result = await pending;
    s.check("new game cancels a pending bot move", result === null
      && worker.terminated
      && !controller.thinking
      && controller.chess.history().length === 0
      && controller.humanColor === "w");
  }

  {
    const controller = new GameController();
    controller.newGame("b");
    const pending = controller.requestBotMove();
    const worker = workers.at(-1);
    worker.onmessage({
      data: { id: worker.request.id + 1, ok: true, from: "e2", to: "e4", evalCp: 0, depthReached: 1 }
    });
    const result = await pending;
    s.check("stale or mismatched worker response is ignored",
      result === null && controller.chess.history().length === 0 && !controller.thinking);
  }

  {
    const controller = new GameController();
    controller.newGame("b", controller.clockMs, controller.incrementMs, 3);
    const pending = controller.requestBotMove();
    const worker = workers.at(-1);
    s.check("the bot request carries the game history for repetition detection",
      Array.isArray(worker.request.sanHistory));
    s.check("the bot request uses the level fixed for this game",
      worker.request.profile.depth === 2 && worker.request.profile.timeBudgetMs === 400);
    worker.onmessage({
      data: { id: worker.request.id, ok: true, from: "e2", to: "e4", evalCp: 42, depthReached: 3 }
    });
    await pending;
    s.check("the engine's evaluation of its move is kept for display",
      controller.lastEval?.cp === 42 && controller.lastEval?.depth === 3);
    controller.applyHumanMove("e7", "e5");
    s.check("a human move clears the previous engine evaluation",
      controller.lastEval === null && controller.lastMoveFromBook === false);
  }

  {
    // A Worker that cannot even be constructed used to escape as an unhandled
    // rejection, leaving the board stuck on "thinking" with nothing shown.
    workerConstructorThrows = true;
    const controller = new GameController();
    controller.newGame("b");
    const result = await controller.requestBotMove();
    workerConstructorThrows = false;
    s.check("a worker that cannot start reports instead of hanging",
      result === null && !controller.thinking && typeof controller.engineError === "string");
  }

  return s.report();
}
