/* global io */

const ROW_COUNT = 8;

const socket = io({ transports: ["websocket", "polling"] });

/** @type {object | null} */
let gameState = null;
let mySlot = null;
let roomId = null;
let roomReady = false;
let pendingAction = null;
/** 已自动摸牌请求的回合标记，避免重复发送 */
let lastAutoDrawKey = null;
/** 手机端当前查看的玩家座位；回合变化时自动跟随当前操作者 */
let mobileFocusedSlot = null;
let lastSyncedTurn = null;

const SESSION_ROOM_KEY = "wenzi-majiang-room";
const SESSION_SLOT_KEY = "wenzi-majiang-slot";

const MOBILE_BREAKPOINT = "(max-width: 768px)";

const POINTER_DRAG_THRESHOLD = 10;

const drag = {
  fromPlayer: null,
  fromRow: null,
  fromIndex: null,
  insertAfter: false,
  /** 触屏 / 指针拖放（替代手机不支持的 HTML5 drag） */
  pointerId: null,
  pointerActive: false,
  pointerMoved: false,
  startX: 0,
  startY: 0,
  suppressClick: false,
};

function $(id) {
  return document.getElementById(id);
}

function isMobileLayout() {
  return window.matchMedia(MOBILE_BREAKPOINT).matches;
}

/** 相对当前客户端：自己为「我」，其他为「对手」 */
function displayName(playerIdx) {
  if (playerIdx === mySlot) return "我";
  if (!gameState || gameState.playerCount === 2) return "对手";
  let n = 0;
  for (let i = 0; i < gameState.players.length; i++) {
    if (i === mySlot) continue;
    n += 1;
    if (i === playerIdx) return `对手${n}`;
  }
  return "对手";
}

function getMobileVisibleSlot() {
  if (!gameState) return mySlot ?? 0;
  if (
    mobileFocusedSlot !== null &&
    mobileFocusedSlot >= 0 &&
    mobileFocusedSlot < gameState.playerCount
  ) {
    return mobileFocusedSlot;
  }
  return getMobileAutoFocusSlot();
}

/** 手机端默认显示：正常回合跟 turn，胡牌确认跟声明者 */
function getMobileAutoFocusSlot() {
  if (!gameState) return mySlot ?? 0;
  if (gameState.claim) return gameState.claim.claimer;
  if (gameState.winner !== null) return gameState.winner;
  return gameState.turn;
}

function syncMobileViewToTurn() {
  if (!isMobileLayout() || !gameState) return;
  const focus = getMobileAutoFocusSlot();
  const turnKey = gameState.claim
    ? `claim:${gameState.claim.claimer}:${gameState.claim.approved.length}`
    : gameState.winner !== null
      ? `win:${gameState.winner}`
      : `turn:${gameState.turn}`;
  if (turnKey !== lastSyncedTurn) {
    mobileFocusedSlot = focus;
    lastSyncedTurn = turnKey;
  }
}

function persistSession() {
  if (roomId && mySlot !== null) {
    sessionStorage.setItem(SESSION_ROOM_KEY, roomId);
    sessionStorage.setItem(SESSION_SLOT_KEY, String(mySlot));
  } else {
    sessionStorage.removeItem(SESSION_ROOM_KEY);
    sessionStorage.removeItem(SESSION_SLOT_KEY);
  }
}

function clearSession() {
  roomId = null;
  mySlot = null;
  mobileFocusedSlot = null;
  lastSyncedTurn = null;
  gameState = null;
  roomReady = false;
  pendingAction = null;
  lastAutoDrawKey = null;
  persistSession();
}

function applyRoomJoin(res) {
  roomId = res.roomId;
  mySlot = res.slot;
  mobileFocusedSlot = null;
  lastSyncedTurn = null;
  gameState = res.state || null;
  roomReady = true;
  persistSession();
  $("lobbyHint")?.classList.add("hidden");
  if ($("roomCodeInput") && roomId) $("roomCodeInput").value = roomId;
  if (gameState) {
    syncMobileViewToTurn();
    updateChrome();
    render();
  } else {
    showWaitingUI();
  }
  flushPendingAction();
}

