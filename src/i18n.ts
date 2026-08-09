import { moment } from "obsidian";
import type { Difficulty, LevelRecord } from "./types";

/**
 * The catalogue requires an English interface, and the strings are the only
 * part of the plugin that is not language-neutral. Kept out of types.ts on
 * purpose: that module is imported by the search, which is bundled standalone
 * into the Web Worker and must not pull `obsidian` in behind it.
 */
const en = {
  // ——— commands, view ———
  ribbonOpen: "Open chess",
  cmdOpen: "Open the board",
  viewTitle: "Chess",
  ariaBoard: "Chess board",
  ariaReview: "Reviewing the game, ply {ply} of {total}",

  // ——— toolbar ———
  tipRetry: "Ask the bot for its move again",
  tipNewGame: "New game",
  tipNewGameEnter: "New game (Enter)",
  tipResign: "Resign",
  tipReviewFirst: "Return to the current position first",
  labelNew: "New",
  levelPrefix: "Lv ",
  tipLevelCurrent: "This game is at level {current} of {max}",
  tipLevelNextSame: "A change applies to the next game",
  tipLevelNext: "Next game: level {next}",
  tipLevelPick: "Wheel and right-click pick the next level{streak}",
  tipLastMove: "Last move",
  statusReview: "Review: {ply} of {total} · right-click back, left-click forward",
  scoreEven: "Even",
  tipMaterial: "Material on the board: you {human} — bot {bot}",
  tipClock: "Your time for this game{bonus}",
  tipClockWaiting: "The clock starts with your first move{bonus}",
  clockBonus: ", +{seconds} s after each of your moves",

  // ——— board (screen reader labels) ———
  pieceP: "pawn",
  pieceN: "knight",
  pieceB: "bishop",
  pieceR: "rook",
  pieceQ: "queen",
  pieceK: "king",
  colorWhite: "white",
  colorBlack: "black",
  squareEmpty: "empty square",
  squareSelected: "selected",
  squareCapture: "can be captured",
  squareMove: "legal move",

  // ——— promotion ———
  promoteTo: "Promote to: {piece}",
  promoP: "Pawn",
  promoN: "Knight",
  promoB: "Bishop",
  promoR: "Rook",
  promoQ: "Queen",
  promoK: "King",

  // ——— status line ———
  stEngineError: "The engine did not start — the bot cannot move.",
  stResigned: "You resigned.",
  stMateWin: "Checkmate! You win.",
  stMateLoss: "Checkmate! The bot wins.",
  stStalemate: "Stalemate — a draw.",
  stRepetition: "A draw by repetition.",
  stInsufficient: "A draw — not enough material.",
  stDraw: "A draw.",
  stThinking: "The bot is thinking…",
  stYourMove: "Your move",
  stBotMove: "The bot's move",
  stCheck: "{move} — check!",

  // ——— finished game, short form ———
  resTimeout: "Loss · out of time",
  resResign: "Loss · resignation",
  resMateLoss: "Loss · checkmate",
  resMateWin: "Win · checkmate",
  resStalemate: "Draw · stalemate",
  resRepetition: "Draw · repetition",
  resInsufficient: "Draw · not enough material",
  resDraw: "Draw",

  // ——— why that move is not allowed ———
  illNoPiece: "There is no piece on that square.",
  illOwnPiece: "That square is taken by one of your own pieces.",
  illPawnBlocked: "The pawn's path is blocked.",
  illPawnDiagonal: "A pawn moves forward and captures diagonally.",
  illGeometry: "That piece does not move like that.",
  illCastleBlocked: "The path for castling is blocked.",
  illCastleCheck: "You cannot castle out of check.",
  illCastleUnavailable: "Castling is not available right now.",
  illPathBlocked: "The piece's path is blocked.",
  illStillCheck: "This move does not answer the check.",
  illKingExposed: "The king would be left in check.",
  hintNoDefence: "This piece cannot answer the check.",
  hintNoMoves: "This piece has no legal move right now.",

  // ——— confirmations ———
  btnCancel: "Cancel",
  newGameTitle: "Start a new game?",
  newGameBody: "The unfinished game will be discarded and will not be counted.",
  newGameConfirm: "New game",
  resignTitle: "Resign?",
  resignBody: "The game ends in a loss.{cost}",
  resignCost: " It counts towards the streak as a loss.",
  resignConfirm: "Resign",
  resetStatsTitle: "Reset the tally?",
  resetStatsBody: "The record for every level will be erased, with no way to bring it back.",
  resetStatsConfirm: "Reset",

  // ——— adaptive difficulty ———
  adaptUp: "A win! The bot's difficulty is up to {to}.",
  adaptDown: "A loss. The bot's difficulty is down to {to}.",
  adaptDraw: "A draw — the streak is broken, the level stays.",
  adaptMax: "A win! The difficulty is already at its highest ({max}).",
  adaptMin: "A loss. The difficulty is already at its lowest ({min}).",
  adaptWinRun: "A win! Wins in a row: {run} of {threshold}.",
  adaptLossRun: "A loss. Losses in a row: {run} of {threshold}.",
  streakWins: " · wins in a row: {run} of {threshold}",
  streakLosses: " · losses in a row: {run} of {threshold}",
  record: "Wins {wins} · losses {losses} · draws {draws}",

  // ——— what each level plays like ———
  level1: "1 — a rank beginner, hangs pieces constantly",
  level2: "2 — very weak, easy to beat",
  level3: "3 — sees one move ahead, misses trades",
  level4: "4 — counts trades, but often picks the wrong move",
  level5: "5 — plays sensibly, slips now and then",
  level6: "6 — a solid amateur, thinks for up to 1.5 s",
  level7: "7 — always plays the best move it found, up to 1.2 s",
  level8: "8 — searches deeper, thinks for up to 2 s",
  level9: "9 — the same, with more time: up to 3 s",
  level10: "10 — the engine's ceiling: up to 4 s a move, solid club strength",

  // ——— settings ———
  setDifficulty: "Difficulty of a new game",
  setAdaptive: "Adjust the difficulty to your results",
  setAdaptiveDesc:
    "The level moves a step once the same result comes up several games in a row. A draw or "
    + "stalemate breaks the streak without moving the level. Stepping back through past positions "
    + "with the mouse buttons does not change the result of a game.",
  setThreshold: "Games in a row before the level moves",
  threshold1: "1 — the level changes after every game",
  threshold2: "2 — two wins in a row raise the level, two losses lower it",
  threshold3: "3 — three wins in a row raise the level, three losses lower it",
  threshold4: "4 — four wins in a row raise the level, four losses lower it",
  threshold5: "5 — five wins in a row raise the level, five losses lower it",
  setColor: "Default color",
  setColorDesc: "Which side you play in a new game (“Random” draws for every new game).",
  optWhite: "White",
  optBlack: "Black",
  optRandom: "Random",
  setOrientation: "Board orientation",
  setOrientationDesc: "Whose pieces sit at the bottom. Applies at once and does not change your color.",
  optPlayerSide: "The player's side",
  optWhiteBottom: "White at the bottom",
  optBlackBottom: "Black at the bottom",
  setTimeControl: "Time control",
  setTimeControlDesc:
    "How many minutes you get for a game. The count starts with your first move and runs only "
    + "while the board is open.",
  optNoClock: "No clock",
  optMin5: "5 minutes",
  optMin10: "10 minutes",
  optMin15: "15 minutes",
  optMin30: "30 minutes",
  optMin60: "60 minutes",
  setIncrement: "Increment per move",
  setIncrementDesc: "How many seconds go back on your clock after each of your moves. Applies to new games.",
  optInc0: "No increment",
  optInc2: "+2 seconds",
  optInc3: "+3 seconds",
  optInc5: "+5 seconds",
  optInc10: "+10 seconds",
  optInc30: "+30 seconds",
  setArrow: "Arrow for the bot's move",
  setArrowDesc: "Draws an arrow from square to square after the bot moves. Both squares stay highlighted either way.",
  setSounds: "Game sounds",
  setSoundsDesc: "Soft sounds for moves, captures, check and the end of a game.",
  setVolume: "Sound volume",
  headStats: "Tally",
  statsEmpty: "No finished games yet. The tally will appear here on its own.",
  statsLevel: "Level {level}",
  statsTotal: "Total",
  setReset: "Reset the tally",
  setResetDesc: "Erases the record for every level. The current streak of results is left alone.",
  btnReset: "Reset"
};

