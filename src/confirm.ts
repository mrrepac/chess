import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";

/**
 * A yes/no box for the one button on the board that cannot be taken back
 * cheaply. Resigning sits next to "new game", is a single click, and now also
 * counts towards the difficulty streak — worth one question.
 */
class ConfirmModal extends Modal {
  private decided = false;
  private confirmEl: HTMLButtonElement | null = null;
  private cancelEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly confirmLabel: string,
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton(button => {
        button.setButtonText(t("btnCancel")).onClick(() => this.finish(false));
        this.cancelEl = button.buttonEl;
      })
      .addButton(button => {
        button.setButtonText(this.confirmLabel).setWarning().onClick(() => this.finish(true));
        this.confirmEl = button.buttonEl;
      });

    // Enter answers the box the same way Escape already does, just the other
    // way round.
    //
    // Straight off the document, in the capture phase, rather than through
    // `this.scope.register("Enter")` — that never fired here, and the key went
    // on reaching whichever button the browser had focused, which is "Cancel".
    // Nothing else can be listening while a modal is open, so capturing the key
    // outright is safe and does not depend on where the focus ended up.
    this.contentEl.doc.addEventListener("keydown", this.handleKey, true);
    // The confirming button is the default answer, so it should look focused
    // too. Deferred because opening the box moves the focus itself, after this.
    this.contentEl.win.setTimeout(() => this.confirmEl?.focus(), 0);
  }

  private handleKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || this.decided) return;
    // Deliberately tabbing to "Cancel" is the one case Enter must not read as
    // agreement: there the key belongs to the button the person chose.
    if (this.contentEl.doc.activeElement === this.cancelEl) return;
    event.preventDefault();
    event.stopPropagation();
    this.finish(true);
  };

  /** Closing by Escape or by clicking outside also has to answer the promise,
   *  or the caller waits for a decision that will never arrive. */
  onClose(): void {
    this.contentEl.doc.removeEventListener("keydown", this.handleKey, true);
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
  }

  private finish(confirmed: boolean): void {
    this.decided = true;
    this.resolve(confirmed);
    this.close();
  }
}

export function confirm(app: App, title: string, body: string, confirmLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    new ConfirmModal(app, title, body, confirmLabel, resolve).open();
  });
}
