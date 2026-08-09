import type { Color, PieceSymbol } from "chess.js";
import { STAUNTY_PIECES } from "./staunty-assets";

/** Creates one of the original white/black Staunty SVG pieces. */
export function createPieceImage(type: PieceSymbol, color: Color): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "chess-piece-image";
  image.src = STAUNTY_PIECES[`${color}${type}`];
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  image.draggable = false;
  return image;
}
