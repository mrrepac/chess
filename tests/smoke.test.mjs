import { bundle, load, suite } from "./harness.mjs";
import { readFile } from "node:fs/promises";

/** Runtime smoke test: does the plugin actually wire up without throwing,
 *  not just type-check and bundle cleanly. */
export default async function run() {
  const s = suite("smoke");

  const src = await bundle("src/main.ts");
  const viewSource = await readFile(new URL("../src/view.ts", import.meta.url), "utf8");
  s.check("the contextual action is cleared before its icon and label are rebuilt",
    /actionBtn\.empty\(\);\s+setIcon\(actionBtn/.test(viewSource));

  // Obsidian's createEl/createDiv/createSpan pass `parent: this` to the global
  // helper, so calling one on a *document* asks the DOM to append an element to
  // the document itself, which throws — and the helper builds the element with
  // the main window's document, which breaks a popped-out board. Both are easy
  // to reintroduce: eslint-plugin-obsidianmd actively recommends it. Doing so
  // once already killed the board's render loop on its first piece.
  const piecesSource = await readFile(new URL("../src/pieces.ts", import.meta.url), "utf8");
  s.check("pieces are built with the view's own createElement",
    /doc\.createElement\("img"\)/.test(piecesSource) && !/\bdoc\.create(?:El|Div|Span)\(/.test(piecesSource));
  s.check("the drag preview is too",
    !/\bthis\.doc\.create(?:El|Div|Span)\(/.test(viewSource));

  const registered = [];
  const commands = [];
  let settingTabAdded = false;
  let ribbonAdded = false;
  const savedData = { current: null };

  class PluginStub {
    constructor() {
      this.app = { workspace: { getLeavesOfType: () => [] } };
    }
    registerView(type, factory) { registered.push({ type, factory }); }
    addRibbonIcon() { ribbonAdded = true; return {}; }
    addCommand(cmd) { commands.push(cmd); }
    addSettingTab() { settingTabAdded = true; }
    async loadData() { return savedData.current; }
    async saveData(data) { savedData.current = data; }
  }

  const notices = [];
  const obsidianStub = {
    Plugin: PluginStub,
    // Every string goes through src/i18n.ts, which asks Obsidian for the app's
    // language. "en" is what the plugin ships as by default, so that is what is
    // tested here.
    moment: { locale: () => "en" },
    Notice: class { constructor(message) { notices.push(message); } },
    Modal: class { constructor(app) { this.app = app; } open() {} close() {} },
    ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = { empty() {}, addClass() {}, createDiv: () => ({ createEl: () => ({ addEventListener() {} }), addEventListener() {} }) }; } },
    PluginSettingTab: class { constructor() {} },
    Setting: class {
      setName() { return this; }
      setDesc() { return this; }
      addSlider(cb) { cb({ setLimits: () => ({ setDynamicTooltip: () => ({ setValue: () => ({ onChange: () => {} }) }) }) }); return this; }
      addDropdown(cb) { cb({ addOption: function () { return this; }, setValue: function () { return this; }, onChange: () => {} }); return this; }
    }
  };

  const mod = load(src, { modules: { obsidian: obsidianStub } });
  const ChessBotPlugin = mod.default;

  s.check("main.ts exports a default plugin class", typeof ChessBotPlugin === "function");

  const plugin = new ChessBotPlugin();
  await plugin.onload();

  s.check("registers the chess view", registered.some(r => r.type === "chess-bot-view"));
  s.check("adds a ribbon icon", ribbonAdded);
  s.check("adds a settings tab", settingTabAdded);
  s.check("registers the open-board command", commands.some(c => c.id === "open-board"));
  s.check("loads default settings (difficulty 5)", plugin.settings.difficulty === 5);
  s.check("defaults to a ten-minute clock", plugin.settings.timeControlMinutes === 10);
  s.check("the bot's move arrow is on by default", plugin.settings.showMoveArrow === true);
  s.check("the board follows the player by default", plugin.settings.boardOrientation === "player");
  s.check("creates a game controller with a starting position", () =>
    plugin.controller.chess.fen().startsWith("rnbqkbnr/pppppppp"));

  await plugin.persistGame();
  s.check("persistGame writes a saved game to data.json", () => savedData.current?.savedGame?.fen != null);

  // --- data.json is a file a person can edit ---------------------------------
  const bootWith = async (data) => {
    savedData.current = data;
    const p = new ChessBotPlugin();
    await p.onload();
    return p;
  };

  {
    const p = await bootWith({ difficulty: 42, timeControlMinutes: -5, soundVolume: 900, playerColor: "purple" });
    // A difficulty with no profile behind it made requestBotMove return null
    // without a word, leaving the board stuck on "Ход бота" forever.
    s.check("an out-of-range difficulty is clamped instead of disabling the bot",
      p.settings.difficulty === 10);
    s.check("a negative time control is clamped to no clock", p.settings.timeControlMinutes === 0);
    s.check("volume is clamped to 0-100", p.settings.soundVolume === 100);
    s.check("an unknown colour falls back to the default", p.settings.playerColor === "w");
  }

  {
    // This used to throw straight out of onload and take the whole plugin down.
    const p = await bootWith({
      savedGame: { fen: "not a fen at all", sanHistory: ["e4"], playerColor: "w" }
    });
    s.check("a corrupt saved game starts a fresh one instead of failing to load", () =>
      p.controller.chess.fen().startsWith("rnbqkbnr/pppppppp"));
  }

  // --- adaptive difficulty ---------------------------------------------------
  // One position, two endings: Qd5 stalemates black, Qd8 mates it. Both are
  // played through applyHumanMove, so the game ends the way it does in play.
  const MATE_OR_STALEMATE = "7k/8/6K1/8/8/8/8/3Q4 w - - 0 1";
  const endGameAs = (controller, ending) => {
    const nextDifficulty = controller.resultApplied?.to ?? controller.gameDifficulty;
    controller.newGame("w", controller.clockMs, controller.incrementMs, nextDifficulty);
    controller.chess.load(MATE_OR_STALEMATE);
    controller.applyHumanMove("d1", ending === "win" ? "d8" : "d5");
  };

  const lose = (controller) => {
    const nextDifficulty = controller.resultApplied?.to ?? controller.gameDifficulty;
    controller.newGame("w", controller.clockMs, controller.incrementMs, nextDifficulty);
    controller.resign();
  };

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 3, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    s.check("one win is not enough to move the level",
      p.settings.difficulty === 5 && p.settings.resultStreak === 1);

    endGameAs(p.controller, "win");
    s.check("two wins are not enough either",
      p.settings.difficulty === 5 && p.settings.resultStreak === 2);

    const before = notices.length;
    endGameAs(p.controller, "win");
    s.check("the third win in a row moves the level", p.settings.difficulty === 6);
    s.check("and the streak starts over rather than moving it again next game",
      p.settings.resultStreak === 0);
    s.check("the level change is announced", notices.length === before + 1);
    s.check("the saved game carries what was applied",
      () => savedData.current?.savedGame?.resultApplied?.to === 6);

    p.controller.undoHumanTurn();
    s.check("undoing back into a live game takes the level and the streak back",
      p.settings.difficulty === 5 && p.settings.resultStreak === 2
      && p.controller.resultApplied === null);
  }

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 3, playerColor: "w"
    });
    lose(p.controller); lose(p.controller);
    s.check("losses accumulate as a negative streak", p.settings.resultStreak === -2);
    lose(p.controller);
    s.check("the third loss in a row moves the level down", p.settings.difficulty === 4);
  }

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 3, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    lose(p.controller);
    s.check("a loss after a win starts a fresh streak the other way",
      p.settings.resultStreak === -1 && p.settings.difficulty === 5);
  }

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 3, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    endGameAs(p.controller, "win");
    endGameAs(p.controller, "draw");
    s.check("stalemate breaks the streak without moving the level",
      p.controller.chess.isStalemate() && p.settings.resultStreak === 0
      && p.settings.difficulty === 5);
    endGameAs(p.controller, "win");
    s.check("and the count really did start over", p.settings.resultStreak === 1);
  }

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 1, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    s.check("a threshold of one moves the level every game", p.settings.difficulty === 6);
  }

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 3, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    endGameAs(p.controller, "win");
    await p.setDifficulty(8);
    s.check("choosing a level by hand wipes the streak",
      p.settings.difficulty === 8 && p.settings.resultStreak === 0);
  }

  {
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 3, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    await p.setDifficulty(8);
    p.controller.undoHumanTurn();
    s.check("undo does not revive a streak superseded by a manual level choice",
      p.settings.difficulty === 8 && p.settings.resultStreak === 0
      && p.controller.resultApplied === null);
  }

  {
    const p = await bootWith({
      difficulty: 10, adaptiveDifficulty: true, adaptiveThreshold: 1, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    s.check("a win at the top level stays at the top level", p.settings.difficulty === 10);
  }

  {
    const p = await bootWith({
      difficulty: 1, adaptiveDifficulty: true, adaptiveThreshold: 1, playerColor: "w"
    });
    lose(p.controller);
    s.check("a loss at the bottom level stays at the bottom level", p.settings.difficulty === 1);
  }

  {
    const p = await bootWith({ difficulty: 5, adaptiveDifficulty: false, playerColor: "w" });
    endGameAs(p.controller, "win");
    s.check("with the setting off nothing is counted at all",
      p.settings.difficulty === 5 && p.settings.resultStreak === 0
      && p.controller.resultApplied === null);
  }

  {
    const p = await bootWith({ difficulty: 4, adaptiveDifficulty: false, playerColor: "w" });
    p.controller.newGame("w", p.timeControlMs, p.incrementMs, 4);
    await p.setDifficulty(8);
    p.controller.chess.load(MATE_OR_STALEMATE);
    p.controller.applyHumanMove("d1", "d8");
    s.check("changing the setting does not change the level of a live game",
      () => p.controller.gameDifficulty === 4
        && p.settings.difficulty === 8
        && p.settings.levelStats[4]?.wins === 1
        && p.settings.levelStats[8] === undefined);
  }

  {
    const p = await bootWith({ adaptiveThreshold: 99, resultStreak: "oops" });
    s.check("a hand-edited threshold and streak are clamped",
      p.settings.adaptiveThreshold === 5 && p.settings.resultStreak === 0);
  }

  {
    // A game that was already over when the vault opened must not move the
    // level: its result belongs to the session that played it.
    const p = await bootWith({
      difficulty: 5,
      adaptiveDifficulty: true,
      savedGame: {
        fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
        sanHistory: ["f3", "e5", "g4", "Qh4#"],
        playerColor: "w",
        clockMs: 600000
      }
    });
    const counted = p.controller.resultApplied;
    s.check("a finished game loads already counted", counted !== null && counted.from === counted.to);
    p.controller.undoHumanTurn(); // the first notify this game gets
    s.check("and reopening the vault does not re-apply its result",
      p.settings.difficulty === 5 && p.settings.resultStreak === 0);
  }

  // --- the per-level tally ---------------------------------------------------
  {
    const p = await bootWith({ difficulty: 4, playerColor: "w" });
    endGameAs(p.controller, "win");
    s.check("a finished game lands in the tally for the level it was played at",
      () => JSON.stringify(p.settings.levelStats[4]) === JSON.stringify({ wins: 1, losses: 0, draws: 0 }));

    lose(p.controller);
    endGameAs(p.controller, "draw");
    s.check("losses and draws are counted too",
      () => JSON.stringify(p.settings.levelStats[4]) === JSON.stringify({ wins: 1, losses: 1, draws: 1 }));

    s.check("the tally is saved with the game",
      () => savedData.current?.levelStats?.["4"]?.wins === 1);
    s.check("and the game itself remembers it has been counted",
      () => savedData.current?.savedGame?.statsRecorded?.level === 4);
  }

  {
    const p = await bootWith({ difficulty: 7, playerColor: "w" });
    endGameAs(p.controller, "win");
    p.controller.undoHumanTurn();
    s.check("undoing back into a live game takes the result out of the tally again",
      () => p.settings.levelStats[7] === undefined && p.controller.statsRecorded === null);
  }

  {
    // The result that moves the level belongs to the level it was won at, not
    // to the one it just promoted the person into.
    const p = await bootWith({
      difficulty: 5, adaptiveDifficulty: true, adaptiveThreshold: 1, playerColor: "w"
    });
    endGameAs(p.controller, "win");
    s.check("a win that raises the level is still counted against the old one",
      () => p.settings.difficulty === 6
        && p.settings.levelStats[5]?.wins === 1
        && p.settings.levelStats[6] === undefined);
  }

  {
    const p = await bootWith({ difficulty: 5, adaptiveDifficulty: false, playerColor: "w" });
    endGameAs(p.controller, "win");
    s.check("the tally is kept whether or not the level adapts",
      () => p.settings.levelStats[5]?.wins === 1);
  }

  {
    // Same finished game as the adaptive-difficulty case above: its result
    // belongs to the session that played it, tally included.
    const p = await bootWith({
      difficulty: 5,
      savedGame: {
        fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
        sanHistory: ["f3", "e5", "g4", "Qh4#"],
        playerColor: "w",
        clockMs: 600000
      }
    });
    const empty = Object.keys(p.settings.levelStats).length === 0;
    p.controller.undoHumanTurn();
    s.check("a game that was already over when the vault opened is not counted",
      empty && Object.keys(p.settings.levelStats).length === 0);
  }

  {
    const p = await bootWith({
      levelStats: {
        3: { wins: 2, losses: 1, draws: 0 },
        11: { wins: 5, losses: 0, draws: 0 },
        4: { wins: -3, losses: "нет", draws: 1 },
        7: "не объект"
      }
    });
    s.check("a hand-edited tally keeps what makes sense and drops the rest", () =>
      p.settings.levelStats[3]?.wins === 2
      && p.settings.levelStats[11] === undefined
      && p.settings.levelStats[7] === undefined
      && JSON.stringify(p.settings.levelStats[4]) === JSON.stringify({ wins: 0, losses: 0, draws: 1 }));
  }

  {
    // The defaults are spread into every instance's settings, so a shared
    // object would have one board counting games into another's tally.
    const counted = await bootWith({ difficulty: 2, playerColor: "w" });
    endGameAs(counted.controller, "win");
    const fresh = await bootWith({ difficulty: 2, playerColor: "w" });
    s.check("a fresh install does not inherit another game's tally",
      () => Object.keys(fresh.settings.levelStats).length === 0);
  }

  return s.report();
}
