import { App, PluginSettingTab, Setting } from "obsidian";
import type ChessBotPlugin from "./main";
import { describeDifficulty } from "./types";
import type { Difficulty } from "./types";

export class ChessSettingTab extends PluginSettingTab {
  plugin: ChessBotPlugin;

  constructor(app: App, plugin: ChessBotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const difficultySetting = new Setting(containerEl)
      .setName("Сложность бота")
      .setDesc(describeDifficulty(this.plugin.settings.difficulty));
    difficultySetting.addSlider(slider => slider
      .setLimits(1, 10, 1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.difficulty)
      .onChange(async (value) => {
        this.plugin.settings.difficulty = value as Difficulty;
        difficultySetting.setDesc(describeDifficulty(value as Difficulty));
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Цвет по умолчанию")
      .setDesc("Каким цветом играть в новой партии («Случайно» выбирает при каждой новой игре).")
      .addDropdown(dropdown => dropdown
        .addOption("w", "Белые")
        .addOption("b", "Чёрные")
        .addOption("random", "Случайно")
        .setValue(this.plugin.settings.playerColor)
        .onChange(async (value) => {
          this.plugin.settings.playerColor = value as typeof this.plugin.settings.playerColor;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Звуки игры")
      .setDesc("Мягкие звуки ходов, взятий, шаха и окончания партии.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.soundEnabled)
        .onChange(async (value) => {
          this.plugin.settings.soundEnabled = value;
          await this.plugin.saveSettings();
        }));

    const volumeSetting = new Setting(containerEl)
      .setName("Громкость звуков")
      .setDesc(`${this.plugin.settings.soundVolume}%`);
    volumeSetting.addSlider(slider => slider
        .setLimits(0, 100, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.soundVolume)
        .onChange(async (value) => {
          this.plugin.settings.soundVolume = value;
          volumeSetting.setDesc(`${value}%`);
          await this.plugin.saveSettings();
        }));
  }
}
