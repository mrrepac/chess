import type { Color, PieceSymbol } from "chess.js";
import { STAUNTY_PIECES } from "./staunty-assets";

/** Creates one of the original white/black Staunty SVG pieces. `doc` is the
 *  view's own document, so pieces still render in a popped-out window. */
export function createPieceImage(type: PieceSymbol, color: Color, doc: Document): HTMLImageElement {
  const image = doc.createElement("img");
  image.className = "chess-piece-image";
  image.src = STAUNTY_PIECES[`${color}${type}`];
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.draggable = false;
  return image;
}
