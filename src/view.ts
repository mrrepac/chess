import { ItemView, Menu, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import type ChessBotPlugin from "./main";
import type { GameController } from "./game-controller";
import { clampDifficulty, formatRecord, MAX_DIFFICULTY, MIN_DIFFICULTY } from "./types";
import { describeDifficulty, t } from "./i18n";
import type { I18nKey } from "./i18n";
import type { Difficulty, PlayerColor } from "./types";
import {
  findKing, illegalMoveReason, isLightSquare, legalMovesFrom, squareAt, statusText
} from "./rules";
import { createPieceImage } from "./pieces";
import { confirm } from "./confirm";
import { ChessSounds } from "./sound";

export const VIEW_TYPE_CHESS = "chess-bot-view";

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
  private topbarEl: HTMLElement;
  private statusDotEl: HTMLElement;
  private boardEl: HTMLElement;
  private statusEl: HTMLElement;
  private clockEl: HTMLElement;
  private scoreEl: HTMLElement;
  private lastMoveEl: HTMLElement;
  private retryBtn: HTMLButtonElement;
  private reviewPly: number | null = null;
  private viewedChess: Chess;
  private viewedLastMove: Move | null = null;
  private selected: Square | null = null;
  private legalTargets = new Set<Square>();
  private flipped = false;
  private unsubscribe: (() => void) | null = null;
  private sounds: ChessSounds;
  private drag: DragState | null = null;
  private pressSquare: Square | null = null;
  private clockTimer: number | null = null;
  private boardResize: ResizeObserver | null = null;
  private keyboardSquare: Square | null = null;
  private transientHint: string | null = null;
  private hintTimer: number | null = null;
  private newGamePromptOpen = false;
  /** Dismisses a promotion picker that was mounted outside the view root. */
  private finishPromotion: ((result: PieceSymbol | undefined) => void) | null = null;
  /** The level and contextual action can change behind the view's back. */
  private syncToolbar: () => void = () => {};

  constructor(leaf: WorkspaceLeaf, plugin: ChessBotPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.controller = plugin.controller;
    this.viewedChess = this.controller.chess;
    this.sounds = new ChessSounds(() =>
      this.plugin.settings.soundEnabled ? this.plugin.settings.soundVolume / 100 : 0
    );
  }

  getViewType(): string {
    return VIEW_TYPE_CHESS;
  }

  getDisplayText(): string {
    return t("viewTitle");
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
    root.removeEventListener("keydown", this.handleViewKeyDown);
    root.addEventListener("keydown", this.handleViewKeyDown);

    this.topbarEl = root.createDiv({ cls: "chess-bot-topbar" });
    const statusGroup = this.topbarEl.createDiv({ cls: "chess-bot-status-group" });
    this.statusDotEl = statusGroup.createSpan({ cls: "chess-bot-status-dot" });
    this.statusDotEl.setAttribute("aria-hidden", "true");
    this.statusEl = statusGroup.createDiv({ cls: "chess-bot-status" });
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.lastMoveEl = statusGroup.createSpan({ cls: "chess-bot-last-move" });
    this.retryBtn = statusGroup.createEl("button", { cls: "chess-bot-retry-button" });
    setIcon(this.retryBtn, "refresh-cw");
    setTooltip(this.retryBtn, t("tipRetry"));
    this.retryBtn.addEventListener("click", () => void this.maybeTriggerBot());

    const controls = this.topbarEl.createDiv({ cls: "chess-bot-controls" });
    this.clockEl = controls.createSpan({ cls: "chess-bot-clock" });
    this.scoreEl = controls.createSpan({ cls: "chess-bot-score" });

    // Obsidian draws its own tooltip for anything carrying an aria-label, so an
    // element with both that and a `title` gets two of them, one over the other.
    // setTooltip is the one mechanism: it sets the aria-label and leaves the
    // native tooltip out of it.
    const iconButton = (icon: string, label: string): HTMLButtonElement => {
      const button = controls.createEl("button", { cls: "chess-bot-icon-button" });
      setIcon(button, icon);
      setTooltip(button, label);
      return button;
    };

    const actionBtn = iconButton("plus", t("tipNewGame"));
    actionBtn.addEventListener("click", () => {
      if (this.reviewPly !== null) return;
      if (!this.controller.isGameOver && this.controller.historyLength > 0) {
        void this.resignWithConfirmation();
      } else {
        void this.startNewGame();
      }
    });

    const difficultyBtn = controls.createEl("button", {
      cls: "chess-bot-difficulty-button",
      text: String(this.plugin.settings.difficulty)
    });
    const updateDifficultyLabel = () => {
      const current = this.controller.gameDifficulty;
      const next = this.plugin.settings.difficulty;
      difficultyBtn.empty();
      difficultyBtn.createSpan({ cls: "chess-bot-level-prefix", text: t("levelPrefix") });
      difficultyBtn.createSpan({ text: current === next ? String(current) : `${current}→${next}` });
      // One line: the tooltip is a single run of text, so a newline in here
      // would come out as a space anyway.
      setTooltip(difficultyBtn, [
        t("tipLevelCurrent", { current, max: MAX_DIFFICULTY }),
        next === current ? t("tipLevelNextSame") : t("tipLevelNext", { next }),
        this.plugin.describeLevelRecord(current),
        t("tipLevelPick", { streak: this.plugin.describeStreak() })
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
      event.stopPropagation();
      this.showDifficultyMenu(event);
    });

    const updateButtonStates = () => {
      const canResign = !this.controller.isGameOver && this.controller.historyLength > 0;
      const finished = this.controller.isGameOver;
      actionBtn.empty();
      setIcon(actionBtn, canResign ? "flag" : "plus");
      actionBtn.toggleClass("finished", finished);
      if (finished) actionBtn.createSpan({ cls: "chess-bot-action-label", text: t("labelNew") });
      actionBtn.disabled = this.reviewPly !== null;
      setTooltip(actionBtn, this.reviewPly !== null
        ? t("tipReviewFirst")
        : canResign ? t("tipResign") : finished ? t("tipNewGameEnter") : t("tipNewGame"));
    };

    this.syncToolbar = () => {
      updateDifficultyLabel();
      updateButtonStates();
    };
    this.syncToolbar();
    this.boardEl = root.createDiv({ cls: "chess-bot-board" });
    this.boardEl.setAttribute("role", "grid");
    this.boardEl.setAttribute("aria-label", t("ariaBoard"));
    this.boardEl.setAttribute("aria-rowcount", "8");
    this.boardEl.setAttribute("aria-colcount", "8");
    this.boardEl.addEventListener("pointerdown", this.handlePointerDown);
    this.boardEl.addEventListener("keydown", this.handleBoardKeyDown);
    this.boardEl.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    // The move arrow is drawn in pixels off the squares it connects, so every
    // resize of the pane needs it drawn again. It also covers the first paint:
    // a board with no layout yet has nothing to measure, and this fires as soon
    // as it does. The constructor comes from the view's own window, so a
    // popped-out board observes with that window's implementation.
    const win = this.win as unknown as { ResizeObserver: typeof ResizeObserver };
    this.boardResize = new win.ResizeObserver(() => this.drawBotMoveArrow());
    this.boardResize.observe(this.boardEl);

    this.clearAncestorWidthCaps();
    this.unsubscribe = this.controller.onChange(() => this.render());
    this.applyOrientation();
    this.controller.openBoard();
    this.render();
    // Only the clock changes between repaints; everything else on that row is
    // driven by controller notifications, so it does not belong on a timer.
    this.clockTimer = this.win.setInterval(() => this.updateClock(), 250);
    void this.maybeTriggerBot();
  }

  /** Called by the plugin when a setting the board mirrors changed elsewhere. */
  refreshFromSettings(): void {
    const wasFlipped = this.flipped;
    this.applyOrientation();
    this.syncToolbar();
    if (wasFlipped !== this.flipped) this.render();
    else this.drawBotMoveArrow();
  }

  private applyOrientation(): void {
    const orientation = this.plugin.settings.boardOrientation;
    this.flipped = orientation === "black"
      || (orientation === "player" && this.controller.humanColor === "b");
  }

  private stepDifficulty(step: 1 | -1): void {
    const next = clampDifficulty(this.plugin.settings.difficulty + step);
    if (next !== this.plugin.settings.difficulty) void this.plugin.setDifficulty(next);
  }

  private stepHistory(step: 1 | -1): void {
    const total = this.controller.historyLength;
    if (total === 0) return;
    const current = this.reviewPly ?? total;
    const target = Math.min(total, Math.max(0, current + step));
    this.reviewPly = target === total ? null : target;
    this.selected = null;
    this.legalTargets.clear();
    this.finishDrag();
    this.render();
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
    this.contentEl.removeEventListener("keydown", this.handleViewKeyDown);
    this.finishPromotion?.(undefined);
    this.finishDrag();
    this.sounds.close();
    this.boardResize?.disconnect();
    this.boardResize = null;
    if (this.clockTimer !== null) this.win.clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.hintTimer !== null) this.win.clearTimeout(this.hintTimer);
    this.hintTimer = null;
    // The clock belongs to time spent at the board, not to wall time.
    this.controller.closeBoard();
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
      this.stepHistory(-1);
      return;
    }
    if (event.button !== 0) return;

    const cell = (event.target as HTMLElement).closest<HTMLElement>(".chess-bot-square");
    const square = cell?.dataset.square as Square | undefined;
    if (!cell || !square || !this.boardEl.contains(cell)) return;
    this.keyboardSquare = square;
    if (this.reviewPly !== null) {
      event.preventDefault();
      this.stepHistory(1);
      return;
    }
    if (!this.controller.isHumanTurn) return;

    event.preventDefault();
    this.pressSquare = square;
    this.doc.addEventListener("pointerup", this.handlePointerUp);
    this.doc.addEventListener("pointercancel", this.handlePointerCancel);

    const piece = this.controller.chess.get(square);
    if (!piece || piece.color !== this.controller.humanColor) return;

    this.selected = square;
    this.legalTargets = new Set(legalMovesFrom(this.controller.chess, square).map(m => m.to));
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

  /** Roving keyboard focus keeps the board to one Tab stop. Arrow keys move in
   *  screen order, so they remain intuitive when the board is flipped. */
  private handleBoardKeyDown = (event: KeyboardEvent): void => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>(".chess-bot-square");
    if (!cell || !this.boardEl.contains(cell)) return;
    const cells = Array.from(this.boardEl.querySelectorAll<HTMLElement>(".chess-bot-square"));
    const index = cells.indexOf(cell);
    let next = index;
    if (event.key === "ArrowLeft" && index % 8 > 0) next--;
    else if (event.key === "ArrowRight" && index % 8 < 7) next++;
    else if (event.key === "ArrowUp" && index >= 8) next -= 8;
    else if (event.key === "ArrowDown" && index < 56) next += 8;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const square = cell.dataset.square as Square | undefined;
      if (square) void this.handleSquareClick(square);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (this.reviewPly !== null) this.reviewPly = null;
      this.selected = null;
      this.legalTargets.clear();
      this.render();
      return;
    } else return;

    event.preventDefault();
    const destination = cells[next];
    this.keyboardSquare = destination.dataset.square as Square;
    cell.tabIndex = -1;
    destination.tabIndex = 0;
    destination.focus();
  };

  /** Once the result is on the board, Enter deals the next game. Keep native
   *  button/input activation intact when focus is on an actual control. */
  private handleViewKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || !this.controller.isGameOver) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, select, textarea")) return;
    event.preventDefault();
    event.stopPropagation();
    void this.startNewGame();
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
        if (target && target !== drag?.from) {
          this.flashIllegal(target);
          this.explainIllegalMove(drag?.from ?? null, target);
        }
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

    // Plain createElement, for the reason spelled out in pieces.ts: Obsidian's
    // createSpan on a *document* tries to append the span to the document
    // itself and throws.
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

  private async startNewGame(): Promise<void> {
    if (this.newGamePromptOpen) return;
    if (!this.controller.isGameOver && this.controller.chess.history().length > 0) {
      this.newGamePromptOpen = true;
      let agreed: boolean;
      try {
        agreed = await confirm(
          this.app,
          t("newGameTitle"),
          t("newGameBody"),
          t("newGameConfirm")
        );
      } finally {
        this.newGamePromptOpen = false;
      }
      if (!agreed) return;
    }
    if (this.hintTimer !== null) this.win.clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.transientHint = null;
    this.reviewPly = null;
    const pref = this.plugin.settings.playerColor;
    const humanColor: PlayerColor = pref === "random" ? (Math.random() < 0.5 ? "w" : "b") : pref;
    this.selected = null;
    this.legalTargets.clear();
    this.controller.newGame(
      humanColor,
      this.plugin.timeControlMs,
      this.plugin.incrementMs,
      this.plugin.settings.difficulty
    );
    this.applyOrientation();
    this.sounds.play("start");
    void this.plugin.persistGame();
    void this.maybeTriggerBot();
  }

  private async resignWithConfirmation(): Promise<void> {
    if (this.controller.isGameOver) return;
    const cost = this.plugin.settings.adaptiveDifficulty ? t("resignCost") : "";
    const agreed = await confirm(
      this.app,
      t("resignTitle"),
      t("resignBody", { cost }),
      t("resignConfirm")
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
    const move = await this.controller.requestBotMove();
    if (move) {
      this.playMoveSound(move);
      void this.plugin.persistGame();
    }
  }

  private async handleSquareClick(square: Square): Promise<void> {
    if (this.reviewPly !== null) return;
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
      this.legalTargets = new Set(moves.map(m => m.to));
      this.render();
      // A piece with nowhere to go looks exactly like one the click missed.
      if (moves.length === 0) {
        this.flashIllegal(square, this.checkedKingSquare(square));
        this.showHint(t(this.controller.chess.isCheck() ? "hintNoDefence" : "hintNoMoves"));
      }
      return;
    }

    // An empty square or one of the bot's, with a piece already in hand: the
    // move was aimed somewhere it cannot go. The piece stays picked up so the
    // next click can aim again — the same thing a dropped drag does.
    if (this.selected) {
      this.flashIllegal(square);
      this.explainIllegalMove(this.selected, square);
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

  private defaultKeyboardSquare(): Square {
    return this.flipped ? "h1" : "a8";
  }

  private squareLabel(
    square: Square,
    piece: { type: PieceSymbol; color: "w" | "b" } | undefined
  ): string {
    const parts: string[] = [square];
    if (piece) {
      const name = t(`piece${piece.type.toUpperCase()}` as I18nKey);
      parts.push(`${t(piece.color === "w" ? "colorWhite" : "colorBlack")}, ${name}`);
    } else parts.push(t("squareEmpty"));
    if (square === this.selected) parts.push(t("squareSelected"));
    else if (this.legalTargets.has(square)) parts.push(t(piece ? "squareCapture" : "squareMove"));
    return parts.join(", ");
  }

  private updateLastMoveLabel(): void {
    const move = this.viewedLastMove;
    if (!move) {
      this.lastMoveEl.addClass("hidden");
      this.lastMoveEl.setText("");
      return;
    }
    const moveNumber = Number(move.before.split(" ")[5]) || this.viewedChess.moveNumber();
    this.lastMoveEl.setText(move.color === "w" ? `${moveNumber}.${move.san}` : `${moveNumber}…${move.san}`);
    this.lastMoveEl.removeClass("hidden");
    setTooltip(this.lastMoveEl, t("tipLastMove"));
  }

  private explainIllegalMove(from: Square | null, to: Square): void {
    if (!from) return;
    this.showHint(illegalMoveReason(this.controller.chess, from, to));
  }

  private showHint(text: string): void {
    this.transientHint = text;
    this.statusEl.setText(text);
    if (this.hintTimer !== null) this.win.clearTimeout(this.hintTimer);
    this.hintTimer = this.win.setTimeout(() => {
      this.hintTimer = null;
      this.transientHint = null;
      this.statusEl.setText(this.currentStatusText(
        this.controller.chess,
        this.controller.humanColor,
        this.controller.thinking,
        this.controller.resigned
      ));
    }, 1800);
  }

  /** A small overlay with the four promotion choices; resolves to undefined if dismissed. */
  private pickPromotion(): Promise<PieceSymbol | undefined> {
    return new Promise(resolve => {
      const color = this.controller.humanColor;
      const overlay = this.doc.body.createDiv({ cls: "chess-bot-promo-overlay" });
      const box = overlay.createDiv({ cls: "chess-bot-promo-choices" });
      const options: PieceSymbol[] = ["q", "r", "b", "n"];
      let settled = false;
      const finish = (result: PieceSymbol | undefined) => {
        if (settled) return;
        settled = true;
        this.doc.removeEventListener("keydown", onKey);
        overlay.remove();
        if (this.finishPromotion === finish) this.finishPromotion = null;
        resolve(result);
      };
      const onKey = (e: Event) => {
        if ((e as KeyboardEvent).key === "Escape") finish(undefined);
      };
      this.finishPromotion = finish;
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
    return t("promoteTo", { piece: t(`promo${type.toUpperCase()}` as I18nKey) });
  }

  private render(): void {
    const { humanColor, thinking, resigned } = this.controller;
    const total = this.controller.historyLength;
    if (this.reviewPly !== null && this.reviewPly >= total) this.reviewPly = null;
    if (this.reviewPly === null) {
      this.viewedChess = this.controller.chess;
      this.viewedLastMove = this.controller.lastMove;
    } else {
      const viewed = this.controller.positionAtPly(this.reviewPly);
      this.viewedChess = viewed.chess;
      this.viewedLastMove = viewed.lastMove;
    }
    const chess = this.viewedChess;
    this.boardEl.toggleClass("reviewing", this.reviewPly !== null);
    this.boardEl.setAttribute("aria-label", this.reviewPly === null
      ? t("ariaBoard")
      : t("ariaReview", { ply: this.reviewPly, total }));
    const restoreFocus = this.boardEl?.contains(this.doc.activeElement) ?? false;
    const status = this.reviewPly === null
      ? this.currentStatusText(this.controller.chess, humanColor, thinking, resigned)
      : t("statusReview", { ply: this.reviewPly, total });
    this.statusEl.setText(this.transientHint ?? status);
    const outcome = this.controller.outcome;
    const tone = this.reviewPly !== null
      ? "review"
      : this.controller.engineError
        ? "alert"
        : outcome
          ? `result-${outcome}`
          : this.controller.chess.isCheck() && this.controller.isHumanTurn
            ? "alert"
            : this.controller.isHumanTurn ? "ready" : "bot";
    this.statusDotEl.className = `chess-bot-status-dot ${tone}`;
    this.topbarEl.toggleClass("finished", outcome !== null);
    this.retryBtn.toggleClass("hidden", this.reviewPly !== null || !this.controller.engineError);
    this.updateLastMoveLabel();
    this.syncToolbar();
    this.updateGameInfo();

    this.boardEl.empty();
    const last = this.viewedLastMove;
    const kingInCheck = chess.isCheck() ? findKing(chess, chess.turn()) : null;

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const rank = this.flipped ? 7 - r : r;
        const file = this.flipped ? 7 - f : f;
        const square = squareAt(file, rank);

        const cellEl = this.boardEl.createDiv({ cls: "chess-bot-square" });
        cellEl.dataset.square = square;
        cellEl.setAttribute("role", "gridcell");
        cellEl.setAttribute("aria-rowindex", String(r + 1));
        cellEl.setAttribute("aria-colindex", String(f + 1));
        cellEl.setAttribute("aria-selected", square === this.selected ? "true" : "false");
        cellEl.setAttribute("aria-disabled",
          this.reviewPly === null && this.controller.isHumanTurn ? "false" : "true");
        cellEl.tabIndex = square === (this.keyboardSquare ?? this.defaultKeyboardSquare()) ? 0 : -1;
        cellEl.addClass(isLightSquare(file, rank) ? "light" : "dark");
        if (square === this.selected) cellEl.addClass("selected");
        if (last && (square === last.from || square === last.to)) cellEl.addClass("last-move");
        if (square === kingInCheck) cellEl.addClass("in-check");

        const piece = chess.get(square);
        cellEl.setAttribute("aria-label", this.squareLabel(square, piece));
        if (this.legalTargets.has(square)) {
          cellEl.addClass(piece ? "legal-capture" : "legal-target");
        }
        if (piece) {
          const figure = cellEl.createSpan({ cls: "chess-bot-piece" });
          figure.appendChild(createPieceImage(piece.type, piece.color, this.doc));
        }
        // Coordinates live inside edge cells, so they cost no board space.
        if (r === 7) cellEl.createSpan({ cls: "chess-bot-coordinate file", text: square[0] });
        if (f === 0) cellEl.createSpan({ cls: "chess-bot-coordinate rank", text: square[1] });
      }
    }

    this.drawBotMoveArrow();
    if (restoreFocus) {
      const square = this.keyboardSquare ?? this.defaultKeyboardSquare();
      this.win.setTimeout(() => {
        this.boardEl.querySelector<HTMLElement>(`[data-square="${square}"]`)?.focus();
      }, 0);
    }
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

    const move = this.viewedLastMove;
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
    if (this.controller.engineError) return t("stEngineError");
    if (this.controller.timedOut) return t("resTimeout");
    if (resigned) return t("resResign");
    if (chess.isCheckmate()) return t(chess.turn() === humanColor ? "resMateLoss" : "resMateWin");
    if (chess.isStalemate()) return t("resStalemate");
    if (chess.isThreefoldRepetition()) return t("resRepetition");
    if (chess.isInsufficientMaterial()) return t("resInsufficient");
    if (chess.isDraw()) return t("resDraw");
    return statusText(chess, humanColor, thinking, resigned);
  }

  private updateClock(): void {
    const clockEnabled = this.controller.clockEnabled;
    const show = clockEnabled && this.reviewPly === null;
    this.clockEl.toggleClass("hidden", !show);
    if (!show) return;

    const remaining = this.controller.remainingHumanTimeMs;
    const totalSeconds = Math.max(0, Math.ceil(remaining / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const increment = this.controller.incrementMs / 1000;
    this.clockEl.setText(`${minutes}:${seconds}`);
    this.clockEl.toggleClass("low", remaining > 0 && remaining <= 60_000);

    // A clock that visibly sits still needs to say why, or it reads as broken.
    const started = this.controller.clockStarted;
    const bonus = increment > 0 ? t("clockBonus", { seconds: increment }) : "";
    this.clockEl.toggleClass("waiting", !started);
    setTooltip(this.clockEl, t(started ? "tipClock" : "tipClockWaiting", { bonus }));

    if (remaining <= 0 && this.controller.expireHumanClock()) {
      this.sounds.play("loss");
      void this.plugin.persistGame();
    }
  }

  private updateGameInfo(): void {
    this.updateClock();

    const human = this.controller.humanColor;
    const opponent = human === "w" ? "b" : "w";
    const { [human]: humanPoints, [opponent]: botPoints } = this.materialPoints(this.viewedChess);
    const balance = humanPoints - botPoints;
    const material = balance > 0 ? `+${balance}` : String(balance).replace("-", "−");
    this.scoreEl.setText(balance === 0 ? t("scoreEven") : material);
    setTooltip(this.scoreEl, t("tipMaterial", { human: humanPoints, bot: botPoints }));
    this.scoreEl.toggleClass("advantage", balance > 0);
    this.scoreEl.toggleClass("disadvantage", balance < 0);

  }

  /**
   * Material each side still has, read straight off the position.
   *
   * This used to add up captures from the verbose game history instead, which
   * costs 6 ms once a game passes 120 plies (reading the board costs ~1 µs) and
   * quietly ignored promotions: a bot that queened a pawn left the balance
   * showing whatever it was before, so the pill said "even" in a lost position.
   */
  private materialPoints(chess: Chess): Record<"w" | "b", number> {
    const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    const points: Record<"w" | "b", number> = { w: 0, b: 0 };
    for (const row of chess.board()) {
      for (const cell of row) {
        if (cell) points[cell.color] += values[cell.type];
      }
    }
    return points;
  }
}