function tryRejoinRoom() {
  const savedRoom = sessionStorage.getItem(SESSION_ROOM_KEY);
  const savedSlot = sessionStorage.getItem(SESSION_SLOT_KEY);
  const targetRoom = roomId || savedRoom;
  const targetSlot = mySlot ?? (savedSlot !== null ? parseInt(savedSlot, 10) : null);
  if (!targetRoom || targetSlot === null || Number.isNaN(targetSlot)) return;

  socket.emit("rejoinRoom", { roomId: targetRoom, slot: targetSlot }, (res) => {
    if (!res || !res.ok) {
      clearSession();
      if (res?.error) toast(res.error);
      return;
    }
    applyRoomJoin(res);
  });
}

/** 桌面端：「我」始终在左，其余按座位号 */
function getDesktopPanelOrder() {
  if (!gameState || mySlot === null) return [0, 1, 2];
  const order = [mySlot];
  for (let i = 0; i < gameState.playerCount; i++) {
    if (i !== mySlot) order.push(i);
  }
  return order;
}

/** 手机端切换键：「我」在最左，对手依次在右 */
function getMobileToggleOrder() {
  return getDesktopPanelOrder();
}

function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

/** 手机端在 DOM 重绘后 click 可能丢失，用 pointerup 更可靠 */
function bindActionTap(btn, handler) {
  let lastAt = 0;
  const run = () => {
    if (btn.disabled) return;
    const now = Date.now();
    if (now - lastAt < 280) return;
    lastAt = now;
    handler();
  };
  btn.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    run();
  });
}

function flushPendingAction() {
  if (!pendingAction || !roomReady) return;
  const action = pendingAction;
  pendingAction = null;
  socket.emit("action", { action });
}

function emitAction(action) {
  if (!roomReady) {
    pendingAction = action;
    tryRejoinRoom();
    return;
  }
  socket.emit("action", { action });
}

function clearDragState() {
  drag.fromPlayer = null;
  drag.fromRow = null;
  drag.fromIndex = null;
  drag.insertAfter = false;
  drag.pointerId = null;
  drag.pointerActive = false;
  drag.pointerMoved = false;
  drag.startX = 0;
  drag.startY = 0;
}

function findReorderTargetAt(playerIdx, clientX, clientY) {
  const playerEl = $(`player${playerIdx}`);
  if (!playerEl) return null;
  const rowEls = playerEl.querySelectorAll(".rows .hand-row");
  for (const rowEl of rowEls) {
    const rect = rowEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const row = parseInt(rowEl.dataset.reorderRow, 10);
    if (Number.isNaN(row)) continue;
    return resolveDropInRow(rowEl, row, clientX, clientY);
  }
  return null;
}

function resolveDropInRow(rowEl, row, clientX, clientY) {
  const btns = rowEl.querySelectorAll("button.tile");
  if (btns.length === 0) return { kind: "row", row };

  const lastIdx = btns.length - 1;
  const lastRect = btns[lastIdx].getBoundingClientRect();
  // 行尾空白区：进入该行且位于最后一张字右侧，即视为追加到行末
  if (clientX > lastRect.left + lastRect.width / 2) {
    return { kind: "tile", row, col: lastIdx, insertAfter: true };
  }

  for (let i = 0; i < btns.length; i++) {
    const rect = btns[i].getBoundingClientRect();
    if (clientY < rect.top - 2 || clientY > rect.bottom + 2) continue;
    const mid = rect.left + rect.width / 2;
    return { kind: "tile", row, col: i, insertAfter: clientX > mid };
  }

  return { kind: "tile", row, col: lastIdx, insertAfter: true };
}

