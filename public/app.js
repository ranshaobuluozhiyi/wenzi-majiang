/* global io */

const ROW_COUNT = 8;

const socket = io({ transports: ["websocket", "polling"] });

/** @type {object | null} */
let gameState = null;
let mySlot = null;
let roomId = null;

const drag = {
  fromPlayer: null,
  fromRow: null,
  fromIndex: null,
  insertAfter: false,
};

function $(id) {
  return document.getElementById(id);
}

function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function emitAction(action) {
  socket.emit("action", { action });
}

function clearDragState() {
  drag.fromPlayer = null;
  drag.fromRow = null;
  drag.fromIndex = null;
  drag.insertAfter = false;
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
  grid.classList.remove("players--2", "players--3");
  grid.classList.add(gameState.playerCount === 3 ? "players--3" : "players--2");
  const p2 = $("player2");
  if (p2) {
    p2.style.display = gameState.playerCount >= 3 ? "" : "none";
  }
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

function drawTile() {
  emitAction({ type: "DRAW" });
}

function eatDiscard() {
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
      const elNum = $("mySlotNum");
      if (elName) elName.textContent = gameState.players[mySlot].name;
      if (elNum) elNum.textContent = String(mySlot);
    }
    const badge = $("roomBadge");
    if (badge && roomId) badge.textContent = `房间 ${roomId}`;
  }
}

function renderActions() {
  const el = $("turnActions");
  if (!el || !gameState) return;
  el.innerHTML = "";

  const isMe = (i) => i === mySlot;
  const canAct = (i) => isMe(i) && i === gameState.turn;

  if (gameState.winner !== null) {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "开新局";
    btn.onclick = requestNewGame;
    el.appendChild(btn);
    return;
  }

  if (gameState.claim) return;

  const active = gameState.players[gameState.turn];
  const n = gameState.players.length;
  const xiajiaTurn = gameState.lastDiscard ? (gameState.lastDiscard.from + 1) % n : null;
  const canEat =
    canAct(gameState.turn) &&
    gameState.phase === "draw" &&
    gameState.lastDiscard &&
    gameState.lastDiscard.from !== gameState.turn &&
    gameState.turn === xiajiaTurn &&
    getHandCount(active) === 13;

  const drawBtn = document.createElement("button");
  drawBtn.textContent = "摸牌";
  drawBtn.disabled = !(
    canAct(gameState.turn) &&
    gameState.phase === "draw" &&
    getHandCount(active) === 13 &&
    gameState.deck.length > 0
  );
  drawBtn.onclick = drawTile;
  el.appendChild(drawBtn);

  const eatBtn = document.createElement("button");
  eatBtn.textContent = gameState.lastDiscard ? `吃牌（${gameState.lastDiscard.tile}）` : "吃牌";
  eatBtn.disabled = !canEat;
  eatBtn.title = n >= 3 ? "仅「上一手弃牌者的下家」可吃" : "";
  eatBtn.onclick = eatDiscard;
  el.appendChild(eatBtn);

  const huBtn = document.createElement("button");
  huBtn.className = "warn";
  huBtn.textContent = "声明胡牌";
  huBtn.disabled = !(
    canAct(gameState.turn) &&
    gameState.phase === "discard" &&
    getHandCount(active) === 14
  );
  huBtn.onclick = declareHu;
  el.appendChild(huBtn);
}

