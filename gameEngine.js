/**
 * 文字麻将 - 权威游戏状态（两端共用：服务端 apply；客户端仅渲染）
 * claim.approved 使用 number[] 便于 JSON
 */

export const TILE_TEXT =
  "生、了、吃、又、疯、红、看、但、不、的、乐、乱、给、比、热、王、睡、白、去、是、家、狂、将、冷、空、气、爱、想、野、酒、海、饱、坏、笑、杀、喝、和、光、你、我、他、几、天、地、过、到、无、着、语、烟、听、饿、活、飞、点、对、如、敌、完、像、醒、哭、里、哪、发、花、风、梦、春、喜、眼、在、吗、瓜、麻、恋、日、老、来、丑、那、人、谁、月、手、影、只、多、少、好、纯、之、就、菜、心、做、她、痛、快、中、傻、一、后、为、别、大、小、美、电、夏、鬼、被、个、火、没、把、很、都、极、啊、可、欢、黑、死、它、钱、神、跑、色、失、明、得、吧、呆、有、东、西、子、儿、们、迷、要、说、这、寂、寞、荒、凉、幻、碎、痕、尘、缘、禅、韵、灵、魄、也、会、能、新、旧、雪、山、水、云、雨、木、金";

export const TILES = TILE_TEXT.split("、").map((s) => s.trim()).filter(Boolean);
export const ROW_COUNT = 8;