function updatePointerHighlight(playerIdx, clientX, clientY) {
  clearDropHighlights(playerIdx);
  const t = findReorderTargetAt(playerIdx, clientX, clientY);
  if (!t) return;
  const playerEl = $(`player${playerIdx}`);
  if (!playerEl) return;
  const rowEls = playerEl.querySelectorAll(".rows .hand-row");
  const rowEl = rowEls[t.row];
  if (!rowEl) return;
  if (t.kind === "row") {
    rowEl.classList.add("drop-target-end");
    return;
  }
  const btns = rowEl.querySelectorAll("button.tile");
  const btn = btns[t.col];
  if (!btn) return;
  btn.classList.add(t.insertAfter ? "drop-target-right" : "drop-target-left");
}

function applyDropFromPoint(playerIdx, clientX, clientY) {
  const t = findReorderTargetAt(playerIdx, clientX, clientY);
  if (!t) return;
  if (t.kind === "row") {
    handleDrop(playerIdx, t.row, 0, true, false);
  } else {
    handleDrop(playerIdx, t.row, t.col, false, t.insertAfter);
  }
}

function bindPointerReorder(btn, idx, rowIndex, tileIndex, canReorder, canDiscard) {
  btn.onpointerdown = (e) => {
    if (!canReorder) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.pointerActive = true;
    drag.pointerMoved = false;
    drag.pointerId = e.pointerId;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.fromPlayer = idx;
    drag.fromRow = rowIndex;
    drag.fromIndex = tileIndex;
    try {
      btn.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  };

  btn.onpointermove = (e) => {
    if (!drag.pointerActive || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > POINTER_DRAG_THRESHOLD) {
      drag.pointerMoved = true;
    }
    if (drag.pointerMoved) {
      e.preventDefault();
      updatePointerHighlight(idx, e.clientX, e.clientY);
    }
  };

  const endPointer = (e) => {
    if (!drag.pointerActive || e.pointerId !== drag.pointerId) return;
    drag.pointerActive = false;
    const moved = drag.pointerMoved;
    const pid = drag.pointerId;
    drag.pointerId = null;
    drag.pointerMoved = false;
    try {
      btn.releasePointerCapture(pid);
    } catch (_) {
      /* ignore */
    }
    clearDropHighlights(idx);
    if (moved) {
      e.preventDefault();
      drag.suppressClick = true;
      window.setTimeout(() => {
        drag.suppressClick = false;
      }, 350);
      applyDropFromPoint(idx, e.clientX, e.clientY);
    }
    clearDragState();
  };

  btn.onpointerup = endPointer;
  btn.onpointercancel = endPointer;

  btn.onclick = () => {
    if (drag.suppressClick) return;
    if (canDiscard) discardTile(idx, rowIndex, tileIndex);
  };
}

function clearDropHighlights(playerIndex) {
  const playerEl = $(`player${playerIndex}`);
  if (!playerEl) return;
  playerEl
    .querySelectorAll(".drop-target, .drop-target-left, .drop-target-right, .drop-target-end")
    .forEach((node) => node.classList.remove("drop-target", "drop-target-left", "drop-target-right", "drop-target-end"));
}

function getHandTiles(player) {
  return player.handRows.flat();
}

function getHandCount(player) {
  return getHandTiles(player).length;
}

/** 本地计算拖拽后的手牌行（不修改 gameState） */
function computeReorderAfterDrop(handRows, fromRow, fromIdx, toRow, tileIdx, dropToContainer, insertAfter) {
  const rows = handRows.map((r) => [...r]);
  const rowFrom = rows[fromRow];
  if (fromIdx < 0 || fromIdx >= rowFrom.length) return null;
  const [tile] = rowFrom.splice(fromIdx, 1);
  let targetIdx = dropToContainer ? rows[toRow].length : tileIdx + (insertAfter ? 1 : 0);
  if (fromRow === toRow && !dropToContainer && fromIdx < tileIdx) {
    targetIdx -= 1;
  }
  rows[toRow].splice(targetIdx, 0, tile);
  return rows;
}

function syncPlayersGrid() {
  const grid = $("playersGrid");
  if (!grid || !gameState) return;
  const mobile = isMobileLayout();
  grid.classList.remove("players--2", "players--3", "players--mobile-single");
  grid.classList.add(gameState.playerCount === 3 ? "players--3" : "players--2");
  if (mobile) grid.classList.add("players--mobile-single");

  const p2 = $("player2");
  if (p2) {
    p2.style.display = gameState.playerCount >= 3 ? "" : "none";
  }

  const order = mobile ? [...Array(gameState.playerCount).keys()] : getDesktopPanelOrder();
  for (const idx of order) {
    const el = $(`player${idx}`);
    if (el) grid.appendChild(el);
  }
}

function renderPlayerViewToggle() {
  const bar = $("playerViewToggle");
  if (!bar) return;
  const mobile = isMobileLayout();
  if (!mobile || !gameState) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  bar.classList.remove("hidden");
  bar.innerHTML = "";
  const visible = getMobileVisibleSlot();

  getMobileToggleOrder().forEach((idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player-view-btn";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", idx === visible ? "true" : "false");
    const isMe = idx === mySlot;
    if (isMe) btn.classList.add("player-view-btn--me");
    if (idx === visible) btn.classList.add("player-view-btn--active");
    btn.textContent = isMe ? "我的手牌" : `看${displayName(idx)}`;
    btn.onclick = () => {
      mobileFocusedSlot = idx;
      lastSyncedTurn = null;
      renderPlayers();
    };
    bar.appendChild(btn);
  });
}

