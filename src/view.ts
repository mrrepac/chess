import { ItemView, Menu, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { Move, PieceSymbol, Square } from "chess.js";
import type ChessBotPlugin from "./main";
import type { GameController } from "./game-controller";
import {
  clampDifficulty, describeDifficulty, formatRecord, MAX_DIFFICULTY, MIN_DIFFICULTY
} from "./types";
import type { Difficulty, PlayerColor } from "./types";
import { findKing, isLightSquare, legalMovesFrom, squareAt, statusText } from "./rules";
import { createPieceImage } from "./pieces";
import { confirm } from "./confirm";
import { ChessSounds } from "./sound";

export const VIEW_TYPE_CHESS = "chess-bot-view";

/** Anything at or beyond this is a forced mate rather than a material score. */
const MATE_THRESHOLD = 90000;

/** How long the "you cannot go there" flash lasts. Must match the animations
 *  on `.chess-bot-square.illegal` in styles.css. */
const ILLEGAL_FLASH_MS = 340;

interface DragState {
  from: Square;
  pointerId: number;
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
  private evalEl: HTMLElement;
  private selected: Square | null = null;
  private legalTargets = new Set<Square>();
  private flipped = false;
  private unsubscribe: (() => void) | null = null;
  private sounds: ChessSounds;
  private drag: DragState | null = null;
  private pressSquare: Square | null = null;
  private clockTimer: number | null = null;
  private boardResize: ResizeObserver | null = null;
  /** Toolbar buttons mirror settings that the settings tab — and adaptive
   *  difficulty — can change behind the board's back, so their labels are
   *  refreshed from the settings rather than only when they are clicked.
   *  The same function greys out the buttons the position has nothing for. */
  private syncToolbar: () => void = () => {};

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

  /** The view's own document/window, so a popped-out pane keeps working:
   *  a bare `document` there points at the main window, not this one. */
  private get doc(): Document {
    return this.contentEl.doc;
  }

  private get win(): Window {
    return this.contentEl.win;
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
    // Obsidian draws its own tooltip for anything carrying an aria-label, so an
    // element with both that and a `title` gets two of them, one over the other.
    // setTooltip is the one mechanism: it sets the aria-label and leaves the
    // native tooltip out of it.
    const iconButton = (icon: string, label: string): HTMLButtonElement => {
      const button = toolbar.createEl("button", { cls: "chess-bot-icon-button" });
      setIcon(button, icon);
      setTooltip(button, label);
      return button;
    };

    const newGameBtn = iconButton("plus", "Новая игра");
    newGameBtn.addEventListener("click", () => this.startNewGame());

    const undoBtn = iconButton("undo-2", "Отменить ход");
    undoBtn.addEventListener("click", () => {
      if (this.controller.undoHumanTurn()) {
        this.selected = null;
        this.legalTargets.clear();
        this.sounds.play("undo");
        void this.plugin.persistGame();
      }
    });

    const flipBtn = iconButton("refresh-cw", "Перевернуть доску");
    flipBtn.addEventListener("click", () => {
      this.flipped = !this.flipped;
      this.render();
    });

    const soundBtn = iconButton("volume-2", "Выключить звук");
    const updateSoundLabel = () => {
      const enabled = this.plugin.settings.soundEnabled;
      setIcon(soundBtn, enabled ? "volume-2" : "volume-x");
      setTooltip(soundBtn, enabled ? "Выключить звук" : "Включить звук");
    };
    soundBtn.addEventListener("click", () => {
      this.plugin.settings.soundEnabled = !this.plugin.settings.soundEnabled;
      updateSoundLabel();
      if (this.plugin.settings.soundEnabled) this.sounds.play("start");
      void this.plugin.saveSettings();
    });

    const resignBtn = iconButton("flag", "Сдаться");
    resignBtn.addEventListener("click", () => void this.resignWithConfirmation());

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
      setTooltip(colorBtn, `Цвет новой партии: ${labels[choice]}`);
    };
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
      // One line: the tooltip is a single run of text, so a newline in here
      // would come out as a space anyway.
      setTooltip(difficultyBtn, [
        `Сложность бота: ${level} из ${MAX_DIFFICULTY}${this.plugin.describeStreak()}`,
        this.plugin.describeLevelRecord(level),
        "Колесо и правая кнопка — другие уровни"
      ].filter(Boolean).join(". "));
    };
    difficultyBtn.addEventListener("click", () => {
      const current = this.plugin.settings.difficulty;
      void this.plugin.setDifficulty((current === MAX_DIFFICULTY ? MIN_DIFFICULTY : current + 1) as Difficulty);
    });
    // Clicking through nine levels to drop from 10 to 1 is the only way down
    // that a single cycling button offers, so the wheel steps either way and
    // right-click opens the whole ladder at once.
    difficultyBtn.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.stepDifficulty(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    difficultyBtn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // The pane-wide handler below turns right-click into "new game" once the
      // game is over; picking a level must not also deal a fresh position.
      event.stopPropagation();
      this.showDifficultyMenu(event);
    });

    const updateButtonStates = () => {
      undoBtn.disabled = !this.controller.canUndo;
      setTooltip(undoBtn, undoBtn.disabled
        ? "Отменить ход — отменять пока нечего"
        : "Отменить ход");
      resignBtn.disabled = this.controller.isGameOver;
      setTooltip(resignBtn, resignBtn.disabled
        ? "Сдаться — партия уже закончена"
        : "Сдаться");
    };

    this.syncToolbar = () => {
      updateSoundLabel();
      updateColorLabel();
      updateDifficultyLabel();
      updateButtonStates();
    };
    this.syncToolbar();

    this.statusEl = root.createDiv({ cls: "chess-bot-status" });
    const gameInfo = root.createDiv({ cls: "chess-bot-game-info" });
    this.clockEl = gameInfo.createSpan({ cls: "chess-bot-clock" });
    this.scoreEl = gameInfo.createSpan({ cls: "chess-bot-score" });
    this.evalEl = gameInfo.createSpan({ cls: "chess-bot-eval" });
    this.boardEl = root.createDiv({ cls: "chess-bot-board" });
    this.boardEl.addEventListener("pointerdown", this.handlePointerDown);
    this.boardEl.addEventListener("contextmenu", event => event.preventDefault());
    // The move arrow is drawn in pixels off the squares it connects, so every
    // resize of the pane needs it drawn again. It also covers the first paint:
    // a board with no layout yet has nothing to measure, and this fires as soon
    // as it does. The constructor comes from the view's own window, so a
    // popped-out board observes with that window's implementation.
    const win = this.win as Window & typeof globalThis;
    this.boardResize = new win.ResizeObserver(() => this.drawBotMoveArrow());
    this.boardResize.observe(this.boardEl);

    // Once the game is over there is nothing to lose by right-clicking, so the
    // whole pane becomes a "deal again" button. Bubbles up from the board too.
    root.addEventListener("contextmenu", (event) => {
      if (!this.controller.isGameOver) return;
      event.preventDefault();
      this.startNewGame();
    });

    this.clearAncestorWidthCaps();
    this.unsubscribe = this.controller.onChange(() => this.render());
    this.flipped = this.controller.humanColor === "b";
    this.controller.resumeHumanClock();
    this.render();
    // Only the clock changes between repaints; everything else on that row is
    // driven by controller notifications, so it does not belong on a timer.
    this.clockTimer = this.win.setInterval(() => this.updateClock(), 250);
    void this.maybeTriggerBot();
  }

  /** Called by the plugin when a setting the board mirrors changed elsewhere. */
  refreshFromSettings(): void {
    this.syncToolbar();
    this.drawBotMoveArrow();
  }

  private stepDifficulty(step: 1 | -1): void {
    const next = clampDifficulty(this.plugin.settings.difficulty + step);
    if (next !== this.plugin.settings.difficulty) void this.plugin.setDifficulty(next);
  }

  /** The whole ladder in one menu, each level with what it plays like and how
   *  the games against it have gone. */
  private showDifficultyMenu(event: MouseEvent): void {
    const menu = new Menu();
    const current = this.plugin.settings.difficulty;
    for (let level = MIN_DIFFICULTY; level <= MAX_DIFFICULTY; level++) {
      const value = level as Difficulty;
      const record = formatRecord(this.plugin.settings.levelStats[value]);
      menu.addItem(item => item
        .setTitle(record ? `${describeDifficulty(value)}  ·  ${record}` : describeDifficulty(value))
        .setChecked(value === current)
        .onClick(() => void this.plugin.setDifficulty(value)));
    }
    menu.showAtMouseEvent(event);
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
      el.setCssStyles({ maxWidth: "none" });
      if (el.hasClass("view-content")) break;
      el = el.parentElement;
    }
  }

  async onClose() {
    this.finishDrag();
    this.sounds.close();
    this.boardResize?.disconnect();
    this.boardResize = null;
    if (this.clockTimer !== null) this.win.clearInterval(this.clockTimer);
    this.clockTimer = null;
    // The clock belongs to time spent at the board, not to wall time.
    this.controller.pauseHumanClock();
    void this.plugin.persistGame();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Pointer events rather than mouse events: they are what a touchscreen
   * actually emits, so dragging a piece works on mobile instead of only
   * producing a synthesised click after the fact.
   */
  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button === 2) {
      event.preventDefault();
      this.cancelDrag();
      return;
    }
    if (event.button !== 0) return;

    const cell = (event.target as HTMLElement).closest<HTMLElement>(".chess-bot-square");
    const square = cell?.dataset.square as Square | undefined;
    if (!cell || !square || !this.boardEl.contains(cell)) return;
    if (!this.controller.isHumanTurn) return;

    event.preventDefault();
    this.pressSquare = square;
    this.doc.addEventListener("pointerup", this.handlePointerUp);
    this.doc.addEventListener("pointercancel", this.handlePointerCancel);

    const piece = this.controller.chess.get(square);
    if (!piece || piece.color !== this.controller.humanColor) return;

    this.selected = square;
    this.legalTargets = new Set(legalMovesFrom(this.controller.chess, square).map(m => m.to as Square));
    this.drag = {
      from: square,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      preview: null
    };
    this.render();
    this.doc.addEventListener("pointermove", this.handlePointerMove);
    // Right-click aborts the drag wherever the cursor happens to be — while
    // dragging it is usually well outside the board, so listening on the board
    // alone would only cancel on the rare occasion it is still over a square.
    // Capture phase, so nothing downstream sees the click first.
    this.doc.addEventListener("pointerdown", this.handleDragAbort, true);
    this.doc.addEventListener("contextmenu", this.handleDragAbort, true);
  };

  /** Puts a dragged piece back and clears the move hints, without moving.
   *  Checked by event type rather than `instanceof PointerEvent`: in a popped
   *  out window that class comes from the other window and never matches. */
  private handleDragAbort = (event: Event): void => {
    if (event.type === "pointerdown" && (event as PointerEvent).button !== 2) return;
    event.preventDefault();
    this.cancelDrag();
  };

  private cancelDrag(): void {
    this.finishDrag();
    this.selected = null;
    this.legalTargets.clear();
    this.render();
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;

    if (!drag.moved) {
      drag.moved = true;
      drag.preview = this.createDragPreview(drag.from);
      this.boardEl.addClass("dragging");
      this.boardEl.querySelector<HTMLElement>(`[data-square="${drag.from}"]`)?.addClass("drag-source");
    }

    drag.preview?.setCssStyles({ left: `${event.clientX}px`, top: `${event.clientY}px` });
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag && event.pointerId !== drag.pointerId) return;

    const pressed = this.pressSquare;
    const dragged = drag?.moved === true;
    const target = dragged ? this.squareUnderPointer(event.clientX, event.clientY) : pressed;
    this.finishDrag();

    if (dragged) {
      // A drag that ended somewhere illegal keeps the piece selected rather
      // than silently clearing what the person was aiming at.
      if (target && this.legalTargets.has(target)) void this.handleSquareClick(target);
      else {
        this.render();
        // Dropping a piece back where it was picked up is a cancelled move, not
        // an attempt at an illegal one.
        if (target && target !== drag?.from) this.flashIllegal(target);
      }
      return;
    }
    if (target) void this.handleSquareClick(target);
  };

  private handlePointerCancel = (): void => {
    this.finishDrag();
    this.render();
  };

  private createDragPreview(square: Square): HTMLElement | null {
    const piece = this.controller.chess.get(square);
    const source = this.boardEl.querySelector<HTMLElement>(`[data-square="${square}"]`);
    if (!piece || !source) return null;

    const preview = this.doc.createElement("span");
    preview.className = "chess-bot-drag-preview";
    const size = source.getBoundingClientRect().width * 0.88;
    preview.setCssStyles({ width: `${size}px`, height: `${size}px` });
    preview.appendChild(createPieceImage(piece.type, piece.color, this.doc));
    this.doc.body.appendChild(preview);
    return preview;
  }

  private squareUnderPointer(x: number, y: number): Square | null {
    const cell = (this.doc.elementFromPoint(x, y) as HTMLElement | null)
      ?.closest<HTMLElement>(".chess-bot-square");
    if (!cell || !this.boardEl.contains(cell)) return null;
    return (cell.dataset.square as Square | undefined) ?? null;
  }

  private finishDrag(): void {
    this.doc.removeEventListener("pointermove", this.handlePointerMove);
    this.doc.removeEventListener("pointerup", this.handlePointerUp);
    this.doc.removeEventListener("pointercancel", this.handlePointerCancel);
    this.doc.removeEventListener("pointerdown", this.handleDragAbort, true);
    this.doc.removeEventListener("contextmenu", this.handleDragAbort, true);
    this.drag?.preview?.remove();
    this.drag = null;
    this.pressSquare = null;
    this.boardEl?.removeClass("dragging");
    this.boardEl?.querySelector(".drag-source")?.removeClass("drag-source");
  }

  private startNewGame(): void {
    const pref = this.plugin.settings.playerColor;
    const humanColor: PlayerColor = pref === "random" ? (Math.random() < 0.5 ? "w" : "b") : pref;
    this.selected = null;
    this.legalTargets.clear();
    this.flipped = humanColor === "b";
    this.controller.newGame(humanColor, this.plugin.timeControlMs, this.plugin.incrementMs);
    this.sounds.play("start");
    void this.plugin.persistGame();
    void this.maybeTriggerBot();
  }

  private async resignWithConfirmation(): Promise<void> {
    if (this.controller.isGameOver) return;
    const cost = this.plugin.settings.adaptiveDifficulty
      ? " Партия пойдёт в счёт как поражение."
      : "";
    const agreed = await confirm(
      this.app,
      "Сдаться?",
      `Партия закончится поражением, отменить это можно только кнопкой «Отменить ход».${cost}`,
      "Сдаться"
    );
    // The clock kept running while the box was open, so the game can have
    // ended underneath it.
    if (!agreed || !this.controller.resign()) return;
    this.sounds.play("loss");
    void this.plugin.persistGame();
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

    // Clicking the piece that is already picked up puts it back down.
    if (square === this.selected) {
      this.selected = null;
      this.legalTargets.clear();
      this.render();
      return;
    }

    if (piece && piece.color === this.controller.humanColor) {
      const moves = legalMovesFrom(this.controller.chess, square);
      this.selected = square;
      this.legalTargets = new Set(moves.map(m => m.to as Square));
      this.render();
      // A piece with nowhere to go looks exactly like one the click missed.
      if (moves.length === 0) this.flashIllegal(square, this.checkedKingSquare(square));
      return;
    }

    // An empty square or one of the bot's, with a piece already in hand: the
    // move was aimed somewhere it cannot go. The piece stays picked up so the
    // next click can aim again — the same thing a dropped drag does.
    if (this.selected) {
      this.flashIllegal(square);
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
      const overlay = this.doc.body.createDiv({ cls: "chess-bot-promo-overlay" });
      const box = overlay.createDiv({ cls: "chess-bot-promo-choices" });
      const options: PieceSymbol[] = ["q", "r", "b", "n"];
      const finish = (result: PieceSymbol | undefined) => {
        this.doc.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(result);
      };
      const onKey = (e: Event) => {
        if ((e as KeyboardEvent).key === "Escape") finish(undefined);
      };
      for (const type of options) {
        const btn = box.createEl("button");
        setTooltip(btn, this.promotionLabel(type));
        btn.appendChild(createPieceImage(type, color, this.doc));
        btn.addEventListener("click", () => finish(type));
      }
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) finish(undefined);
      });
      this.doc.addEventListener("keydown", onKey);
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
    this.statusEl.setText(this.currentStatusText(chess, humanColor, thinking, resigned));
    this.syncToolbar();
    this.updateGameInfo();

    this.boardEl.empty();
    const last = this.controller.lastMove;
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
          figure.appendChild(createPieceImage(piece.type, piece.color, this.doc));
        }
      }
    }

    this.drawBotMoveArrow();
  }

  /**
   * The bot's last move, drawn as an arrow across the board. Two squares tinted
   * the same colour do not say which of them the piece came from, and on a full
   * board the pair is easy to miss entirely. Only the bot's move gets one: the
   * person already knows what they just played.
   *
   * Everything is measured in pixels off the squares themselves rather than
   * derived from the board's width, because the 2px grid gaps and 3px padding
   * do not scale with it: an arrow drawn for one size and stretched to another
   * drifts off the centre of a square by more than a whole square's width by
   * the far corner. Cheap enough to simply redraw — see the ResizeObserver.
   */
  private drawBotMoveArrow(): void {
    // Reachable from the settings tab, which can hold a view that has not been
    // opened yet and so has no board to draw on.
    if (!this.boardEl) return;
    this.boardEl.querySelector(".chess-bot-move-arrow")?.remove();
    if (!this.plugin.settings.showMoveArrow) return;

    const move = this.controller.lastMove;
    if (!move || move.color === this.controller.humanColor) return;

    const fromEl = this.boardEl.querySelector<HTMLElement>(`[data-square="${move.from}"]`);
    const toEl = this.boardEl.querySelector<HTMLElement>(`[data-square="${move.to}"]`);
    if (!fromEl || !toEl) return;

    const cell = fromEl.offsetWidth;
    // A pane with no layout yet measures zero; the render after it has a size
    // draws the arrow.
    if (cell <= 0) return;

    const centre = (el: HTMLElement) => ({
      x: el.offsetLeft + el.offsetWidth / 2,
      y: el.offsetTop + el.offsetHeight / 2
    });
    const start = centre(fromEl);
    const end = centre(toEl);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) return;
    const ux = (end.x - start.x) / length;
    const uy = (end.y - start.y) / length;

    // The tip stops short of the far edge, so the piece it lands on stays visible.
    const tipX = end.x - ux * cell * 0.14;
    const tipY = end.y - uy * cell * 0.14;
    const head = cell * 0.38;
    const halfHead = cell * 0.23;
    const baseX = tipX - ux * head;
    const baseY = tipY - uy * head;

    const svg = this.boardEl.createSvg("svg", { cls: "chess-bot-move-arrow" });
    svg.setAttribute("viewBox", `0 0 ${this.boardEl.clientWidth} ${this.boardEl.clientHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.createSvg("line", {
      attr: {
        x1: start.x, y1: start.y, x2: baseX, y2: baseY,
        "stroke-width": cell * 0.15, "stroke-linecap": "round"
      }
    });
    svg.createSvg("polygon", {
      attr: {
        points: [
          `${tipX},${tipY}`,
          `${baseX - uy * halfHead},${baseY + ux * halfHead}`,
          `${baseX + uy * halfHead},${baseY - ux * halfHead}`
        ].join(" ")
      }
    });
  }

  /**
   * Answers a move that cannot be played. Without it a click that misses is
   * indistinguishable from one the board ignored, and a piece that is pinned or
   * stuck behind a check looks simply broken — so the king is flashed too, since
   * that is where the reason usually is.
   */
  private flashIllegal(...squares: (Square | null)[]): void {
    for (const square of squares) {
      if (!square) continue;
      const cell = this.boardEl.querySelector<HTMLElement>(`[data-square="${square}"]`);
      if (!cell) continue;
      // Re-adding a class that is already there does not restart its animation,
      // so clicking the same square twice would flash only the first time.
      cell.removeClass("illegal");
      void cell.offsetWidth;
      cell.addClass("illegal");
      this.win.setTimeout(() => cell.removeClass("illegal"), ILLEGAL_FLASH_MS);
    }
  }

  /** The king, when it is in check and is not the piece being complained about. */
  private checkedKingSquare(clicked: Square): Square | null {
    const { chess } = this.controller;
    if (!chess.isCheck()) return null;
    const king = findKing(chess, this.controller.humanColor);
    return king === clicked ? null : king;
  }

  private currentStatusText(
    chess: GameController["chess"], humanColor: PlayerColor, thinking: boolean, resigned: boolean
  ): string {
    if (this.controller.engineError) return "Движок не запустился — бот не может сходить.";
    const base = this.controller.timedOut
      ? "Время вышло — вы проиграли."
      : statusText(chess, humanColor, thinking, resigned);
    return this.controller.isGameOver ? `${base} Правая кнопка — новая партия.` : base;
  }

  private updateClock(): void {
    const clockEnabled = this.controller.clockEnabled;
    this.clockEl.toggleClass("hidden", !clockEnabled);
    if (!clockEnabled) return;

    const remaining = this.controller.remainingHumanTimeMs;
    const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const increment = this.controller.incrementMs / 1000;
    this.clockEl.setText(`⏱ ${minutes}:${seconds}${increment > 0 ? ` +${increment}` : ""}`);
    this.clockEl.toggleClass("low", remaining > 0 && remaining <= 60_000);

    // A clock that visibly sits still needs to say why, or it reads as broken.
    const started = this.controller.clockStarted;
    const bonus = increment > 0 ? `, +${increment} с за каждый ваш ход` : "";
    this.clockEl.toggleClass("waiting", !started);
    setTooltip(this.clockEl, started
      ? `Ваше время на партию${bonus}`
      : `Часы пойдут с вашего первого хода${bonus}`);

    if (remaining <= 0 && this.controller.expireHumanClock()) {
      this.sounds.play("loss");
      void this.plugin.persistGame();
    }
  }

  private updateGameInfo(): void {
    this.updateClock();

    const human = this.controller.humanColor;
    const opponent = human === "w" ? "b" : "w";
    const { [human]: humanPoints, [opponent]: botPoints } = this.materialPoints();
    const balance = humanPoints - botPoints;
    this.scoreEl.setText(balance > 0 ? `+${balance}` : String(balance).replace("-", "−"));
    setTooltip(this.scoreEl, `Материал на доске: вы ${humanPoints} — ${botPoints} бот`);
    this.scoreEl.toggleClass("advantage", balance > 0);
    this.scoreEl.toggleClass("disadvantage", balance < 0);

    this.updateEvaluation();
  }

  private updateEvaluation(): void {
    const last = this.controller.lastEval;
    const book = this.controller.lastMoveFromBook;
    const show = this.plugin.settings.showEvaluation && (last !== null || book);
    this.evalEl.toggleClass("hidden", !show);
    if (!show) return;

    if (book || !last) {
      // A book move was not searched, so showing "0.0" would be a lie about a
      // position the bot never evaluated.
      this.evalEl.setText("книга");
      setTooltip(this.evalEl, "Ход из дебютной книги — бот его не считал");
      this.evalEl.removeClass("advantage");
      this.evalEl.removeClass("disadvantage");
      return;
    }

    // The engine scores from white's point of view; flip it so "+" always
    // means the person playing is better off.
    const fromHuman = this.controller.humanColor === "w" ? last.cp : -last.cp;
    if (Math.abs(fromHuman) >= MATE_THRESHOLD) {
      this.evalEl.setText(fromHuman > 0 ? "мат" : "−мат");
    } else {
      const pawns = fromHuman / 100;
      this.evalEl.setText(`${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(1)}`);
    }
    setTooltip(this.evalEl, `Оценка бота после его хода, глубина ${last.depth}`);
    this.evalEl.toggleClass("advantage", fromHuman > 0);
    this.evalEl.toggleClass("disadvantage", fromHuman < 0);
  }

  /**
   * Material each side still has, read straight off the position.
   *
   * This used to add up captures from the verbose game history instead, which
   * costs 6 ms once a game passes 120 plies (reading the board costs ~1 µs) and
   * quietly ignored promotions: a bot that queened a pawn left the balance
   * showing whatever it was before, so the pill said "even" in a lost position.
   */
  private materialPoints(): Record<"w" | "b", number> {
    const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    const points: Record<"w" | "b", number> = { w: 0, b: 0 };
    for (const row of this.controller.chess.board()) {
      for (const cell of row) {
        if (cell) points[cell.color] += values[cell.type];
      }
    }
    return points;
  }
}
