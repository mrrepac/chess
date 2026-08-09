import { Notice, Plugin } from "obsidian";
import { ChessSettingTab } from "./settings";
import { GameController } from "./game-controller";
import { ChessView, VIEW_TYPE_CHESS } from "./view";
import {
  clampAdaptiveThreshold, clampDifficulty, DEFAULT_SETTINGS, describeRecord, MAX_DIFFICULTY,
  MIN_DIFFICULTY, sanitizeLevelStats
} from "./types";
import type { ChessBotSettings, Difficulty, GameOutcome, LevelRecord } from "./types";

/** Well past the longest the settings tab offers. Only there to keep a nonsense
 *  value out of the clock arithmetic; the dropdown tops out at an hour. */
const MAX_TIME_CONTROL_MINUTES = 180;

export default class ChessBotPlugin extends Plugin {
  settings: ChessBotSettings;
  controller: GameController;

  async onload() {
    await this.loadSettings();

    this.controller = new GameController();
    if (this.settings.savedGame) this.controller.restore(this.settings.savedGame);
    else {
      this.controller.newGame(
        this.settings.playerColor === "b" ? "b" : "w", this.timeControlMs, this.incrementMs
      );
    }
    this.controller.onChange(() => this.onGameChanged());

    this.registerView(VIEW_TYPE_CHESS, (leaf) => new ChessView(leaf, this));
    this.addRibbonIcon("crown", "Открыть шахматы", () => this.activateView());

    this.addCommand({
      id: "open-chess",
      name: "Открыть доску",
      callback: () => this.activateView()
    });

    this.addSettingTab(new ChessSettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHESS)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CHESS, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  get timeControlMs(): number {
    return this.settings.timeControlMinutes * 60 * 1000;
  }

  get incrementMs(): number {
    return this.settings.incrementSeconds * 1000;
  }

  /** Setting the level by hand is a statement about where you want to play, so
   *  it also wipes the streak — otherwise two old wins would immediately push
   *  the level past the one just chosen. */
  async setDifficulty(level: Difficulty): Promise<void> {
    this.settings.difficulty = clampDifficulty(level);
    this.settings.resultStreak = 0;
    await this.saveSettings();
  }

  /** "Побед 4 · поражений 2 · ничьих 1" at one level, for the board and the
   *  settings tab. Empty for a level with no finished games behind it. */
  describeLevelRecord(level: Difficulty): string {
    return describeRecord(this.settings.levelStats[level]);
  }

  /** " · побед подряд: 2 из 3" for the difficulty button's tooltip. */
  describeStreak(): string {
    if (!this.settings.adaptiveDifficulty) return "";
    const streak = this.settings.resultStreak;
    if (streak === 0) return "";
    const threshold = this.settings.adaptiveThreshold;
    const word = streak > 0 ? "побед" : "поражений";
    return ` · ${word} подряд: ${Math.abs(streak)} из ${threshold}`;
  }

  /**
   * Runs on every controller notification. The tally is settled before adaptive
   * difficulty gets a look in, so a game is counted against the level it was
   * actually played at rather than the one its own result just moved it to.
   */
  private onGameChanged(): void {
    const counted = this.syncLevelStats();
    const levelMoved = this.syncAdaptiveDifficulty();
    if (counted || levelMoved) void this.persistGame();
  }

  /**
   * Keeps the per-level tally in step with the game on the board, on the same
   * terms as adaptive difficulty: a result counts once, a game that was already
   * over when the vault opened counts for nothing, and undoing back into a live
   * position takes the result back out of the counters.
   *
   * Returns whether anything changed, so the caller can decide to save.
   */
  private syncLevelStats(): boolean {
    const recorded = this.controller.statsRecorded;

    if (!this.controller.isGameOver) {
      if (!recorded) return false;
      this.adjustLevelRecord(recorded.level, recorded.outcome, -1);
      this.controller.statsRecorded = null;
      return true;
    }

    if (recorded) return false;
    const outcome = this.controller.outcome;
    if (!outcome) return false; // e.g. the engine failed to start: not a result

    const level = this.settings.difficulty;
    this.adjustLevelRecord(level, outcome, 1);
    this.controller.statsRecorded = { level, outcome };
    return true;
  }

  /** Moves one counter by one game. A level of 0 is the "belongs to no bucket"
   *  marker a pre-existing finished game carries, and touches nothing. */
  private adjustLevelRecord(level: number, outcome: GameOutcome, delta: 1 | -1): void {
    if (!Number.isInteger(level) || level < MIN_DIFFICULTY || level > MAX_DIFFICULTY) return;
    const key = level as Difficulty;
    const record: LevelRecord = this.settings.levelStats[key] ?? { wins: 0, losses: 0, draws: 0 };
    const counter = outcome === "win" ? "wins" : outcome === "loss" ? "losses" : "draws";
    record[counter] = Math.max(0, record[counter] + delta);
    if (record.wins + record.losses + record.draws === 0) delete this.settings.levelStats[key];
    else this.settings.levelStats[key] = record;
  }

  /**
   * Adaptive difficulty: the level moves a step once the same result comes up
   * `adaptiveThreshold` games in a row. A draw of any kind — stalemate
   * included — breaks the streak without moving anything.
   *
   * Driven off controller notifications rather than the view, so it also fires
   * for a game that ends while the board is not the active tab. What it did is
   * recorded on the game itself: reopening the vault must not count the same
   * result a second time, and undoing back into a live position takes it back.
   */
  private syncAdaptiveDifficulty(): boolean {
    if (!this.settings.adaptiveDifficulty) return false;
    const applied = this.controller.resultApplied;

    if (!this.controller.isGameOver) {
      if (!applied) return false;
      // Undo turned a finished game back into a live one. Put the level back
      // only if it is still where this result left it; the streak always.
      if (applied.to !== applied.from && this.settings.difficulty === applied.to) {
        this.settings.difficulty = clampDifficulty(applied.from);
      }
      this.settings.resultStreak = applied.streakBefore;
      this.controller.resultApplied = null;
      return true;
    }

    if (applied) return false;
    const outcome = this.controller.outcome;
    if (!outcome) return false; // e.g. the engine failed to start: not a result

    const from = this.settings.difficulty;
    const streakBefore = this.settings.resultStreak;
    const threshold = this.settings.adaptiveThreshold;

    let streak: number;
    if (outcome === "win") streak = streakBefore > 0 ? streakBefore + 1 : 1;
    else if (outcome === "loss") streak = streakBefore < 0 ? streakBefore - 1 : -1;
    else streak = 0;

    const runLength = Math.abs(streak);
    const reached = runLength >= threshold;
    let to = from;
    if (reached) to = clampDifficulty(from + (streak > 0 ? 1 : -1));
    // The streak has done its job once it is spent; the next step needs a fresh
    // run of results rather than one more game on top of the old one.
    if (reached) streak = 0;

    this.settings.difficulty = to;
    this.settings.resultStreak = streak;
    this.controller.resultApplied = { from, to, streakBefore };

    let notice = "";
    if (to > from) notice = `Победа! Сложность бота повышена до ${to}.`;
    else if (to < from) notice = `Поражение. Сложность бота понижена до ${to}.`;
    else if (outcome === "draw") {
      if (streakBefore !== 0) notice = "Ничья — серия прервана, сложность прежняя.";
    } else if (reached) {
      // The streak filled up but the level had nowhere left to go.
      notice = outcome === "win"
        ? `Победа! Сложность уже максимальная (${MAX_DIFFICULTY}).`
        : `Поражение. Сложность уже минимальная (${MIN_DIFFICULTY}).`;
    } else {
      notice = outcome === "win"
        ? `Победа! Побед подряд: ${runLength} из ${threshold}.`
        : `Поражение. Поражений подряд: ${runLength} из ${threshold}.`;
    }
    if (notice) new Notice(notice, 5000);
    return true;
  }

  /** Pushes settings the board mirrors (level, colour, sound, move arrow) back
   *  into any open board, so nothing there sits on a stale value. */
  private refreshBoards(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHESS)) {
      // A deferred leaf hands back a placeholder rather than the real view.
      if (leaf.view instanceof ChessView) leaf.view.refreshFromSettings();
    }
  }

  async persistGame() {
    this.settings.savedGame = this.controller.serialize();
    await this.saveSettings();
  }

  /**
   * data.json is a plain file the person can edit, and a value out of range is
   * not harmless: a difficulty with no profile behind it left the bot silently
   * refusing to move, with the status line stuck on "Ход бота".
   */
  async loadSettings() {
    const raw = (await this.loadData()) as Partial<ChessBotSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
    this.settings.difficulty = clampDifficulty(this.settings.difficulty);

    const minutes = Math.round(Number(this.settings.timeControlMinutes));
    this.settings.timeControlMinutes = Number.isFinite(minutes)
      ? Math.min(MAX_TIME_CONTROL_MINUTES, Math.max(0, minutes))
      : DEFAULT_SETTINGS.timeControlMinutes;

    const increment = Math.round(Number(this.settings.incrementSeconds));
    this.settings.incrementSeconds = Number.isFinite(increment)
      ? Math.min(60, Math.max(0, increment))
      : DEFAULT_SETTINGS.incrementSeconds;

    const volume = Math.round(Number(this.settings.soundVolume));
    this.settings.soundVolume = Number.isFinite(volume)
      ? Math.min(100, Math.max(0, volume))
      : DEFAULT_SETTINGS.soundVolume;

    this.settings.adaptiveThreshold = clampAdaptiveThreshold(this.settings.adaptiveThreshold);

    const streak = Math.round(Number(this.settings.resultStreak));
    this.settings.resultStreak = Number.isFinite(streak) ? streak : 0;

    this.settings.levelStats = sanitizeLevelStats(this.settings.levelStats);

    if (!["w", "b", "random"].includes(this.settings.playerColor)) {
      this.settings.playerColor = DEFAULT_SETTINGS.playerColor;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshBoards();
  }
}