function renderPlayers() {
  if (!gameState) return;
  syncPlayersGrid();

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

    const header = `<h3>${player.name}${active ? "（当前回合）" : ""}</h3>
      <div>手牌：${getHandCount(player)} 张</div>
      <div class="row-tip">8 条横排可自由拖拽分类</div>`;

    el.className = `player${active ? " active" : ""}`;
    el.innerHTML = header;

    const rowsWrap = document.createElement("div");
    rowsWrap.className = "rows";

    for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex++) {
      const rowEl = document.createElement("div");
      rowEl.className = "hand-row";

      rowEl.ondragover = (event) => {
        if (!canReorder || drag.fromPlayer !== idx) return;
        if (event.target !== rowEl) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        clearDropHighlights(idx);
        rowEl.classList.add("drop-target-end");
      };

      rowEl.ondrop = (event) => {
        if (!canReorder) return;
        if (event.target !== rowEl) return;
        event.preventDefault();
        handleDrop(idx, rowIndex, 0, true, false);
      };

      rowEl.ondragleave = (event) => {
        if (!canReorder) return;
        const related = event.relatedTarget;
        if (related && rowEl.contains(related)) return;
        rowEl.classList.remove("drop-target-end");
      };

      const rowTiles = player.handRows[rowIndex];
      rowTiles.forEach((tile, tileIndex) => {
        const btn = document.createElement("button");
        btn.className = "tile";

        btn.textContent = tile;
        btn.title = canDiscard ? "点击打出；也可拖拽调整顺序" : canReorder ? "拖拽调整顺序" : "非你的操作回合";
        btn.disabled = !canReorder;
        btn.draggable = canReorder;

        btn.onclick = () => {
          if (canDiscard) discardTile(idx, rowIndex, tileIndex);
        };

        btn.ondragstart = (event) => {
          if (!canReorder) return;
          drag.fromPlayer = idx;
          drag.fromRow = rowIndex;
          drag.fromIndex = tileIndex;
          event.dataTransfer.effectAllowed = "move";
        };

        btn.ondragover = (event) => {
          if (!canReorder || drag.fromPlayer !== idx) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          const rect = btn.getBoundingClientRect();
          const insertAfter = event.clientX > rect.left + rect.width / 2;
          drag.insertAfter = insertAfter;
          clearDropHighlights(idx);
          btn.classList.add(insertAfter ? "drop-target-right" : "drop-target-left");
        };

        btn.ondrop = (event) => {
          if (!canReorder) return;
          event.preventDefault();
          event.stopPropagation();
          handleDrop(idx, rowIndex, tileIndex, false, drag.insertAfter);
        };

        btn.ondragend = () => {
          clearDropHighlights(idx);
          clearDragState();
        };

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
  const claimerName = gameState.players[c.claimer].name;
  const { confirmerIndices, approved } = c;
  const need = confirmerIndices.length;
  const done = approved.length;
  const names = confirmerIndices.map((i) => gameState.players[i].name).join("、");

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
      const pname = gameState.players[ci].name;
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
  const deckCount = $("deckCount");
  const lastDiscard = $("lastDiscard");
  if (!gameState) {
    if (status) status.textContent = "";
    return;
  }

  if (gameState.winner !== null) {
    status.textContent = `本局结束：${gameState.players[gameState.winner].name} 胡牌成功。`;
  } else if (gameState.claim) {
    const cc = gameState.claim;
    const done = cc.approved.length;
    const need = cc.confirmerIndices.length;
    status.textContent = `${gameState.players[cc.claimer].name} 声明胡牌，等待确认（${done}/${need}）。`;
  } else {
    const phaseText = gameState.phase === "draw" ? "摸牌阶段" : "出牌阶段";
    status.textContent = `当前：${gameState.players[gameState.turn].name}（${phaseText}）`;
  }

  if (deckCount) deckCount.textContent = `牌堆剩余：${gameState.deck.length}`;
  if (lastDiscard) {
    if (gameState.lastDiscard) {
      lastDiscard.textContent = `最近弃牌：${gameState.lastDiscard.tile}（来自 ${gameState.players[gameState.lastDiscard.from].name}）`;
    } else {
      lastDiscard.textContent = "最近弃牌：暂无";
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
    const labels = ["玩家A", "玩家B", "玩家C"];
    const elName = $("myRoleName");
    const elNum = $("mySlotNum");
    if (elName) elName.textContent = labels[mySlot] || `玩家${mySlot}`;
    if (elNum) elNum.textContent = String(mySlot);
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
      gameState = null;
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
      roomId = res.roomId;
      mySlot = res.slot;
      gameState = res.state || null;
      $("lobbyHint")?.classList.add("hidden");
      if (gameState) {
        updateChrome();
        render();
      } else {
        showWaitingUI();
      }
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
  updateChrome();
  render();
});

socket.on("actionError", (e) => {
  toast(e?.message || "操作无效");
});

socket.on("playerLeft", ({ slot }) => {
  toast(`座位 ${slot} 的玩家已断开，本局可能无法正常继续`);
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
      roomId = res.roomId;
      mySlot = res.slot;
      gameState = res.state || null;
      $("lobbyHint")?.classList.add("hidden");
      if ($("roomCodeInput")) $("roomCodeInput").value = roomId || "";
      if (gameState) {
        updateChrome();
        render();
      } else {
        showWaitingUI();
      }
    });
  }
});

wireLobby();