const ru: typeof en = {
  ribbonOpen: "Открыть шахматы",
  cmdOpen: "Открыть доску",
  viewTitle: "Шахматы",
  ariaBoard: "Шахматная доска",
  ariaReview: "Просмотр партии, полуход {ply} из {total}",

  tipRetry: "Повторить ход бота",
  tipNewGame: "Новая партия",
  tipNewGameEnter: "Новая партия (Enter)",
  tipResign: "Сдаться",
  tipReviewFirst: "Сначала вернитесь к текущей позиции",
  labelNew: "Новая",
  levelPrefix: "Ур ",
  tipLevelCurrent: "Уровень этой партии: {current} из {max}",
  tipLevelNextSame: "Изменение применится к следующей партии",
  tipLevelNext: "Следующая партия: уровень {next}",
  tipLevelPick: "Колесо и правая кнопка — выбрать следующий уровень{streak}",
  tipLastMove: "Последний ход",
  statusReview: "Просмотр: {ply} из {total} · ПКМ назад, ЛКМ вперёд",
  scoreEven: "Ровно",
  tipMaterial: "Материал на доске: вы {human} — {bot} бот",
  tipClock: "Ваше время на партию{bonus}",
  tipClockWaiting: "Часы пойдут с вашего первого хода{bonus}",
  clockBonus: ", +{seconds} с за каждый ваш ход",

  pieceP: "пешка",
  pieceN: "конь",
  pieceB: "слон",
  pieceR: "ладья",
  pieceQ: "ферзь",
  pieceK: "король",
  colorWhite: "белые",
  colorBlack: "чёрные",
  squareEmpty: "пустое поле",
  squareSelected: "выбрано",
  squareCapture: "доступно для взятия",
  squareMove: "доступный ход",

  promoteTo: "Превратить в: {piece}",
  promoP: "Пешка",
  promoN: "Конь",
  promoB: "Слон",
  promoR: "Ладья",
  promoQ: "Ферзь",
  promoK: "Король",

  stEngineError: "Движок не запустился — бот не может сходить.",
  stResigned: "Вы сдались.",
  stMateWin: "Мат! Вы выиграли.",
  stMateLoss: "Мат! Победил бот.",
  stStalemate: "Пат — ничья.",
  stRepetition: "Ничья — повторение позиции.",
  stInsufficient: "Ничья — недостаточно материала.",
  stDraw: "Ничья.",
  stThinking: "Бот думает…",
  stYourMove: "Ваш ход",
  stBotMove: "Ход бота",
  stCheck: "{move} — шах!",

  resTimeout: "Поражение · время вышло",
  resResign: "Поражение · сдача",
  resMateLoss: "Поражение · мат",
  resMateWin: "Победа · мат",
  resStalemate: "Ничья · пат",
  resRepetition: "Ничья · повторение",
  resInsufficient: "Ничья · мало материала",
  resDraw: "Ничья",

  illNoPiece: "На исходном поле нет фигуры.",
  illOwnPiece: "Поле занято вашей фигурой.",
  illPawnBlocked: "Путь пешки перекрыт.",
  illPawnDiagonal: "Пешка идёт вперёд, а берёт по диагонали.",
  illGeometry: "Так эта фигура не ходит.",
  illCastleBlocked: "Путь для рокировки перекрыт.",
  illCastleCheck: "Нельзя рокироваться из-под шаха.",
  illCastleUnavailable: "Рокировка сейчас недоступна.",
  illPathBlocked: "Путь фигуры перекрыт.",
  illStillCheck: "Этот ход не защищает от шаха.",
  illKingExposed: "Король останется под шахом.",
  hintNoDefence: "Этой фигурой нельзя защититься от шаха.",
  hintNoMoves: "У этой фигуры сейчас нет допустимых ходов.",

  btnCancel: "Отмена",
  newGameTitle: "Начать новую партию?",
  newGameBody: "Текущая незаконченная партия будет удалена и не попадёт в статистику.",
  newGameConfirm: "Новая партия",
  resignTitle: "Сдаться?",
  resignBody: "Партия закончится поражением.{cost}",
  resignCost: " Партия пойдёт в счёт как поражение.",
  resignConfirm: "Сдаться",
  resetStatsTitle: "Сбросить статистику?",
  resetStatsBody: "Счёт по всем уровням будет стёрт, вернуть его будет неоткуда.",
  resetStatsConfirm: "Сбросить",

  adaptUp: "Победа! Сложность бота повышена до {to}.",
  adaptDown: "Поражение. Сложность бота понижена до {to}.",
  adaptDraw: "Ничья — серия прервана, сложность прежняя.",
  adaptMax: "Победа! Сложность уже максимальная ({max}).",
  adaptMin: "Поражение. Сложность уже минимальная ({min}).",
  adaptWinRun: "Победа! Побед подряд: {run} из {threshold}.",
  adaptLossRun: "Поражение. Поражений подряд: {run} из {threshold}.",
  streakWins: " · побед подряд: {run} из {threshold}",
  streakLosses: " · поражений подряд: {run} из {threshold}",
  record: "Побед {wins} · поражений {losses} · ничьих {draws}",

  level1: "1 — совсем новичок, постоянно зевает фигуры",
  level2: "2 — очень слабый, легко обыграть",
  level3: "3 — видит на один ход вперёд, зевает размены",
  level4: "4 — считает размены, но часто выбирает не лучший ход",
  level5: "5 — играет разумно, иногда ошибается",
  level6: "6 — крепкий любительский уровень, думает до 1,5 с",
  level7: "7 — всегда играет лучший найденный ход, до 1,2 с",
  level8: "8 — считает глубже, думает до 2 с",
  level9: "9 — то же, но с запасом времени: до 3 с",
  level10: "10 — потолок движка: до 4 с на ход, крепкий клубный уровень",

  setDifficulty: "Сложность новой партии",
  setAdaptive: "Подстраивать сложность под результат",
  setAdaptiveDesc:
    "Уровень двигается на единицу, когда один и тот же результат повторяется подряд. "
    + "Ничья и пат серию прерывают, но уровень не меняют. Просмотр прошлых позиций "
    + "правой и левой кнопками мыши не изменяет результат партии.",
  setThreshold: "Партий подряд для смены уровня",
  threshold1: "1 — уровень меняется после каждой партии",
  threshold2: "2 — две победы подряд поднимают уровень, два поражения опускают",
  threshold3: "3 — три победы подряд поднимают уровень, три поражения опускают",
  threshold4: "4 — четыре победы подряд поднимают уровень, четыре поражения опускают",
  threshold5: "5 — пять побед подряд поднимают уровень, пять поражений опускают",
  setColor: "Цвет по умолчанию",
  setColorDesc: "Каким цветом играть в новой партии («Случайно» выбирает при каждой новой игре).",
  optWhite: "Белые",
  optBlack: "Чёрные",
  optRandom: "Случайно",
  setOrientation: "Ориентация доски",
  setOrientationDesc: "Какие фигуры находятся внизу. Применяется сразу и не меняет цвет игрока.",
  optPlayerSide: "Со стороны игрока",
  optWhiteBottom: "Белые снизу",
  optBlackBottom: "Чёрные снизу",
  setTimeControl: "Контроль времени",
  setTimeControlDesc:
    "Сколько минут даётся вам на партию. Отсчёт начинается с вашего первого хода "
    + "и идёт только пока доска открыта.",
  optNoClock: "Без часов",
  optMin5: "5 минут",
  optMin10: "10 минут",
  optMin15: "15 минут",
  optMin30: "30 минут",
  optMin60: "60 минут",
  setIncrement: "Добавка за ход",
  setIncrementDesc: "Сколько секунд возвращается на ваши часы после каждого вашего хода. Применяется к новым партиям.",
  optInc0: "Без добавки",
  optInc2: "+2 секунды",
  optInc3: "+3 секунды",
  optInc5: "+5 секунд",
  optInc10: "+10 секунд",
  optInc30: "+30 секунд",
  setArrow: "Стрелка хода бота",
  setArrowDesc: "После хода бота рисует на доске стрелку от поля к полю. Подсветка обоих полей остаётся в любом случае.",
  setSounds: "Звуки игры",
  setSoundsDesc: "Мягкие звуки ходов, взятий, шаха и окончания партии.",
  setVolume: "Громкость звуков",
  headStats: "Статистика",
  statsEmpty: "Ни одной законченной партии пока нет. Счёт появится здесь сам.",
  statsLevel: "Уровень {level}",
  statsTotal: "Всего",
  setReset: "Сбросить статистику",
  setResetDesc: "Стирает счёт по всем уровням. Текущую серию результатов не трогает.",
  btnReset: "Сбросить"
};

export type I18nKey = keyof typeof en;

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  let text = (moment.locale() === "ru" ? ru[key] : en[key]) ?? en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Short label for one rung of the ladder, shown under the slider and in the menu. */
export function describeDifficulty(level: Difficulty): string {
  return t(`level${level}` as I18nKey);
}

/** The per-level tally spelled out, for places with room to say what the numbers are. */
export function describeRecord(record: LevelRecord | undefined): string {
  if (!record || record.wins + record.losses + record.draws === 0) return "";
  return t("record", { wins: record.wins, losses: record.losses, draws: record.draws });
}
