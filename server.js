// iSword — pairing + IMU relay server.
//
// Two roles connect to a short-lived "room":
//   - "game"       : the 3D screen (TV via AirPlay, or a laptop browser)
//   - "controller" : a phone streaming its IMU into that room
//
// The server does almost nothing clever: it pairs the two by room code and
// relays JSON messages between them at low latency. All game logic and physics
// live in the browser (public/js/game.js).

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** roomCode -> { game: ws|null, controllers: Set<ws> } */
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { game: null, controllers: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function peerCount(room) {
  return room.controllers.size;
}

function notifyPresence(room) {
  const controllers = peerCount(room);
  send(room.game, { t: 'presence', role: 'controller', count: controllers });
  for (const c of room.controllers) {
    send(c, { t: 'presence', role: 'game', count: room.game ? 1 : 0 });
  }
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.room = null;
  ws.playerId = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // --- Join handshake -------------------------------------------------
    if (msg.t === 'join') {
      const code = String(msg.room || '').toUpperCase().slice(0, 8) || 'MAIN';
      const room = getRoom(code);
      ws.room = code;
      ws.role = msg.role === 'game' ? 'game' : 'controller';

      if (ws.role === 'game') {
        // A new game screen takes over the room.
        if (room.game && room.game !== ws) {
          send(room.game, { t: 'replaced' });
        }
        room.game = ws;
      } else {
        ws.playerId = msg.playerId || ('p' + (room.controllers.size + 1));
        room.controllers.add(ws);
      }

      send(ws, { t: 'joined', room: code, role: ws.role, playerId: ws.playerId });
      notifyPresence(room);
      return;
    }

    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room) return;

    // --- Relay IMU / control traffic -----------------------------------
    if (ws.role === 'controller') {
      // Tag with playerId so the game can tell phones apart, then forward.
      msg.playerId = ws.playerId;
      send(room.game, msg);
    } else if (ws.role === 'game') {
      // Game -> controllers (e.g. rumble/haptic cues, calibration acks).
      if (msg.to) {
        for (const c of room.controllers) {
          if (c.playerId === msg.to) send(c, msg);
        }
      } else {
        for (const c of room.controllers) send(c, msg);
      }
    }
  });

  ws.on('close', () => {
    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room) return;
    if (ws.role === 'game' && room.game === ws) {
      room.game = null;
    } else if (ws.role === 'controller') {
      room.controllers.delete(ws);
    }
    notifyPresence(room);
    if (!room.game && room.controllers.size === 0) {
      rooms.delete(ws.room);
    }
  });
});

// Drop dead sockets so rooms don't leak.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`\n  iSword running:  http://localhost:${PORT}\n`);
  console.log('  Game screen  ->  open on the TV / laptop (AirPlay mirror the browser)');
  console.log('  Controller   ->  scan the QR on your phone\n');
});