export function createPlayer(name) {
  return {
    name,
    handRows: Array.from({ length: ROW_COUNT }, () => []),
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function getHandTiles(player) {
  return player.handRows.flat();
}

export function getHandCount(player) {
  return getHandTiles(player).length;
}

export function pushTile(player, tile, row = 0) {
  player.handRows[row].push(tile);
}

export function removeTileAt(state, playerIndex, rowIndex, tileIndex) {
  const player = state.players[playerIndex];
  if (!player) return null;
  if (rowIndex < 0 || rowIndex >= ROW_COUNT) return null;
  const row = player.handRows[rowIndex];
  if (tileIndex < 0 || tileIndex >= row.length) return null;
  const [tile] = row.splice(tileIndex, 1);
  return tile;
}

export function insertTileAt(state, playerIndex, rowIndex, tileIndex, tile) {
  const player = state.players[playerIndex];
  if (!player) return;
  if (rowIndex < 0 || rowIndex >= ROW_COUNT) return;
  const row = player.handRows[rowIndex];
  const safeIndex = Math.max(0, Math.min(tileIndex, row.length));
  row.splice(safeIndex, 0, tile);
}

/** @param {number} playerCount 2 | 3 */
export function newGame(playerCount) {
  const n = playerCount === 3 ? 3 : 2;
  const deck = [...TILES];
  shuffle(deck);
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push(createPlayer(`玩家${String.fromCharCode(65 + i)}`));
  }
  for (let i = 0; i < 13; i++) {
    for (const p of players) {
      pushTile(p, deck.pop(), 0);
    }
  }
  return {
    playerCount: n,
    players,
    deck,
    turn: 0,
    phase: "draw",
    lastDiscard: null,
    claim: null,
    winner: null,
  };
}

function tileMultisetKey(tiles) {
  return [...tiles].sort().join("\u0001");
}

/** 校验整理手牌：行数、总牌张 multiset 不变 */
function validateHandRows(player, newRows) {
  if (!Array.isArray(newRows) || newRows.length !== ROW_COUNT) return false;
  const flat = newRows.flat();
  const oldFlat = getHandTiles(player);
  if (flat.length !== oldFlat.length) return false;
  return tileMultisetKey(flat) === tileMultisetKey(oldFlat);
}

/**
 * @param {object} state
 * @param {object} action
 * @param {number} playerIndex 当前连接者的座位 0..n-1
 * @returns {{ ok: boolean, state?: object, error?: string }}
 */
function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function applyAction(state, action, playerIndex) {
  if (!state || !action || typeof action.type !== "string") {
    return { ok: false, error: "无效操作" };
  }

  const n = state.players.length;
  if (playerIndex < 0 || playerIndex >= n) {
    return { ok: false, error: "座位无效" };
  }

  const next = cloneState(state);

  switch (action.type) {
    case "NEW_GAME": {
      if (next.claim) return { ok: false, error: "请先处理胡牌确认" };
      if (next.winner === null) return { ok: false, error: "对局未结束，不可开新局" };
      const pc = next.playerCount || n;
      return { ok: true, state: newGame(pc) };
    }

    case "REORDER": {
      if (next.winner !== null || next.claim) return { ok: false, error: "当前不可整理" };
      if (playerIndex !== next.turn) return { ok: false, error: "非你的回合" };
      const rows = action.handRows;
      const player = next.players[playerIndex];
      if (!validateHandRows(player, rows)) return { ok: false, error: "手牌整理不合法" };
      player.handRows = rows.map((r) => [...r]);
      return { ok: true, state: next };
    }

    case "DRAW": {
      if (next.winner !== null || next.claim) return { ok: false, error: "无法摸牌" };
      if (next.phase !== "draw") return { ok: false, error: "不是摸牌阶段" };
      if (playerIndex !== next.turn) return { ok: false, error: "非你的回合" };
      const active = next.players[next.turn];
      if (getHandCount(active) !== 13) return { ok: false, error: "手牌数不对" };
      if (next.deck.length === 0) return { ok: false, error: "牌堆已空" };
      pushTile(active, next.deck.pop(), 0);
      next.phase = "discard";
      return { ok: true, state: next };
    }

    case "EAT": {
      if (next.winner !== null || next.claim) return { ok: false, error: "无法吃牌" };
      if (next.phase !== "draw") return { ok: false, error: "不是摸牌阶段" };
      if (playerIndex !== next.turn) return { ok: false, error: "非你的回合" };
      const active = next.players[next.turn];
      if (!next.lastDiscard || next.lastDiscard.from === next.turn) return { ok: false, error: "没有可吃的弃牌" };
      if (getHandCount(active) !== 13) return { ok: false, error: "手牌数不对" };
      const xiajiaTurn = (next.lastDiscard.from + 1) % n;
      if (next.turn !== xiajiaTurn) return { ok: false, error: "仅下家可吃" };
      pushTile(active, next.lastDiscard.tile, 0);
      next.lastDiscard = null;
      next.phase = "discard";
      return { ok: true, state: next };
    }

    case "DISCARD": {
      if (next.winner !== null || next.claim) return { ok: false, error: "无法出牌" };
      if (next.phase !== "discard") return { ok: false, error: "不是出牌阶段" };
      if (playerIndex !== next.turn) return { ok: false, error: "非你的回合" };
      const active = next.players[next.turn];
      if (getHandCount(active) !== 14) return { ok: false, error: "必须先摸牌或吃牌" };
      const { rowIndex, tileIndex } = action;
      const tile = removeTileAt(next, playerIndex, rowIndex, tileIndex);
      if (!tile) return { ok: false, error: "出牌无效" };
      next.lastDiscard = { tile, from: next.turn };
      next.turn = (next.turn + 1) % n;
      next.phase = "draw";
      return { ok: true, state: next };
    }

    case "DECLARE_HU": {
      if (next.winner !== null || next.claim) return { ok: false, error: "无法声明胡牌" };
      if (next.phase !== "discard") return { ok: false, error: "须先摸到 14 张" };
      if (playerIndex !== next.turn) return { ok: false, error: "非你的回合" };
      const active = next.players[next.turn];
      if (getHandCount(active) !== 14) return { ok: false, error: "须 14 张才能胡" };
      const confirmerIndices = [];
      for (let i = 0; i < n; i++) {
        if (i !== next.turn) confirmerIndices.push(i);
      }
      next.claim = {
        claimer: next.turn,
        confirmerIndices,
        approved: [],
        tiles: [...getHandTiles(active)],
        rows: active.handRows.map((row) => [...row]).filter((row) => row.length > 0),
      };
      return { ok: true, state: next };
    }

    case "CONFIRM_APPROVE": {
      if (!next.claim) return { ok: false, error: "无胡牌确认" };
      const { claimer, confirmerIndices, approved } = next.claim;
      if (!confirmerIndices.includes(playerIndex)) return { ok: false, error: "无需你确认" };
      if (approved.includes(playerIndex)) return { ok: false, error: "你已确认过" };
      approved.push(playerIndex);
      if (approved.length === confirmerIndices.length) {
        next.winner = claimer;
        next.claim = null;
      }
      return { ok: true, state: next };
    }

    case "CONFIRM_REJECT": {
      if (!next.claim) return { ok: false, error: "无胡牌确认" };
      const claimer = next.claim.claimer;
      if (!next.claim.confirmerIndices.includes(playerIndex)) return { ok: false, error: "无需你操作" };
      next.claim = null;
      next.turn = claimer;
      next.phase = "discard";
      return { ok: true, state: next };
    }

    default:
      return { ok: false, error: "未知操作" };
  }
}
