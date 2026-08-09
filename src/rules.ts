import { Chess, type Color, type Move, type Square } from "chess.js";
import type { PlayerColor } from "./types";
import { t } from "./i18n";

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = [8, 7, 6, 5, 4, 3, 2, 1] as const;

export function squareAt(file: number, rank: number): Square {
  return `${FILES[file]}${RANKS[rank]}` as Square;
}

export function isLightSquare(file: number, rank: number): boolean {
  return (file + rank) % 2 === 0;
}

export function legalMovesFrom(chess: Chess, square: Square): Move[] {
  return chess.moves({ square, verbose: true });
}

/** A short explanation for an attempted move that is not in the legal list.
 *  Geometry and blockers are checked first; a geometrically valid move that is
 *  still illegal necessarily fails the king-safety rules. */
export function illegalMoveReason(chess: Chess, from: Square, to: Square): string {
  const piece = chess.get(from);
  if (!piece) return t("illNoPiece");
  const target = chess.get(to);
  if (target?.color === piece.color) return t("illOwnPiece");

  const fromFile = from.charCodeAt(0) - 97;
  const toFile = to.charCodeAt(0) - 97;
  const fromRank = Number(from[1]);
  const toRank = Number(to[1]);
  const df = toFile - fromFile;
  const dr = toRank - fromRank;
  const adf = Math.abs(df);
  const adr = Math.abs(dr);
  let slides = false;
  let geometry = false;

  switch (piece.type) {
    case "p": {
      const direction = piece.color === "w" ? 1 : -1;
      const startRank = piece.color === "w" ? 2 : 7;
      if (df === 0 && dr === direction && !target) geometry = true;
      else if (df === 0 && dr === direction * 2 && fromRank === startRank && !target) {
        const middle = `${from[0]}${fromRank + direction}` as Square;
        if (chess.get(middle)) return t("illPawnBlocked");
        geometry = true;
      } else if (adf === 1 && dr === direction && target) geometry = true;
      if (!geometry) return t("illPawnDiagonal");
      break;
    }
    case "n":
      geometry = (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
      break;
    case "b":
      geometry = adf === adr && adf > 0;
      slides = geometry;
      break;
    case "r":
      geometry = (df === 0) !== (dr === 0);
      slides = geometry;
      break;
    case "q":
      geometry = (adf === adr && adf > 0) || ((df === 0) !== (dr === 0));
      slides = geometry;
      break;
    case "k":
      geometry = Math.max(adf, adr) === 1 || (adr === 0 && adf === 2);
      break;
  }

  if (!geometry) return t("illGeometry");
  if (piece.type === "k" && adf === 2) {
    const middle = `${String.fromCharCode(97 + fromFile + Math.sign(df))}${fromRank}` as Square;
    if (chess.get(middle)) return t("illCastleBlocked");
    return chess.isCheck() ? t("illCastleCheck") : t("illCastleUnavailable");
  }
  if (slides) {
    const fileStep = Math.sign(df);
    const rankStep = Math.sign(dr);
    let file = fromFile + fileStep;
    let rank = fromRank + rankStep;
    while (file !== toFile || rank !== toRank) {
      if (chess.get(`${String.fromCharCode(97 + file)}${rank}` as Square)) {
        return t("illPathBlocked");
      }
      file += fileStep;
      rank += rankStep;
    }
  }
  return chess.isCheck() ? t("illStillCheck") : t("illKingExposed");
}

/** Human-readable game state, from the perspective of the person playing. */
export function statusText(chess: Chess, playerColor: PlayerColor, thinking: boolean, resigned: boolean): string {
  if (resigned) return t("stResigned");
  if (chess.isCheckmate()) {
    const winnerIsPlayer = chess.turn() !== playerColor;
    return winnerIsPlayer ? t("stMateWin") : t("stMateLoss");
  }
  if (chess.isStalemate()) return t("stStalemate");
  if (chess.isThreefoldRepetition()) return t("stRepetition");
  if (chess.isInsufficientMaterial()) return t("stInsufficient");
  if (chess.isDraw()) return t("stDraw");
  if (thinking) return t("stThinking");
  const toMove = chess.turn() === playerColor ? t("stYourMove") : t("stBotMove");
  return chess.isCheck() ? t("stCheck", { move: toMove }) : toMove;
}

export function findKing(chess: Chess, color: Color): Square | null {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === "k" && cell.color === color) return cell.square;
    }
  }
  return null;
}