function canReorderHand(playerIndex) {
  if (!gameState) return false;
  return (
    playerIndex === gameState.turn &&
    playerIndex === mySlot &&
    !gameState.claim &&
    gameState.winner === null
  );
}

function getDrawPhaseContext() {
  if (!gameState || mySlot === null) {
    return {
      awaitingCard: false,
      canDraw: false,
      canEat: false,
      drawPreview: null,
      eatPreview: null,
      showChoice: false,
    };
  }
  const active = gameState.players[gameState.turn];
  const n = gameState.players.length;
  const xiajiaTurn = gameState.lastDiscard ? (gameState.lastDiscard.from + 1) % n : null;
  const canAct = mySlot === gameState.turn;
  const awaitingCard = canAct && gameState.phase === "draw" && getHandCount(active) === 13;
  const canDraw = awaitingCard && gameState.deck.length > 0;
  const canEat =
    awaitingCard &&
    !!gameState.lastDiscard &&
    gameState.lastDiscard.from !== gameState.turn &&
    gameState.turn === xiajiaTurn;
  const drawPreview = canDraw ? gameState.deck[gameState.deck.length - 1] : null;
  const eatPreview = canEat ? gameState.lastDiscard.tile : null;
  return {
    awaitingCard,
    canDraw,
    canEat,
    drawPreview,
    eatPreview,
    showChoice: canDraw && canEat,
  };
}

function maybeAutoDraw() {
  if (!gameState || mySlot === null || !roomReady) return;
  const ctx = getDrawPhaseContext();
  if (!ctx.awaitingCard || !ctx.canDraw || ctx.canEat) return;

  const key = `${gameState.turn}-${gameState.deck.length}-${gameState.lastDiscard?.tile ?? ""}`;
  if (lastAutoDrawKey === key) return;
  lastAutoDrawKey = key;
  emitAction({ type: "DRAW" });
}

function buildDrawChoiceUI(el, ctx) {
  el.innerHTML = "";
  el.className = "actions actions--draw-choice";
  el.dataset.mode = "draw-choice";

  const bar = document.createElement("div");
  bar.className = "draw-choice-bar";

  const hint = document.createElement("p");
  hint.className = "draw-choice-hint";
  hint.textContent = "选择获得的牌";
  bar.appendChild(hint);

  const opts = document.createElement("div");
  opts.className = "draw-choice-options";

  const drawOpt = document.createElement("button");
  drawOpt.type = "button";
  drawOpt.className = "draw-choice-opt draw-choice-opt--default";
  drawOpt.innerHTML = `<span class="draw-choice-label">A · 摸牌</span><span class="draw-choice-tile">${ctx.drawPreview}</span>`;
  bindActionTap(drawOpt, drawTile);
  opts.appendChild(drawOpt);

  const eatOpt = document.createElement("button");
  eatOpt.type = "button";
  eatOpt.className = "draw-choice-opt";
  eatOpt.innerHTML = `<span class="draw-choice-label">B · 吃牌</span><span class="draw-choice-tile">${ctx.eatPreview}</span>`;
  bindActionTap(eatOpt, eatDiscard);
  opts.appendChild(eatOpt);

  bar.appendChild(opts);
  el.appendChild(bar);
}

