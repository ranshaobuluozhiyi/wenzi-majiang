import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { newGame, applyAction } from "./gameEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true },
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const DISCONNECT_RESERVE_MS = 90_000;

function isSlotReserved(room, idx) {
  const until = room.reservedSlots?.[idx];
  if (!until) return false;
  if (Date.now() > until) {
    delete room.reservedSlots[idx];
    return false;
  }
  return true;
}

function findJoinableSlot(room) {
  return room.slots.findIndex((s, i) => s === null && !isSlotReserved(room, i));
}

function genRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ playerCount }, cb) => {
    let roomId = genRoomId();
    while (rooms.has(roomId)) roomId = genRoomId();
    const pc = playerCount === 3 ? 3 : 2;
    const room = {
      playerCount: pc,
      slots: Array(pc).fill(null),
      reservedSlots: {},
      gameState: null,
      started: false,
    };
    room.slots[0] = socket.id;
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.slot = 0;

    if (typeof cb === "function") {
      cb({
        ok: true,
        roomId,
        slot: 0,
        state: null,
        playerCount: pc,
        waiting: true,
      });
    }
  });

  socket.on("joinRoom", ({ roomId: rawId }, cb) => {
    const roomId = String(rawId || "")
      .trim()
      .toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      if (typeof cb === "function") cb({ ok: false, error: "房间不存在" });
      return;
    }
    if (room.started) {
      if (typeof cb === "function") cb({ ok: false, error: "对局已开始，无法加入" });
      return;
    }
    const idx = findJoinableSlot(room);
    if (idx === -1) {
      if (typeof cb === "function") cb({ ok: false, error: "房间已满" });
      return;
    }
    room.slots[idx] = socket.id;
    delete room.reservedSlots[idx];
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.slot = idx;

    const allIn = room.slots.every((s) => s !== null);
    if (allIn && !room.started) {
      room.gameState = newGame(room.playerCount);
      room.started = true;
      io.to(roomId).emit("state", room.gameState);
    }

    if (typeof cb === "function") {
      cb({
        ok: true,
        roomId,
        slot: idx,
        state: room.gameState,
        playerCount: room.playerCount,
      });
    }
  });

  socket.on("rejoinRoom", ({ roomId: rawId, slot }, cb) => {
    const roomId = String(rawId || "")
      .trim()
      .toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      if (typeof cb === "function") cb({ ok: false, error: "房间不存在" });
      return;
    }
    if (typeof slot !== "number" || slot < 0 || slot >= room.playerCount) {
      if (typeof cb === "function") cb({ ok: false, error: "座位无效" });
      return;
    }
    const occupant = room.slots[slot];
    if (occupant !== null && occupant !== socket.id) {
      const other = io.sockets.sockets.get(occupant);
      if (other?.connected) {
        if (typeof cb === "function") cb({ ok: false, error: "该座位已被占用" });
        return;
      }
      room.slots[slot] = null;
    }
    room.slots[slot] = socket.id;
    delete room.reservedSlots[slot];
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.slot = slot;

    const allIn = room.slots.every((s) => s !== null);
    if (allIn && !room.started) {
      room.gameState = newGame(room.playerCount);
      room.started = true;
      io.to(roomId).emit("state", room.gameState);
    }

    if (typeof cb === "function") {
      cb({
        ok: true,
        roomId,
        slot,
        state: room.gameState,
        playerCount: room.playerCount,
      });
    }
  });

  socket.on("action", ({ action }) => {
    const roomId = socket.data.roomId;
    const slot = socket.data.slot;
    if (roomId === undefined || slot === undefined) return;
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;

    const r = applyAction(room.gameState, action, slot);
    if (r.ok) {
      room.gameState = r.state;
      io.to(roomId).emit("state", room.gameState);
    } else {
      socket.emit("actionError", { message: r.error || "操作失败" });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const slot = socket.data.slot;
    if (!roomId || typeof slot !== "number") return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.slots[slot] === socket.id) {
      room.slots[slot] = null;
      room.reservedSlots[slot] = Date.now() + DISCONNECT_RESERVE_MS;
    }
    io.to(roomId).emit("playerLeft", { slot });
  });
});

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log(`文字麻将 服务已启动: http://localhost:${PORT}`);
});
