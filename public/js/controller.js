// Phone controller: reads IMU, streams raw orientation + motion to the game.
//
// We forward *raw* alpha/beta/gamma plus the screen orientation angle and let
// the game screen convert to a quaternion (it already runs three.js). That
// keeps one source of truth for the sensor->sword math (see game.js).

import { Net } from './net.js';

const $ = (id) => document.getElementById(id);
const joinPanel = $('joinPanel');
const playPanel = $('playPanel');
const codeInput = $('codeInput');
const enableBtn = $('enableBtn');
const calBtn = $('calBtn');
const connDot = $('connDot');
const connText = $('connText');
const speedFill = $('speedFill');
const hilt = $('hilt');
const errEl = $('err');

// Prefill room code from ?room=CODE
const params = new URLSearchParams(location.search);
const preRoom = (params.get('room') || '').toUpperCase().slice(0, 4);
if (preRoom) codeInput.value = preRoom;

let net = null;
let streaming = false;
let lastSent = 0;
const SEND_HZ = 60;
const SEND_INTERVAL = 1000 / SEND_HZ;

// Latest sensor state
const state = {
  alpha: 0, beta: 0, gamma: 0,
  rot: [0, 0, 0],   // rotationRate deg/s  [alpha, beta, gamma]
  acc: [0, 0, 0],   // accelerationIncludingGravity
};

function screenAngle() {
  const so = (screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle
    : (window.orientation || 0);
  return (so || 0) * Math.PI / 180;
}

function onOrientation(e) {
  if (e.alpha == null && e.beta == null && e.gamma == null) return;
  state.alpha = (e.alpha || 0) * Math.PI / 180;
  state.beta = (e.beta || 0) * Math.PI / 180;
  state.gamma = (e.gamma || 0) * Math.PI / 180;
}

function onMotion(e) {
  const r = e.rotationRate;
  if (r) state.rot = [r.alpha || 0, r.beta || 0, r.gamma || 0];
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (a) state.acc = [a.x || 0, a.y || 0, a.z || 0];
  updateSwingViz();
}

function updateSwingViz() {
  // Angular speed magnitude (deg/s) -> bar + hilt tilt for local feedback.
  const w = Math.hypot(state.rot[0], state.rot[1], state.rot[2]);
  const pct = Math.min(100, (w / 700) * 100);
  speedFill.style.width = pct.toFixed(0) + '%';
  const tilt = Math.max(-70, Math.min(70, state.gamma * 180 / Math.PI));
  const pitch = Math.max(-40, Math.min(40, state.beta * 180 / Math.PI - 0));
  hilt.style.transform = `rotate(${tilt}deg) translateY(${-pitch * 0.2}px)`;
}

function loop(ts) {
  if (streaming && net && net.joined) {
    if (ts - lastSent >= SEND_INTERVAL) {
      lastSent = ts;
      net.send({
        t: 'imu',
        o: [state.alpha, state.beta, state.gamma],
        orient: screenAngle(),
        rot: state.rot,
        acc: state.acc,
        ts: Math.round(ts),
      });
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

async function requestMotionPermission() {
  // iOS 13+ gate.
  const needsOrient = typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function';
  const needsMotion = typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function';
  try {
    if (needsOrient) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion permission denied.');
    }
    if (needsMotion) {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion permission denied.');
    }
  } catch (e) {
    throw new Error(e.message || 'Could not access motion sensors.');
  }
}

function startSensors() {
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('devicemotion', onMotion, true);
  streaming = true;
}

function setConn(status) {
  const map = {
    connecting: ['warn', 'connecting…'],
    joined: ['on', 'connected'],
    disconnected: ['', 'reconnecting…'],
  };
  const [cls, txt] = map[status] || ['', status];
  connDot.className = 'dot ' + cls;
  connText.textContent = txt;
}

enableBtn.addEventListener('click', async () => {
  errEl.textContent = '';
  const code = (codeInput.value || '').toUpperCase().trim();
  if (code.length < 3) { errEl.textContent = 'Enter the room code from the TV.'; return; }

  try {
    await requestMotionPermission();
  } catch (e) {
    errEl.textContent = e.message + ' You can still tap Calibrate, but the sword won\'t move.';
  }
  startSensors();

  net = new Net({
    role: 'controller',
    room: code,
    onStatus: setConn,
    onMessage: (msg) => {
      if (msg.t === 'haptic') {
        if (navigator.vibrate) navigator.vibrate(msg.ms || 30);
      }
      if (msg.t === 'presence' && msg.role === 'game') {
        connText.textContent = msg.count ? 'connected' : 'waiting for screen…';
      }
    },
  });

  joinPanel.style.display = 'none';
  playPanel.style.display = 'block';
  // Keep screen awake if possible.
  requestWakeLock();
});

calBtn.addEventListener('click', () => {
  if (net) net.send({ t: 'calibrate' });
  if (navigator.vibrate) navigator.vibrate(20);
  calBtn.textContent = 'Calibrated ✓ — swing!';
  setTimeout(() => (calBtn.textContent = 'Hold still & Calibrate'), 1400);
});

// Keep the phone from sleeping while playing.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (wakeLock && document.visibilityState === 'visible') {
          try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
        }
      });
    }
  } catch { /* not fatal */ }
}