function buildDiscardActionsUI(el) {
  el.innerHTML = "";
  el.className = "actions";
  el.dataset.mode = "discard";

  const huBtn = document.createElement("button");
  huBtn.dataset.role = "hu";
  huBtn.className = "warn";
  huBtn.textContent = "声明胡牌";
  bindActionTap(huBtn, declareHu);
  el.appendChild(huBtn);
}

function drawTile() {
  lastAutoDrawKey = null;
  emitAction({ type: "DRAW" });
}

function eatDiscard() {
  lastAutoDrawKey = null;
  emitAction({ type: "EAT" });
}

function discardTile(playerIndex, rowIndex, tileIndex) {
  emitAction({ type: "DISCARD", rowIndex, tileIndex });
}

function declareHu() {
  emitAction({ type: "DECLARE_HU" });
}

function confirmHuApprove(confirmerIndex) {
  emitAction({ type: "CONFIRM_APPROVE" });
}

function confirmHuReject() {
  emitAction({ type: "CONFIRM_REJECT" });
}

function requestNewGame() {
  emitAction({ type: "NEW_GAME" });
}

function handleDrop(playerIndex, rowIndex, tileIndex, dropToContainer, insertAfter = false) {
  if (!gameState || !canReorderHand(playerIndex)) return;
  if (drag.fromPlayer !== playerIndex) return;
  if (drag.fromRow === null || drag.fromIndex === null) return;

  const fromRow = drag.fromRow;
  const fromIndex = drag.fromIndex;
  if (fromRow === rowIndex && fromIndex === tileIndex && !dropToContainer) {
    clearDragState();
    return;
  }

  const handRows = gameState.players[playerIndex].handRows;
  const newRows = computeReorderAfterDrop(handRows, fromRow, fromIndex, rowIndex, tileIndex, dropToContainer, insertAfter);
  if (!newRows) return;

  clearDragState();
  emitAction({ type: "REORDER", handRows: newRows });
}

function updateChrome() {
  const lobby = $("lobby");
  const gameBoard = $("gameBoard");
  const topBar = $("topBar");
  const waiting = $("waitingPanel");

  if (gameState) {
    if (lobby) lobby.classList.add("hidden");
    if (waiting) waiting.classList.add("hidden");
    if (gameBoard) gameBoard.classList.remove("hidden");
    if (topBar) topBar.classList.remove("hidden");
    if (mySlot !== null && gameState.players[mySlot]) {
      const elName = $("myRoleName");
      if (elName) elName.textContent = "我";
    }
    const badge = $("roomBadge");
    if (badge && roomId) badge.textContent = `房间 ${roomId}`;
  }
}

