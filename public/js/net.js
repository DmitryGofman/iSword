// Tiny WebSocket wrapper with auto-reconnect and a JSON message API.
// Used by both the game screen and the phone controller.

export class Net {
  constructor({ role, room, playerId = null, onMessage, onStatus }) {
    this.role = role;
    this.room = room;
    this.playerId = playerId;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.joined = false;
    this._shouldRun = true;
    this._backoff = 500;
    this.connect();
  }

  connect() {
    if (!this._shouldRun) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    this.onStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._backoff = 500;
      this.send({ t: 'join', role: this.role, room: this.room, playerId: this.playerId });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'joined') {
        this.joined = true;
        this.playerId = msg.playerId || this.playerId;
        this.onStatus('joined');
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      this.joined = false;
      this.onStatus('disconnected');
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  _scheduleReconnect() {
    if (!this._shouldRun) return;
    const delay = Math.min(this._backoff, 8000);
    this._backoff = Math.min(this._backoff * 2, 8000);
    setTimeout(() => this.connect(), delay);
  }

  send(obj) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this._shouldRun = false;
    if (this.ws) try { this.ws.close(); } catch { /* ignore */ }
  }
}

// 4-char room code from an unambiguous alphabet.
export function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}
