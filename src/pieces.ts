import type { Color, PieceSymbol } from "chess.js";
import { PIECE_IMAGES } from "./piece-assets";

/**
 * Creates one of the original white/black Papercut SVG pieces. `doc` is the
 * view's own document, so pieces still render in a popped-out window.
 *
 * `createElement`, not Obsidian's `createEl`, and not because nobody thought of
 * it: `Node.prototype.createEl` passes `parent: this` on to the global helper,
 * so calling it on a *document* asks the DOM to append an <img> to the document
 * itself and throws. The helper also builds its element with the main window's
 * `document.createElement`, which is the one thing a popped-out board must not
 * do. eslint-plugin-obsidianmd flags this line; the flag is wrong here.
 */
export function createPieceImage(type: PieceSymbol, color: Color, doc: Document): HTMLImageElement {
  const image = doc.createElement("img");
  image.className = "chess-piece-image";
  image.src = PIECE_IMAGES[`${color}${type}`];
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.draggable = false;
  return image;
}
