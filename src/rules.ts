import { Chess, type Color, type Move, type Square } from "chess.js";
import type { PlayerColor } from "./types";

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = [8, 7, 6, 5, 4, 3, 2, 1] as const;

export function squareAt(file: number, rank: number): Square {
  return `${FILES[file]}${RANKS[rank]}` as Square;
}

export function isLightSquare(file: number, rank: number): boolean {
  return (file + rank) % 2 === 0;
}

export function legalMovesFrom(chess: Chess, square: Square): Move[] {
  return chess.moves({ square, verbose: true }) as Move[];
}

/** Human-readable game state, in Russian, from the perspective of the person playing. */
export function statusText(chess: Chess, playerColor: PlayerColor, thinking: boolean, resigned: boolean): string {
  if (resigned) return "Вы сдались.";
  if (chess.isCheckmate()) {
    const winnerIsPlayer = chess.turn() !== playerColor;
    return winnerIsPlayer ? "Мат! Вы выиграли." : "Мат! Победил бот.";
  }
  if (chess.isStalemate()) return "Пат — ничья.";
  if (chess.isThreefoldRepetition()) return "Ничья — повторение позиции.";
  if (chess.isInsufficientMaterial()) return "Ничья — недостаточно материала.";
  if (chess.isDraw()) return "Ничья.";
  if (thinking) return "Бот думает…";
  const toMove = chess.turn() === playerColor ? "Ваш ход" : "Ход бота";
  return chess.isCheck() ? `${toMove} — шах!` : toMove;
}

export function findKing(chess: Chess, color: Color): Square | null {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === "k" && cell.color === color) return cell.square;
    }
  }
  return null;
}
