import { App, PluginSettingTab, Setting } from "obsidian";
import type ChessBotPlugin from "./main";
import { confirm } from "./confirm";
import {
  clampAdaptiveThreshold, clampDifficulty, describeDifficulty, describeRecord,
  MAX_ADAPTIVE_THRESHOLD, MIN_ADAPTIVE_THRESHOLD
} from "./types";
import type { Difficulty, LevelRecord } from "./types";

function describeThreshold(games: number): string {
  if (games === 1) return "1 — уровень меняется после каждой партии";
  const plural = games === 2 || games === 3 || games === 4 ? "победы" : "побед";
  return `${games} — ${games} ${plural} подряд поднимают уровень, столько же поражений опускают`;
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
      .setName("Сложность бота")
      .setDesc(describeDifficulty(this.plugin.settings.difficulty));
    difficultySetting.addSlider(slider => slider
      .setLimits(1, 10, 1)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.difficulty)
      .onChange(async (value) => {
        difficultySetting.setDesc(describeDifficulty(clampDifficulty(value)));
        await this.plugin.setDifficulty(clampDifficulty(value));
      }));

    new Setting(containerEl)
      .setName("Подстраивать сложность под результат")
      .setDesc("Уровень двигается на единицу, когда один и тот же результат повторяется подряд. "
        + "Ничья и пат серию прерывают, но уровень не меняют. Отмена хода в законченной "
        + "партии отменяет и её вклад в серию.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.adaptiveDifficulty)
        .onChange(async (value) => {
          this.plugin.settings.adaptiveDifficulty = value;
          await this.plugin.saveSettings();
          this.display(); // the threshold row appears or disappears with it
        }));

    if (this.plugin.settings.adaptiveDifficulty) {
      const thresholdSetting = new Setting(containerEl)
        .setName("Партий подряд для смены уровня")
        .setDesc(describeThreshold(this.plugin.settings.adaptiveThreshold));
      thresholdSetting.addSlider(slider => slider
        .setLimits(MIN_ADAPTIVE_THRESHOLD, MAX_ADAPTIVE_THRESHOLD, 1)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.adaptiveThreshold)
        .onChange(async (value) => {
          const games = clampAdaptiveThreshold(value);
          this.plugin.settings.adaptiveThreshold = games;
          thresholdSetting.setDesc(describeThreshold(games));
          await this.plugin.saveSettings();
        }));
    }

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
      .setName("Контроль времени")
      .setDesc("Сколько минут даётся вам на партию. Отсчёт начинается с вашего первого хода "
        + "и идёт только пока доска открыта.")
      .addDropdown(dropdown => dropdown
        .addOption("0", "Без часов")
        .addOption("5", "5 минут")
        .addOption("10", "10 минут")
        .addOption("15", "15 минут")
        .addOption("30", "30 минут")
        .addOption("60", "60 минут")
        .setValue(String(this.plugin.settings.timeControlMinutes))
        .onChange(async (value) => {
          this.plugin.settings.timeControlMinutes = Number(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Добавка за ход")
      .setDesc("Сколько секунд возвращается на ваши часы после каждого вашего хода. "
        + "Применяется к новым партиям.")
      .addDropdown(dropdown => dropdown
        .addOption("0", "Без добавки")
        .addOption("2", "+2 секунды")
        .addOption("3", "+3 секунды")
        .addOption("5", "+5 секунд")
        .addOption("10", "+10 секунд")
        .addOption("30", "+30 секунд")
        .setValue(String(this.plugin.settings.incrementSeconds))
        .onChange(async (value) => {
          this.plugin.settings.incrementSeconds = Number(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Показывать оценку бота")
      .setDesc("После хода бота выводит его собственную оценку позиции в пешках.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showEvaluation)
        .onChange(async (value) => {
          this.plugin.settings.showEvaluation = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Стрелка хода бота")
      .setDesc("После хода бота рисует на доске стрелку от поля к полю. "
        + "Подсветка обоих полей остаётся в любом случае.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showMoveArrow)
        .onChange(async (value) => {
          this.plugin.settings.showMoveArrow = value;
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

    new Setting(containerEl).setName("Статистика").setHeading();

    if (levels.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "Ни одной законченной партии пока нет. Счёт появится здесь сам."
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
        .setName(`Уровень ${level}`)
        .setDesc(describeRecord(record));
    }

    if (levels.length > 1) {
      new Setting(containerEl).setName("Всего").setDesc(describeRecord(total));
    }

    new Setting(containerEl)
      .setName("Сбросить статистику")
      .setDesc("Стирает счёт по всем уровням. Текущую серию результатов не трогает.")
      .addButton(button => button
        .setButtonText("Сбросить")
        .setWarning()
        .onClick(async () => {
          const agreed = await confirm(
            this.app,
            "Сбросить статистику?",
            "Счёт по всем уровням будет стёрт, вернуть его будет неоткуда.",
            "Сбросить"
          );
          if (!agreed) return;
          this.plugin.settings.levelStats = {};
          await this.plugin.saveSettings();
          this.display();
        }));
  }
}
