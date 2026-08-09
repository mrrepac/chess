import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { Move, PieceSymbol, Square } from "chess.js";
import type ChessBotPlugin from "./main";
import type { GameController } from "./game-controller";
import type { Difficulty, PlayerColor } from "./types";
import { findKing, isLightSquare, legalMovesFrom, squareAt, statusText } from "./rules";
import { createPieceImage } from "./pieces";
import { ChessSounds } from "./sound";

export const VIEW_TYPE_CHESS = "chess-bot-view";

interface DragState {
  from: Square;
  startX: number;
  startY: number;
  moved: boolean;
  preview: HTMLElement | null;
}

export class ChessView extends ItemView {
  private plugin: ChessBotPlugin;
  private controller: GameController;
  private boardEl: HTMLElement;
  private statusEl: HTMLElement;
  private clockEl: HTMLElement;
  private scoreEl: HTMLElement;
  private selected: Square | null = null;
  private legalTargets = new Set<Square>();
  private flipped = false;
  private unsubscribe: (() => void) | null = null;
  private sounds: ChessSounds;
  private drag: DragState | null = null;
  private suppressClickUntil = 0;
  private clockTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ChessBotPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.controller = plugin.controller;
    this.sounds = new ChessSounds(() =>
      this.plugin.settings.soundEnabled ? this.plugin.settings.soundVolume / 100 : 0
    );
  }

  getViewType(): string {
    return VIEW_TYPE_CHESS;
  }

  getDisplayText(): string {
    return "Шахматы";
  }

  getIcon(): string {
    // Lucide (bundled with Obsidian) has no chess-pawn glyph; crown reads as
    // "chess" clearly enough and is a real icon id (confirmed in obsidian.asar).
    return "crown";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("chess-bot-view");

    const toolbar = root.createDiv({ cls: "chess-bot-toolbar" });
    const iconButton = (icon: string, label: string): HTMLButtonElement => {
      const button = toolbar.createEl("button", {
        cls: "chess-bot-icon-button",
        attr: { "aria-label": label, title: label }
      });
      setIcon(button, icon);
      return button;
    };

    const newGameBtn = iconButton("plus", "Новая игра");
    newGameBtn.addEventListener("click", () => this.startNewGame());

    const undoBtn = iconButton("undo-2", "Отменить ход");
    undoBtn.addEventListener("click", () => {
      if (this.controller.undoHumanTurn()) {
        this.sounds.play("undo");
        void this.plugin.persistGame();
      }
    });

    const flipBtn = iconButton("refresh-cw", "Перевернуть доску");
    flipBtn.addEventListener("click", () => {
      this.flipped = !this.flipped;
      this.render();
    });

    const soundBtn = iconButton(
      this.plugin.settings.soundEnabled ? "volume-2" : "volume-x",
      this.plugin.settings.soundEnabled ? "Выключить звук" : "Включить звук"
    );
    soundBtn.addEventListener("click", () => {
      this.plugin.settings.soundEnabled = !this.plugin.settings.soundEnabled;
      const enabled = this.plugin.settings.soundEnabled;
      const label = enabled ? "Выключить звук" : "Включить звук";
      setIcon(soundBtn, enabled ? "volume-2" : "volume-x");
      soundBtn.setAttribute("aria-label", label);
      soundBtn.title = label;
      if (enabled) this.sounds.play("start");
      void this.plugin.saveSettings();
    });

    const resignBtn = iconButton("flag", "Сдаться");
    resignBtn.addEventListener("click", () => {
      if (this.controller.resign()) {
        this.sounds.play("loss");
        void this.plugin.persistGame();
      }
    });

    const colorBtn = toolbar.createEl("button", { cls: "chess-bot-color-button" });
    const updateColorLabel = () => {
      const choice = this.plugin.settings.playerColor;
      const labels = {
        w: "Белые",
        b: "Чёрные",
        random: "Случайный цвет"
      } as const;
      colorBtn.empty();
      colorBtn.createSpan({ cls: `chess-bot-color-dot ${choice}` });
      colorBtn.setAttribute("aria-label", `Цвет новой партии: ${labels[choice]}`);
      colorBtn.title = `Цвет новой партии: ${labels[choice]}`;
    };
    updateColorLabel();
    colorBtn.addEventListener("click", () => {
      const current = this.plugin.settings.playerColor;
      this.plugin.settings.playerColor = current === "w" ? "b" : current === "b" ? "random" : "w";
      updateColorLabel();
      void this.plugin.saveSettings();
    });

    const difficultyBtn = toolbar.createEl("button", {
      cls: "chess-bot-difficulty-button",
      text: String(this.plugin.settings.difficulty)
    });
    const updateDifficultyLabel = () => {
      const level = this.plugin.settings.difficulty;
      difficultyBtn.setText(String(level));
      difficultyBtn.setAttribute("aria-label", `Сложность бота: ${level}. Нажмите для следующего уровня`);
      difficultyBtn.title = `Сложность бота: ${level} из 10`;
    };
    updateDifficultyLabel();
    difficultyBtn.addEventListener("click", () => {
      const current = this.plugin.settings.difficulty;
      this.plugin.settings.difficulty = (current === 10 ? 1 : current + 1) as Difficulty;
      updateDifficultyLabel();
      void this.plugin.saveSettings();
    });

    this.statusEl = root.createDiv({ cls: "chess-bot-status" });
    const gameInfo = root.createDiv({ cls: "chess-bot-game-info" });
    this.clockEl = gameInfo.createSpan({ cls: "chess-bot-clock" });
    this.scoreEl = gameInfo.createSpan({ cls: "chess-bot-score" });
    this.boardEl = root.createDiv({ cls: "chess-bot-board" });
    this.boardEl.addEventListener("mousedown", this.handleDragStart);
    this.boardEl.addEventListener("contextmenu", event => event.preventDefault());

    this.clearAncestorWidthCaps();
    this.unsubscribe = this.controller.onChange(() => this.render());
    this.flipped = this.controller.humanColor === "b";
    this.render();
    this.clockTimer = window.setInterval(() => this.updateGameInfo(), 250);
    void this.maybeTriggerBot();
  }

  /**
   * Obsidian's readable-line-length machinery can cap a pane's content width
   * well below what's actually available (same symptom hit in md-calendar).
   * Since this view owns its whole pane, strip any max-width it inherited
   * from ancestors up to .view-content — inline styles win outright, no need
   * to reverse-engineer which selector is responsible.
   */
  private clearAncestorWidthCaps(): void {
    let el: HTMLElement | null = this.contentEl;
    while (el) {
      el.style.maxWidth = "none";
      if (el.hasClass("view-content")) break;
      el = el.parentElement;
    }
  }

  async onClose() {
    this.finishDrag();
    this.sounds.close();
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    this.clockTimer = null;
    void this.plugin.persistGame();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleDragStart = (event: MouseEvent): void => {
    if (event.button === 2) {
      event.preventDefault();
      this.finishDrag();
      this.selected = null;
      this.legalTargets.clear();
      this.render();
      return;
    }
    if (event.button !== 0 || !this.controller.isHumanTurn) return;

    const cell = (event.target as HTMLElement).closest<HTMLElement>(".chess-bot-square");
    const square = cell?.dataset.square as Square | undefined;
    if (!cell || !square || !this.boardEl.contains(cell)) return;

    const piece = this.controller.chess.get(square);
    if (!piece || piece.color !== this.controller.humanColor) return;

    event.preventDefault();
    this.selected = square;
    this.legalTargets = new Set(legalMovesFrom(this.controller.chess, square).map(m => m.to as Square));
    this.drag = {
      from: square,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      preview: null
    };
    this.render();

    document.addEventListener("mousemove", this.handleDragMove);
    document.addEventListener("mouseup", this.handleDragEnd);
  };

  private handleDragMove = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;

    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;

    if (!drag.moved) {
      drag.moved = true;
      drag.preview = this.createDragPreview(drag.from);
      this.boardEl.addClass("dragging");
      this.boardEl.querySelector<HTMLElement>(`[data-square="${drag.from}"]`)?.addClass("drag-source");
    }

    if (drag.preview) {
      drag.preview.style.left = `${event.clientX}px`;
      drag.preview.style.top = `${event.clientY}px`;
    }
  };

  private handleDragEnd = (event: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;

    const target = this.squareUnderPointer(event.clientX, event.clientY);
    const moved = drag.moved;
    this.finishDrag();

    if (!moved) return;
    this.suppressClickUntil = performance.now() + 250;
    if (target && this.legalTargets.has(target)) void this.handleSquareClick(target);
  };

  private createDragPreview(square: Square): HTMLElement | null {
    const piece = this.controller.chess.get(square);
    const source = this.boardEl.querySelector<HTMLElement>(`[data-square="${square}"]`);
    if (!piece || !source) return null;

    const preview = document.createElement("span");
    preview.className = "chess-bot-drag-preview";
    const size = source.getBoundingClientRect().width * 0.88;
    preview.style.width = `${size}px`;
    preview.style.height = `${size}px`;
    preview.appendChild(createPieceImage(piece.type, piece.color));
    document.body.appendChild(preview);
    return preview;
  }

  private squareUnderPointer(x: number, y: number): Square | null {
    const cell = (document.elementFromPoint(x, y) as HTMLElement | null)
      ?.closest<HTMLElement>(".chess-bot-square");
    if (!cell || !this.boardEl.contains(cell)) return null;
    return (cell.dataset.square as Square | undefined) ?? null;
  }

  private finishDrag(): void {
    document.removeEventListener("mousemove", this.handleDragMove);
    document.removeEventListener("mouseup", this.handleDragEnd);
    this.drag?.preview?.remove();
    this.drag = null;
    this.boardEl?.removeClass("dragging");
    this.boardEl?.querySelector(".drag-source")?.removeClass("drag-source");
  }

  private startNewGame(): void {
    const pref = this.plugin.settings.playerColor;
    const humanColor: PlayerColor = pref === "random" ? (Math.random() < 0.5 ? "w" : "b") : pref;
    this.selected = null;
    this.legalTargets.clear();
    this.flipped = humanColor === "b";
    this.controller.newGame(humanColor);
    this.sounds.play("start");
    void this.plugin.persistGame();
    void this.maybeTriggerBot();
  }

  private async maybeTriggerBot(): Promise<void> {
    if (this.controller.isGameOver) return;
    if (this.controller.chess.turn() === this.controller.humanColor) return;
    const move = await this.controller.requestBotMove(this.plugin.settings.difficulty);
    if (move) {
      this.playMoveSound(move);
      void this.plugin.persistGame();
    }
  }

  private async handleSquareClick(square: Square): Promise<void> {
    if (!this.controller.isHumanTurn) return;
    const piece = this.controller.chess.get(square);

    if (this.selected && this.legalTargets.has(square)) {
      const from = this.selected;
      const candidates = legalMovesFrom(this.controller.chess, from);
      const target = candidates.find(m => m.to === square);

      let promotion: PieceSymbol | undefined;
      if (target?.promotion) {
        promotion = await this.pickPromotion();
        if (!promotion) {
          this.selected = null;
          this.legalTargets.clear();
          this.render();
          return;
        }
      }

      this.selected = null;
      this.legalTargets.clear();
      const move = this.controller.applyHumanMove(from, square, promotion);
      if (move) {
        this.playMoveSound(move);
        void this.plugin.persistGame();
        void this.maybeTriggerBot();
      } else {
        this.render();
      }
      return;
    }

    if (piece && piece.color === this.controller.humanColor) {
      this.selected = square;
      this.legalTargets = new Set(legalMovesFrom(this.controller.chess, square).map(m => m.to as Square));
      this.render();
      return;
    }

    this.selected = null;
    this.legalTargets.clear();
    this.render();
  }

  private playMoveSound(move: Move): void {
    const { chess, humanColor } = this.controller;
    let outcome: "win" | "loss" | "draw" | null = null;
    if (chess.isCheckmate()) outcome = chess.turn() === humanColor ? "loss" : "win";
    else if (chess.isGameOver()) outcome = "draw";
    this.sounds.playMove(move, chess.isCheck(), outcome);
  }

  /** A small overlay with the four promotion choices; resolves to undefined if dismissed. */
  private pickPromotion(): Promise<PieceSymbol | undefined> {
    return new Promise(resolve => {
      const color = this.controller.humanColor;
      const overlay = document.body.createDiv({ cls: "chess-bot-promo-overlay" });
      const box = overlay.createDiv({ cls: "chess-bot-promo-choices" });
      const options: PieceSymbol[] = ["q", "r", "b", "n"];
      const finish = (result: PieceSymbol | undefined) => {
        overlay.remove();
        resolve(result);
      };
      for (const type of options) {
        const btn = box.createEl("button", { attr: { "aria-label": this.promotionLabel(type) } });
        btn.appendChild(createPieceImage(type, color));
        btn.addEventListener("click", () => finish(type));
      }
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) finish(undefined);
      });
    });
  }

  private promotionLabel(type: PieceSymbol): string {
    const labels: Record<PieceSymbol, string> = {
      p: "Пешка", n: "Конь", b: "Слон", r: "Ладья", q: "Ферзь", k: "Король"
    };
    return `Превратить в: ${labels[type]}`;
  }

  private render(): void {
    const { chess, humanColor, thinking, resigned } = this.controller;
    this.statusEl.setText(this.controller.timedOut
      ? "Время вышло — вы проиграли."
      : statusText(chess, humanColor, thinking, resigned));
    this.updateGameInfo();

    this.boardEl.empty();
    const history = chess.history({ verbose: true }) as Move[];
    const last = history[history.length - 1];
    const kingInCheck = chess.isCheck() ? findKing(chess, chess.turn()) : null;

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const rank = this.flipped ? 7 - r : r;
        const file = this.flipped ? 7 - f : f;
        const square = squareAt(file, rank);

        const cellEl = this.boardEl.createDiv({ cls: "chess-bot-square" });
        cellEl.dataset.square = square;
        cellEl.addClass(isLightSquare(file, rank) ? "light" : "dark");
        if (square === this.selected) cellEl.addClass("selected");
        if (last && (square === last.from || square === last.to)) cellEl.addClass("last-move");
        if (square === kingInCheck) cellEl.addClass("in-check");

        const piece = chess.get(square);
        if (this.legalTargets.has(square)) {
          cellEl.addClass(piece ? "legal-capture" : "legal-target");
        }
        if (piece) {
          const figure = cellEl.createSpan({ cls: "chess-bot-piece" });
          figure.appendChild(createPieceImage(piece.type, piece.color));
        }

        cellEl.addEventListener("click", () => {
          if (performance.now() < this.suppressClickUntil) return;
          void this.handleSquareClick(square);
        });
      }
    }
  }

  private updateGameInfo(): void {
    const remaining = this.controller.remainingHumanTimeMs;
    const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    this.clockEl.setText(`⏱ ${minutes}:${seconds}`);
    this.clockEl.toggleClass("low", remaining > 0 && remaining <= 60_000);

    const human = this.controller.humanColor;
    const opponent = human === "w" ? "b" : "w";
    const humanPoints = this.capturedPoints(human);
    const botPoints = this.capturedPoints(opponent);
    const balance = humanPoints - botPoints;
    this.scoreEl.setText(balance > 0 ? `+${balance}` : String(balance).replace("-", "−"));
    this.scoreEl.title = `Материал: вы ${humanPoints} — ${botPoints} бот`;
    this.scoreEl.toggleClass("advantage", balance > 0);
    this.scoreEl.toggleClass("disadvantage", balance < 0);

    if (remaining <= 0 && this.controller.expireHumanClock()) {
      this.sounds.play("loss");
      void this.plugin.persistGame();
    }
  }

  private capturedPoints(color: "w" | "b"): number {
    const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let score = 0;
    const history = this.controller.chess.history({ verbose: true }) as Move[];
    for (const move of history) {
      if (move.color === color && move.captured) score += values[move.captured];
    }
    return score;
  }
}