function renderActions() {
  const el = $("turnActions");
  if (!el || !gameState) return;

  if (gameState.winner !== null) {
    if (el.dataset.mode !== "winner") {
      el.innerHTML = "";
      el.className = "actions";
      el.dataset.mode = "winner";
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "开新局";
      bindActionTap(btn, requestNewGame);
      el.appendChild(btn);
    }
    return;
  }

  if (gameState.claim) {
    if (el.dataset.mode !== "claim") {
      el.innerHTML = "";
      el.className = "actions";
      el.dataset.mode = "claim";
    }
    return;
  }

  const ctx = getDrawPhaseContext();
  const canDiscardPhase =
    mySlot === gameState.turn &&
    gameState.phase === "discard" &&
    getHandCount(gameState.players[mySlot]) === 14;

  if (ctx.showChoice) {
    if (el.dataset.mode !== "draw-choice") {
      buildDrawChoiceUI(el, ctx);
    } else {
      const tiles = el.querySelectorAll(".draw-choice-tile");
      const labels = el.querySelectorAll(".draw-choice-label");
      if (tiles[0]) tiles[0].textContent = ctx.drawPreview;
      if (tiles[1]) tiles[1].textContent = ctx.eatPreview;
      if (labels[0]) labels[0].textContent = "A · 摸牌";
      if (labels[1]) labels[1].textContent = "B · 吃牌";
    }
    return;
  }

  if (ctx.canEat && !ctx.canDraw) {
    if (el.dataset.mode !== "eat-only") {
      el.innerHTML = "";
      el.className = "actions actions--draw-choice";
      el.dataset.mode = "eat-only";
      const bar = document.createElement("div");
      bar.className = "draw-choice-bar";
      const hint = document.createElement("p");
      hint.className = "draw-choice-hint";
      hint.textContent = "选择获得的牌";
      bar.appendChild(hint);
      const opts = document.createElement("div");
      opts.className = "draw-choice-options";
      const eatOpt = document.createElement("button");
      eatOpt.type = "button";
      eatOpt.className = "draw-choice-opt draw-choice-opt--default";
      eatOpt.innerHTML = `<span class="draw-choice-label">B · 吃牌</span><span class="draw-choice-tile">${ctx.eatPreview}</span>`;
      bindActionTap(eatOpt, eatDiscard);
      opts.appendChild(eatOpt);
      bar.appendChild(opts);
      el.appendChild(bar);
    } else {
      const tile = el.querySelector(".draw-choice-tile");
      if (tile) tile.textContent = ctx.eatPreview;
    }
    return;
  }

  if (canDiscardPhase) {
    if (el.dataset.mode !== "discard") {
      buildDiscardActionsUI(el);
    }
    const huBtn = el.querySelector('[data-role="hu"]');
    if (huBtn) huBtn.disabled = false;
    return;
  }

  if (el.dataset.mode !== "idle") {
    el.innerHTML = "";
    el.className = "actions";
    el.dataset.mode = "idle";
  }
}

function renderPlayers() {
  if (!gameState) return;
  syncPlayersGrid();
  renderPlayerViewToggle();

  const mobile = isMobileLayout();
  const mobileVisible = getMobileVisibleSlot();

  gameState.players.forEach((player, idx) => {
    const el = $(`player${idx}`);
    if (!el) return;

    const active = idx === gameState.turn && !gameState.claim && gameState.winner === null;
    const canReorder = canReorderHand(idx);
    const canDiscard =
      idx === mySlot &&
      idx === gameState.turn &&
      gameState.phase === "discard" &&
      getHandCount(player) === 14 &&
      !gameState.claim &&
      gameState.winner === null;

    const label = displayName(idx);
    const turnBadge = active ? ` <span class="turn-badge">当前回合</span>` : "";
    const header = `<h3>${label}${turnBadge}</h3>
      <div>手牌：${getHandCount(player)} 张</div>
      <div class="row-tip">8 条横排可自由拖拽分类</div>`;

    el.className = "player";
    if (active) el.classList.add("active");
    if (idx === mySlot) el.classList.add("player--me");
    if (mobile && idx !== mobileVisible) el.classList.add("player--hidden-mobile");
    el.innerHTML = header;

    const rowsWrap = document.createElement("div");
    rowsWrap.className = "rows";

    for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex++) {
      const rowEl = document.createElement("div");
      rowEl.className = "hand-row";
      rowEl.dataset.reorderPlayer = String(idx);
      rowEl.dataset.reorderRow = String(rowIndex);

      const rowTiles = player.handRows[rowIndex];
      rowTiles.forEach((tile, tileIndex) => {
        const btn = document.createElement("button");
        btn.className = "tile";
        btn.dataset.reorderPlayer = String(idx);
        btn.dataset.reorderRow = String(rowIndex);
        btn.dataset.reorderCol = String(tileIndex);

        btn.textContent = tile;
        btn.title = canDiscard
          ? "点一下打出；按住拖动可调整顺序（手机同样）"
          : canReorder
            ? "按住拖动调整顺序（手机同样）"
            : "非你的操作回合";
        btn.disabled = !canReorder;
        btn.draggable = false;

        bindPointerReorder(btn, idx, rowIndex, tileIndex, canReorder, canDiscard);

        rowEl.appendChild(btn);
      });

      rowsWrap.appendChild(rowEl);
    }

    el.appendChild(rowsWrap);
  });
}

