import { Plugin } from "obsidian";
import { ChessSettingTab } from "./settings";
import { GameController } from "./game-controller";
import { ChessView, VIEW_TYPE_CHESS } from "./view";
import { DEFAULT_SETTINGS } from "./types";
import type { ChessBotSettings } from "./types";

export default class ChessBotPlugin extends Plugin {
  settings: ChessBotSettings;
  controller: GameController;

  async onload() {
    await this.loadSettings();

    this.controller = new GameController();
    if (this.settings.savedGame) this.controller.restore(this.settings.savedGame);

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

  async persistGame() {
    this.settings.savedGame = this.controller.serialize();
    await this.saveSettings();
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
