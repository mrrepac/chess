import { App, PluginSettingTab, Setting } from "obsidian";
import type ChessBotPlugin from "./main";
import { confirm } from "./confirm";
import { describeDifficulty, describeRecord, t } from "./i18n";
import type { I18nKey } from "./i18n";
import {
  clampAdaptiveThreshold, clampDifficulty, MAX_ADAPTIVE_THRESHOLD, MIN_ADAPTIVE_THRESHOLD
} from "./types";
import type { Difficulty, LevelRecord } from "./types";

/** Spelled out per value rather than assembled from a number and a noun: the
 *  Russian side needs a different plural for each one anyway. */
function describeThreshold(games: number): string {
  return t(`threshold${clampAdaptiveThreshold(games)}` as I18nKey);
}

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
      .setName(t("setDifficulty"))
      .setDesc(describeDifficulty(this.plugin.settings.difficulty));
    difficultySetting.addSlider(slider => slider
      .setLimits(1, 10, 1)
      .setValue(this.plugin.settings.difficulty)
      .onChange(async (value) => {
        difficultySetting.setDesc(describeDifficulty(clampDifficulty(value)));
        await this.plugin.setDifficulty(clampDifficulty(value));
      }));

    new Setting(containerEl)
      .setName(t("setAdaptive"))
      .setDesc(t("setAdaptiveDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.adaptiveDifficulty)
        .onChange(async (value) => {
          this.plugin.settings.adaptiveDifficulty = value;
          await this.plugin.saveSettings();
          this.display(); // the threshold row appears or disappears with it
        }));

    if (this.plugin.settings.adaptiveDifficulty) {
      const thresholdSetting = new Setting(containerEl)
        .setName(t("setThreshold"))
        .setDesc(describeThreshold(this.plugin.settings.adaptiveThreshold));
      thresholdSetting.addSlider(slider => slider
        .setLimits(MIN_ADAPTIVE_THRESHOLD, MAX_ADAPTIVE_THRESHOLD, 1)
        .setValue(this.plugin.settings.adaptiveThreshold)
        .onChange(async (value) => {
          const games = clampAdaptiveThreshold(value);
          this.plugin.settings.adaptiveThreshold = games;
          thresholdSetting.setDesc(describeThreshold(games));
          await this.plugin.saveSettings();
        }));
    }

    new Setting(containerEl)
      .setName(t("setColor"))
      .setDesc(t("setColorDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("w", t("optWhite"))
        .addOption("b", t("optBlack"))
        .addOption("random", t("optRandom"))
        .setValue(this.plugin.settings.playerColor)
        .onChange(async (value) => {
          this.plugin.settings.playerColor = value as typeof this.plugin.settings.playerColor;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setOrientation"))
      .setDesc(t("setOrientationDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("player", t("optPlayerSide"))
        .addOption("white", t("optWhiteBottom"))
        .addOption("black", t("optBlackBottom"))
        .setValue(this.plugin.settings.boardOrientation)
        .onChange(async (value) => {
          this.plugin.settings.boardOrientation = value as typeof this.plugin.settings.boardOrientation;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setTimeControl"))
      .setDesc(t("setTimeControlDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("0", t("optNoClock"))
        .addOption("5", t("optMin5"))
        .addOption("10", t("optMin10"))
        .addOption("15", t("optMin15"))
        .addOption("30", t("optMin30"))
        .addOption("60", t("optMin60"))
        .setValue(String(this.plugin.settings.timeControlMinutes))
        .onChange(async (value) => {
          this.plugin.settings.timeControlMinutes = Number(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setIncrement"))
      .setDesc(t("setIncrementDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("0", t("optInc0"))
        .addOption("2", t("optInc2"))
        .addOption("3", t("optInc3"))
        .addOption("5", t("optInc5"))
        .addOption("10", t("optInc10"))
        .addOption("30", t("optInc30"))
        .setValue(String(this.plugin.settings.incrementSeconds))
        .onChange(async (value) => {
          this.plugin.settings.incrementSeconds = Number(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setArrow"))
      .setDesc(t("setArrowDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showMoveArrow)
        .onChange(async (value) => {
          this.plugin.settings.showMoveArrow = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setSounds"))
      .setDesc(t("setSoundsDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.soundEnabled)
        .onChange(async (value) => {
          this.plugin.settings.soundEnabled = value;
          await this.plugin.saveSettings();
        }));

    const volumeSetting = new Setting(containerEl)
      .setName(t("setVolume"))
      .setDesc(`${this.plugin.settings.soundVolume}%`);
    volumeSetting.addSlider(slider => slider
        .setLimits(0, 100, 1)
        .setValue(this.plugin.settings.soundVolume)
        .onChange(async (value) => {
          this.plugin.settings.soundVolume = value;
          volumeSetting.setDesc(`${value}%`);
          await this.plugin.saveSettings();
        }));

    this.displayStats(containerEl);
  }

  /**
   * Finished games per level. Only levels that have been played are listed —
   * ten rows of zeroes would say nothing — and the tally counts the level a
   * game ended at, which is where the bot was actually playing from.
   */
  private displayStats(containerEl: HTMLElement): void {
    const stats = this.plugin.settings.levelStats;
    const levels = Object.keys(stats)
      .map(Number)
      .filter(level => Number.isInteger(level))
      .sort((a, b) => a - b) as Difficulty[];

    new Setting(containerEl).setName(t("headStats")).setHeading();

    if (levels.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: t("statsEmpty")
      });
      return;
    }

    const total: LevelRecord = { wins: 0, losses: 0, draws: 0 };
    for (const level of levels) {
      const record = stats[level];
      if (!record) continue;
      total.wins += record.wins;
      total.losses += record.losses;
      total.draws += record.draws;
      new Setting(containerEl)
        .setName(t("statsLevel", { level }))
        .setDesc(describeRecord(record));
    }

    if (levels.length > 1) {
      new Setting(containerEl).setName(t("statsTotal")).setDesc(describeRecord(total));
    }

    new Setting(containerEl)
      .setName(t("setReset"))
      .setDesc(t("setResetDesc"))
      .addButton(button => button
        .setButtonText(t("btnReset"))
        .setWarning()
        .onClick(async () => {
          const agreed = await confirm(
            this.app,
            t("resetStatsTitle"),
            t("resetStatsBody"),
            t("resetStatsConfirm")
          );
          if (!agreed) return;
          this.plugin.settings.levelStats = {};
          await this.plugin.saveSettings();
          this.display();
        }));
  }
}