function renderClaimModal() {
  const modal = $("claimModal");
  const prompt = $("claimPrompt");
  const tilesEl = $("claimTiles");
  const actions = $("claimActions");
  const hintEl = $("claimHint");

  if (!modal || !gameState || !gameState.claim) {
    if (modal) {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
    }
    return;
  }

  const c = gameState.claim;
  const claimerName = displayName(c.claimer);
  const { confirmerIndices, approved } = c;
  const need = confirmerIndices.length;
  const done = approved.length;
  const names = confirmerIndices.map((i) => displayName(i)).join("、");

  if (prompt) {
    prompt.textContent = `${claimerName} 已声明胡牌，请 ${names} 分别点击确认（${done}/${need} 已同意）。`;
  }
  if (hintEl) {
    hintEl.textContent =
      need === 1
        ? "请确认：这 14 张牌是否组成合理文本。"
        : "每位其他玩家各点一次「确认」；任一人点「不通过」则驳回。需全部同意才算胡牌。";
  }

  if (tilesEl) {
    tilesEl.innerHTML = "";

    if (c.rows && c.rows.length > 0) {
      tilesEl.classList.add("claim-rows");
      for (const row of c.rows) {
        const rowEl = document.createElement("div");
        rowEl.className = "hand-row claim-row";
        for (const tile of row) {
          const tileBtn = document.createElement("button");
          tileBtn.className = "tile";
          tileBtn.textContent = tile;
          tileBtn.disabled = true;
          rowEl.appendChild(tileBtn);
        }
        tilesEl.appendChild(rowEl);
      }
    } else {
      tilesEl.classList.remove("claim-rows");
      for (const tile of c.tiles) {
        const tileBtn = document.createElement("button");
        tileBtn.className = "tile";
        tileBtn.textContent = tile;
        tileBtn.disabled = true;
        tilesEl.appendChild(tileBtn);
      }
    }
  }

  if (actions) {
    actions.innerHTML = "";

    for (const ci of confirmerIndices) {
      const okBtn = document.createElement("button");
      okBtn.className = "primary";
      const pname = displayName(ci);
      const already = approved.includes(ci);
      okBtn.textContent = already ? `${pname} 已确认 ✓` : `${pname} 确认胡牌`;
      okBtn.disabled = already || mySlot !== ci;
      okBtn.onclick = () => confirmHuApprove(ci);
      actions.appendChild(okBtn);
    }

    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "不通过，继续打";
    rejectBtn.disabled = !confirmerIndices.includes(mySlot);
    rejectBtn.onclick = () => confirmHuReject();

    actions.appendChild(rejectBtn);
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function renderMeta() {
  const status = $("status");
  const playTips = $("playTips");
  if (!gameState) {
    if (status) status.textContent = "";
    if (playTips) {
      playTips.classList.add("hidden");
      playTips.innerHTML = "";
    }
    return;
  }

  if (gameState.winner !== null) {
    if (status) status.textContent = `本局结束：${displayName(gameState.winner)} 胡牌成功。`;
    if (playTips) {
      playTips.classList.add("hidden");
      playTips.innerHTML = "";
    }
  } else if (gameState.claim) {
    const cc = gameState.claim;
    const done = cc.approved.length;
    const need = cc.confirmerIndices.length;
    if (status) {
      status.textContent = `${displayName(cc.claimer)} 声明胡牌，等待确认（${done}/${need}）。`;
    }
    if (playTips) {
      playTips.classList.add("hidden");
      playTips.innerHTML = "";
    }
  } else {
    const phaseText = gameState.phase === "draw" ? "摸牌阶段" : "出牌阶段";
    const who = displayName(gameState.turn);
    if (status) {
      status.innerHTML = `当前回合：<span class="turn-badge turn-badge--meta">${who}</span>（${phaseText}）`;
    }
    if (playTips) {
      playTips.classList.remove("hidden");
      playTips.innerHTML =
        `<div class="play-tip">每回合获得一张牌（摸或吃）变为 14 张，然后 点击一张牌出掉 或 声明胡牌。</div>`;
    }
  }
}

function render() {
  renderMeta();
  renderActions();
  renderPlayers();
  renderClaimModal();
}

function showWaitingUI() {
  const waiting = $("waitingPanel");
  const displayId = $("displayRoomId");
  const waitingText = $("waitingText");
  const topBar = $("topBar");
  if (displayId && roomId) displayId.textContent = roomId;
  if (waitingText) {
    const pc = $("playerCountSelect") ? parseInt($("playerCountSelect").value, 10) || 2 : 2;
    waitingText.textContent =
      mySlot === 0
        ? `等待其他玩家加入（共 ${pc} 人开局）…`
        : "正在加入…";
  }
  if (waiting) waiting.classList.remove("hidden");
  if (topBar && mySlot !== null) {
    topBar.classList.remove("hidden");
    const elName = $("myRoleName");
    if (elName) elName.textContent = "我";
    const badge = $("roomBadge");
    if (badge && roomId) badge.textContent = `房间 ${roomId}`;
  }
}

function wireLobby() {
  $("btnCreateRoom")?.addEventListener("click", () => {
    const pc = parseInt($("playerCountSelect")?.value || "2", 10);
    socket.emit("createRoom", { playerCount: pc }, (res) => {
      if (!res || !res.ok) {
        toast(res?.error || "创建失败");
        return;
      }
      roomId = res.roomId;
      mySlot = res.slot;
      mobileFocusedSlot = null;
      lastSyncedTurn = null;
      gameState = null;
      roomReady = true;
      persistSession();
      showWaitingUI();
      $("lobbyHint")?.classList.add("hidden");
    });
  });

  $("btnJoinRoom")?.addEventListener("click", () => {
    const code = ($("roomCodeInput")?.value || "").trim().toUpperCase();
    if (code.length < 4) {
      toast("请输入房间号");
      return;
    }
    socket.emit("joinRoom", { roomId: code }, (res) => {
      if (!res || !res.ok) {
        toast(res?.error || "加入失败");
        return;
      }
      applyRoomJoin(res);
    });
  });

  $("btnCopyLink")?.addEventListener("click", async () => {
    if (!roomId) return;
    const url = `${location.origin}${location.pathname}?join=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("链接已复制");
    } catch {
      toast(url);
    }
  });
}

socket.on("state", (s) => {
  gameState = s;
  syncMobileViewToTurn();
  maybeAutoDraw();
  updateChrome();
  render();
});

socket.on("actionError", (e) => {
  toast(e?.message || "操作无效");
});

socket.on("playerLeft", ({ slot }) => {
  toast(`座位 ${slot} 的玩家已断开，本局可能无法正常继续`);
});

socket.on("disconnect", () => {
  roomReady = false;
  if (roomId) toast("连接已断开，正在尝试恢复…");
});

socket.on("connect", () => {
  const params = new URLSearchParams(location.search);
  const join = params.get("join");
  if (join && mySlot === null) {
    socket.emit("joinRoom", { roomId: join.trim().toUpperCase() }, (res) => {
      if (!res || !res.ok) {
        toast(res?.error || "加入失败");
        return;
      }
      applyRoomJoin(res);
    });
    return;
  }
  tryRejoinRoom();
});

wireLobby();

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (gameState) {
      syncMobileViewToTurn();
      render();
    }
  }, 120);
});
