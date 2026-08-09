import { bundle, load, suite } from "./harness.mjs";

/** Runtime smoke test: does the plugin actually wire up without throwing,
 *  not just type-check and bundle cleanly. */
export default async function run() {
  const s = suite("smoke");

  const src = await bundle("src/main.ts");

  const registered = [];
  const commands = [];
  let settingTabAdded = false;
  let ribbonAdded = false;
  const savedData = { current: null };

  class PluginStub {
    constructor() {
      this.app = { workspace: {} };
    }
    registerView(type, factory) { registered.push({ type, factory }); }
    addRibbonIcon() { ribbonAdded = true; return {}; }
    addCommand(cmd) { commands.push(cmd); }
    addSettingTab() { settingTabAdded = true; }
    async loadData() { return savedData.current; }
    async saveData(data) { savedData.current = data; }
  }

  const obsidianStub = {
    Plugin: PluginStub,
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
  s.check("registers the open-chess command", commands.some(c => c.id === "open-chess"));
  s.check("loads default settings (difficulty 5)", plugin.settings.difficulty === 5);
  s.check("creates a game controller with a starting position", () =>
    plugin.controller.chess.fen().startsWith("rnbqkbnr/pppppppp"));

  await plugin.persistGame();
  s.check("persistGame writes a saved game to data.json", () => savedData.current?.savedGame?.fen != null);

  return s.report();
}
