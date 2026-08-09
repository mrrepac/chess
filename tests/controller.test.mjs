import { bundle, load, suite } from "./harness.mjs";

export default async function run() {
  const s = suite("controller");
  const workers = [];

  class WorkerStub {
    constructor() {
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
  const { GameController } = load(src, { globals: { Worker: WorkerStub } });

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

  {
    const controller = new GameController();
    controller.newGame("b");
    const pending = controller.requestBotMove(1);
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
    const pending = controller.requestBotMove(1);
    const worker = workers.at(-1);
    worker.onmessage({
      data: { id: worker.request.id + 1, ok: true, from: "e2", to: "e4", evalCp: 0, depthReached: 1 }
    });
    const result = await pending;
    s.check("stale or mismatched worker response is ignored",
      result === null && controller.chess.history().length === 0 && !controller.thinking);
  }

  return s.report();
}
