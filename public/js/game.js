// iSword — Training Arena
// First-person sword driven by a phone's IMU (or mouse for testing), fighting a
// reactive training dummy. Custom lightweight physics for the sword tip and a
// damped spring model for the dummy's reaction — self-contained, no physics lib.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Net, makeRoomCode } from './net.js';

// ---------------------------------------------------------------------------
// Config / tuning
// ---------------------------------------------------------------------------
const CFG = {
  bladeLength: 0.9,         // metres, guard -> tip
  gripLength: 0.135,
  handAnchor: new THREE.Vector3(0.16, 1.12, 1.0),
  camPos: new THREE.Vector3(0.0, 1.63, 1.98),
  camLook: new THREE.Vector3(0.0, 1.16, 0.0),
  hitSpeedMin: 2.0,         // m/s of tip needed to count as a strike
  hitCooldownMs: 180,       // per-part debounce
  impulseScale: 0.019,      // tip speed -> dummy angular impulse
  springK: 42,              // dummy restoring stiffness
  springC: 5.2,             // dummy damping
  maxLean: 0.6,             // rad
  bladeRadius: 0.05,        // collision fatness of the blade
};

const params = new URLSearchParams(location.search);
const LOCAL_MODE = params.get('mode') === 'local';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const appEl = $('app');
const overlay = $('overlay');
const hud = $('hud');
const startBtn = $('startBtn');
const mouseBtn = $('mouseBtn');
const pairDot = $('pairDot');
const pairStatus = $('pairStatus');
const roomCodeEl = $('roomCode');
const joinUrlEl = $('joinUrl');
const qrBox = $('qrBox');
const localHint = $('localHint');
const hitsN = $('hitsN');
const bestComboEl = $('bestCombo');
const speedN = $('speedN');
const powerFill = $('powerFill');
const comboText = $('comboText');
const hintPill = $('hintPill');
const flashEl = $('flash');

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d17);
scene.fog = new THREE.Fog(0x0a0d17, 8, 26);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.copy(CFG.camPos);
camera.lookAt(CFG.camLook);

// Environment reflections for the metal blade.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0x9fb8ff, 0x1a1522, 0.55);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff2df, 2.1);
key.position.set(3.5, 7, 4.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 25;
key.shadow.camera.left = -6; key.shadow.camera.right = 6;
key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);

const rim = new THREE.DirectionalLight(0x5cc8ff, 0.9);
rim.position.set(-5, 4, -3);
scene.add(rim);

const fill = new THREE.PointLight(0xff8a5c, 0.5, 20, 2);
fill.position.set(-2, 2.2, 3);
scene.add(fill);

// ---------------------------------------------------------------------------
// Floor + arena
// ---------------------------------------------------------------------------
function makeFloorTexture() {
  const s = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 60, s / 2, s / 2, s / 1.4);
  g.addColorStop(0, '#2a2f4a');
  g.addColorStop(1, '#12142440'.slice(0, 7));
  g.fillStyle = '#181c30';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // concentric arena rings
  ctx.strokeStyle = 'rgba(92,200,255,0.20)';
  ctx.lineWidth = 3;
  for (let r = 80; r < s / 2; r += 90) {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // subtle radial spokes
  ctx.strokeStyle = 'rgba(120,140,220,0.10)';
  ctx.lineWidth = 2;
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(s / 2, s / 2);
    ctx.lineTo(s / 2 + Math.cos(ang) * s, s / 2 + Math.sin(ang) * s);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(14, 64),
  new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: 0.85, metalness: 0.1 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// glowing ring under the dummy
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.85, 0.98, 48),
  new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.011;
scene.add(ring);

// ---------------------------------------------------------------------------
// Sword
// ---------------------------------------------------------------------------
const sword = new THREE.Group();
scene.add(sword);

const bladeMat = new THREE.MeshStandardMaterial({
  color: 0xeaf2ff, metalness: 1.0, roughness: 0.16,
  envMapIntensity: 1.4,
});
const guardMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1.0, roughness: 0.35 });
const gripMat = new THREE.MeshStandardMaterial({ color: 0x3a2417, metalness: 0.1, roughness: 0.9 });

// blade: main flat box + a tapered tip
const bladeMain = new THREE.Mesh(
  new THREE.BoxGeometry(0.05, CFG.bladeLength * 0.82, 0.012),
  bladeMat
);
bladeMain.position.y = CFG.gripLength + CFG.bladeLength * 0.41;
bladeMain.castShadow = true;
sword.add(bladeMain);

const bladeTip = new THREE.Mesh(
  new THREE.ConeGeometry(0.025, CFG.bladeLength * 0.18, 4),
  bladeMat
);
bladeTip.position.y = CFG.gripLength + CFG.bladeLength * 0.82 + CFG.bladeLength * 0.09;
bladeTip.rotation.y = Math.PI / 4;
bladeTip.scale.z = 0.28; // flatten the 4-sided tip toward the blade's profile
bladeTip.castShadow = true;
sword.add(bladeTip);

// fuller (center groove) — a thin darker inlay for detail
const fuller = new THREE.Mesh(
  new THREE.BoxGeometry(0.012, CFG.bladeLength * 0.7, 0.014),
  new THREE.MeshStandardMaterial({ color: 0xaeb9cc, metalness: 1, roughness: 0.35 })
);
fuller.position.y = bladeMain.position.y;
sword.add(fuller);

const guard = new THREE.Mesh(
  new THREE.BoxGeometry(0.19, 0.028, 0.05),
  guardMat
);
guard.position.y = CFG.gripLength;
guard.castShadow = true;
sword.add(guard);

const grip = new THREE.Mesh(
  new THREE.CylinderGeometry(0.017, 0.019, CFG.gripLength, 16),
  gripMat
);
grip.position.y = CFG.gripLength / 2;
sword.add(grip);

const pommel = new THREE.Mesh(
  new THREE.SphereGeometry(0.024, 16, 12),
  guardMat
);
pommel.position.y = 0;
pommel.castShadow = true;
sword.add(pommel);

// Rest ("mount") orientation: blade up and tilted slightly forward — a guard stance.
const mountQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42, 0, 0, 'XYZ'));

// blade local endpoints (guard base and tip) for collision + trail
const BLADE_BASE_LOCAL = new THREE.Vector3(0, CFG.gripLength, 0);
const BLADE_TIP_LOCAL = new THREE.Vector3(0, CFG.gripLength + CFG.bladeLength, 0);
// inner point for a thin tip-trail ribbon (upper third of the blade)
const BLADE_TRAIL_LOCAL = new THREE.Vector3(0, CFG.gripLength + CFG.bladeLength * 0.62, 0);

// ---------------------------------------------------------------------------
// Training dummy (humanoid pell on a springy base)
// ---------------------------------------------------------------------------
const dummyRoot = new THREE.Group();
scene.add(dummyRoot);

// static weighted base (does not tilt)
const baseMat = new THREE.MeshStandardMaterial({ color: 0x20242f, metalness: 0.4, roughness: 0.6 });
const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.14, 32), baseMat);
base.position.y = 0.07;
base.castShadow = true; base.receiveShadow = true;
dummyRoot.add(base);
const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.34, 20), baseMat);
post.position.y = 0.24;
post.castShadow = true;
dummyRoot.add(post);

// the part that reacts (tilts about ~y=0.35)
const PIVOT_Y = 0.35;
const body = new THREE.Group();
body.position.set(0, PIVOT_Y, 0);
dummyRoot.add(body);

const woodMat = new THREE.MeshStandardMaterial({ color: 0xb0763f, metalness: 0.05, roughness: 0.7 });
const woodDark = new THREE.MeshStandardMaterial({ color: 0x7d5228, metalness: 0.05, roughness: 0.75 });

// Helper to add a mesh to body with local offset (relative to pivot).
function addPart(mesh, x, y, z) {
  mesh.position.set(x, y - PIVOT_Y, z);
  mesh.castShadow = true;
  body.add(mesh);
  return mesh;
}

// torso, head, arms — each also registered as a collision capsule
const parts = [];
function registerCapsule(mesh, a, b, radius, name, scoreMul = 1) {
  parts.push({ mesh, a: a.clone(), b: b.clone(), radius, name, scoreMul, flash: 0, cd: 0 });
}

const torso = addPart(new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.62, 8, 20), woodMat), 0, 1.12, 0);
registerCapsule(torso, new THREE.Vector3(0, -0.31, 0), new THREE.Vector3(0, 0.31, 0), 0.28, 'torso', 1);

const hips = addPart(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.18, 8, 18), woodDark), 0, 0.72, 0);
registerCapsule(hips, new THREE.Vector3(0, -0.09, 0), new THREE.Vector3(0, 0.09, 0), 0.24, 'body', 1);

const neck = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.1, 16), woodDark), 0, 1.5, 0);
const head = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 18), woodMat), 0, 1.66, 0);
registerCapsule(head, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.02, 0), 0.18, 'head', 2);

// simple carved face marks
const faceMat = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.8 });
const eyeL = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), faceMat), -0.06, 1.70, 0.15);
const eyeR = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), faceMat), 0.06, 1.70, 0.15);

// arms as angled pegs (wing-chun-ish)
function makeArm(side) {
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.5, 6, 14), woodDark);
  const shoulderX = 0.30 * side;
  arm.rotation.z = 0.5 * side;
  arm.rotation.x = -0.35;
  addPart(arm, shoulderX, 1.28, 0.08);
  // capsule endpoints in body-local space (approx along the arm)
  const len = 0.32;
  const dir = new THREE.Vector3(Math.sin(0.5 * side), -Math.cos(0.5 * side), 0.34).normalize();
  const shoulderLocal = new THREE.Vector3(shoulderX, 1.28 - PIVOT_Y, 0.08);
  const a = shoulderLocal.clone().addScaledVector(dir, -len);
  const b = shoulderLocal.clone().addScaledVector(dir, len);
  // register on the arm mesh but express endpoints relative to the arm mesh's own frame:
  // simpler: register against body via a proxy object whose matrixWorld == body's.
  registerCapsuleBody(a, b, 0.09, side < 0 ? 'armL' : 'armR', 1);
  return arm;
}
// capsules expressed directly in body-local coords (transformed by body.matrixWorld)
const bodyCapsules = [];
function registerCapsuleBody(a, b, radius, name, scoreMul) {
  bodyCapsules.push({ a: a.clone(), b: b.clone(), radius, name, scoreMul, cd: 0 });
}
makeArm(-1);
makeArm(1);

// Dummy reaction state (damped spring, tilts about X and Z; small twist about Y)
const dummy = {
  leanX: 0, leanZ: 0, twist: 0,
  velX: 0, velZ: 0, velT: 0,
  hitPulse: 0,
};

// ---------------------------------------------------------------------------
// Blade trail (fading ribbon)
// ---------------------------------------------------------------------------
class Trail {
  constructor(maxSamples = 16) {
    this.max = maxSamples;
    this.samples = []; // {tip:Vector3, base:Vector3}
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxSamples * 2 * 3);
    this.colors = new Float32Array(maxSamples * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const idx = [];
    for (let i = 0; i < maxSamples - 1; i++) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
    }
    geo.setIndex(idx);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  push(base, tip, intensity) {
    this.samples.push({ base: base.clone(), tip: tip.clone(), i: intensity });
    if (this.samples.length > this.max) this.samples.shift();
    this._rebuild();
  }
  _rebuild() {
    const n = this.samples.length;
    for (let i = 0; i < this.max; i++) {
      const s = this.samples[Math.min(i, n - 1)] || this.samples[0];
      const o = i * 6;
      if (!s) { this.positions[o + 1] = -100; this.positions[o + 4] = -100; continue; }
      this.positions[o] = s.base.x; this.positions[o + 1] = s.base.y; this.positions[o + 2] = s.base.z;
      this.positions[o + 3] = s.tip.x; this.positions[o + 4] = s.tip.y; this.positions[o + 5] = s.tip.z;
      const age = i / this.max;                 // 0 oldest .. 1 newest
      const a = Math.pow(age, 2.0) * (s.i || 0);
      // cyan core fading to soft blue at the trailing edge
      const co = i * 6;
      this.colors[co] = 0.18 * a;
      this.colors[co + 1] = 0.55 * a;
      this.colors[co + 2] = 0.9 * a;
      this.colors[co + 3] = 0.5 * a;
      this.colors[co + 4] = 0.85 * a;
      this.colors[co + 5] = 1.0 * a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
const trail = new Trail();

// ---------------------------------------------------------------------------
// Hit particles (pooled)
// ---------------------------------------------------------------------------
const MAX_P = 240;
const pPos = new Float32Array(MAX_P * 3);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const sparkTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,224,150,0.9)');
  g.addColorStop(1, 'rgba(255,120,60,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); return t;
})();
const pMat = new THREE.PointsMaterial({
  size: 0.14, map: sparkTex, transparent: true, blending: THREE.AdditiveBlending,
  depthWrite: false, sizeAttenuation: true,
});
const points = new THREE.Points(pGeo, pMat);
points.frustumCulled = false;
scene.add(points);
const sparks = []; // {pos, vel, life, max}
for (let i = 0; i < MAX_P; i++) pPos[i * 3 + 1] = -1000;

function burst(pos, dir, power) {
  const count = Math.min(28, 10 + Math.floor(power * 0.2));
  for (let i = 0; i < count; i++) {
    if (sparks.length >= MAX_P) break;
    const v = dir.clone().multiplyScalar(1.5 + Math.random() * 2.5 * (power / 60));
    v.x += (Math.random() - 0.5) * 3;
    v.y += (Math.random() - 0.5) * 3 + 1.2;
    v.z += (Math.random() - 0.5) * 3;
    sparks.push({ pos: pos.clone(), vel: v, life: 0, max: 0.35 + Math.random() * 0.3 });
  }
}
function updateSparks(dt) {
  let w = 0;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life += dt;
    if (s.life >= s.max) { sparks.splice(i, 1); continue; }
    s.vel.y -= 9.8 * dt;
    s.pos.addScaledVector(s.vel, dt);
  }
  for (let i = 0; i < MAX_P; i++) {
    if (i < sparks.length) {
      const p = sparks[i].pos;
      pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
    } else {
      pPos[i * 3 + 1] = -1000;
    }
  }
  pGeo.attributes.position.needsUpdate = true;
}

// impact flash light
const impactLight = new THREE.PointLight(0xffd9a0, 0, 6, 2);
scene.add(impactLight);

// ---------------------------------------------------------------------------
// Audio (procedural — no assets)
// ---------------------------------------------------------------------------
let audioCtx = null;
function initAudio() {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ }
}
function noiseBuffer(dur) {
  const n = Math.floor(audioCtx.sampleRate * dur);
  const buf = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
function playHit(power, metal) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  const vol = Math.min(0.9, 0.25 + power / 130);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  gain.connect(audioCtx.destination);
  // thud body
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(metal ? 520 : 160, t);
  osc.frequency.exponentialRampToValueAtTime(metal ? 180 : 70, t + 0.25);
  osc.connect(gain); osc.start(t); osc.stop(t + 0.32);
  // noise transient
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer(0.18);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = metal ? 3200 : 900; bp.Q.value = 0.8;
  const ng = audioCtx.createGain();
  ng.gain.setValueAtTime(vol * 0.8, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  src.connect(bp); bp.connect(ng); ng.connect(audioCtx.destination);
  src.start(t); src.stop(t + 0.18);
}
let whooshGain = null, whooshFilter = null;
function ensureWhoosh() {
  if (!audioCtx || whooshGain) return;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer(2); src.loop = true;
  whooshFilter = audioCtx.createBiquadFilter();
  whooshFilter.type = 'bandpass'; whooshFilter.frequency.value = 800; whooshFilter.Q.value = 1.2;
  whooshGain = audioCtx.createGain(); whooshGain.gain.value = 0;
  src.connect(whooshFilter); whooshFilter.connect(whooshGain); whooshGain.connect(audioCtx.destination);
  src.start();
}
function setWhoosh(speed) {
  if (!whooshGain) return;
  const target = Math.min(0.14, Math.max(0, (speed - 2.5) * 0.02));
  whooshGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.05);
  whooshFilter.frequency.setTargetAtTime(500 + speed * 120, audioCtx.currentTime, 0.05);
}

// ---------------------------------------------------------------------------
// Input: orientation quaternion from IMU, or mouse
// ---------------------------------------------------------------------------
const zee = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X
const eulerTmp = new THREE.Euler();
function deviceQuaternion(alpha, beta, gamma, orient, out) {
  eulerTmp.set(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(eulerTmp);
  out.multiply(q1);
  out.multiply(new THREE.Quaternion().setFromAxisAngle(zee, -orient));
  return out;
}

const input = {
  mode: LOCAL_MODE ? 'sensor' : 'idle', // 'sensor' | 'mouse' | 'idle'
  rawQ: new THREE.Quaternion(),
  refInv: new THREE.Quaternion(),       // calibration reference (inverse)
  hasCalib: false,
  // mouse target angles
  mYaw: 0, mPitch: 0, mYawT: 0, mPitchT: 0,
};

function calibrate() {
  input.refInv.copy(input.rawQ).invert();
  input.hasCalib = true;
  hintPill.innerHTML = 'Calibrated · <b>swing!</b>';
  setTimeout(() => { hintPill.innerHTML = 'Swing to strike · aim for the <b>head</b> for 2×'; }, 1600);
}

function applyIMU(msg) {
  input.mode = 'sensor';
  deviceQuaternion(msg.o[0], msg.o[1], msg.o[2], msg.orient || 0, input.rawQ);
  if (!input.hasCalib) { input.refInv.copy(input.rawQ).invert(); input.hasCalib = true; }
}

// mouse control for testing
function setupMouse() {
  input.mode = 'mouse';
  input.hasCalib = true;
  window.addEventListener('pointermove', (e) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    input.mYawT = -nx * 1.4;
    input.mPitchT = -ny * 1.3;
  });
  window.addEventListener('pointerdown', () => { input.mThrust = 0.35; });
}

// Local-device sensors (solo mode: this page reads its own IMU)
function setupLocalSensors() {
  const onO = (e) => {
    if (e.alpha == null && e.beta == null && e.gamma == null) return;
    const orient = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
    deviceQuaternion(
      (e.alpha || 0) * Math.PI / 180,
      (e.beta || 0) * Math.PI / 180,
      (e.gamma || 0) * Math.PI / 180,
      orient, input.rawQ
    );
    input.mode = 'sensor';
    if (!input.hasCalib) { input.refInv.copy(input.rawQ).invert(); input.hasCalib = true; }
  };
  window.addEventListener('deviceorientation', onO, true);
  // tap to calibrate in solo mode
  window.addEventListener('pointerdown', () => calibrate());
}

async function requestLocalMotionPermission() {
  const needsO = typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function';
  if (needsO) {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      return r === 'granted';
    } catch { return false; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Collision: closest distance between two segments
// ---------------------------------------------------------------------------
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
function segSegClosest(p1, q1v, p2, q2v, outC1, outC2) {
  _d1.subVectors(q1v, p1);
  _d2.subVectors(q2v, p2);
  _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s, t;
  const EPS = 1e-8;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= EPS) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  outC1.copy(p1).addScaledVector(_d1, s);
  outC2.copy(p2).addScaledVector(_d2, t);
  return outC1.distanceTo(outC2);
}

// ---------------------------------------------------------------------------
// Game state / HUD
// ---------------------------------------------------------------------------
const game = { hits: 0, combo: 0, bestCombo: 0, lastHitTime: -999, running: false };
function registerHit(part, power, worldPoint, dir, metal) {
  game.hits++;
  const now = performance.now();
  if (now - game.lastHitTime < 1400) game.combo++; else game.combo = 1;
  game.lastHitTime = now;
  game.bestCombo = Math.max(game.bestCombo, game.combo);

  const score = Math.round(power * (part.scoreMul || 1));
  hitsN.textContent = game.hits;
  bestComboEl.textContent = game.bestCombo;
  const label = part.name === 'head' ? 'HEADSHOT! ' : '';
  comboText.textContent = game.combo > 1 ? `${label}${game.combo}× COMBO  +${score * game.combo}` : `${label}+${score}`;
  comboText.style.opacity = 1;
  clearTimeout(registerHit._t);
  registerHit._t = setTimeout(() => { comboText.style.opacity = 0.0; }, 900);

  // effects
  burst(worldPoint, dir, power);
  impactLight.position.copy(worldPoint);
  impactLight.intensity = 3.5 + power * 0.05;
  playHit(power, metal);
  // flash
  flashEl.style.background = `radial-gradient(circle at 50% 55%, rgba(255,255,255,${Math.min(0.28, power / 260)}), rgba(255,255,255,0) 60%)`;
  clearTimeout(registerHit._f);
  registerHit._f = setTimeout(() => { flashEl.style.background = 'none'; }, 70);

  // impulse into dummy (horizontal push in blade-motion direction, lever = hit height)
  const lever = THREE.MathUtils.clamp((worldPoint.y - PIVOT_Y) / 1.2, 0.15, 1.2);
  const push = new THREE.Vector3(dir.x, 0, dir.z);
  const mag = Math.min(1.6, power * CFG.impulseScale) * lever;
  dummy.velX += push.z * mag;      // push +z tilts top toward +z
  dummy.velZ -= push.x * mag;      // push +x tilts top toward +x (see notes)
  dummy.velT += (dir.x * 0.4 - dir.z * 0.2) * mag * 0.6;
  dummy.hitPulse = 1;

  // haptic back to phone
  if (net && net.joined) net.send({ t: 'haptic', ms: Math.min(60, 15 + power * 0.4) });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const handAnchor = CFG.handAnchor.clone();
const prevTip = new THREE.Vector3();
const prevBase = new THREE.Vector3();
const curTip = new THREE.Vector3();
const curBase = new THREE.Vector3();
const curTrailInner = new THREE.Vector3();
let haveTip = false;
const _mq = new THREE.Quaternion();
const _rel = new THREE.Quaternion();
const _seg = { a: new THREE.Vector3(), b: new THREE.Vector3() };
const bladeVel = new THREE.Vector3();

function updateSwordOrientation() {
  if (input.mode === 'mouse') {
    input.mYaw += (input.mYawT - input.mYaw) * 0.25;
    input.mPitch += (input.mPitchT - input.mPitch) * 0.25;
    const thrust = input.mThrust || 0;
    input.mThrust = Math.max(0, thrust - 0.03);
    _mq.setFromEuler(new THREE.Euler(input.mPitch - 0.42 - thrust, input.mYaw, 0, 'YXZ'));
    sword.quaternion.copy(_mq);
  } else {
    // relative to calibration, then mounted into the guard stance
    _rel.copy(input.refInv).multiply(input.rawQ);
    sword.quaternion.copy(_rel).multiply(mountQ);
  }
  sword.position.copy(handAnchor);
}

function updateDummy(dt) {
  // damped spring toward upright
  const ax = -CFG.springK * dummy.leanX - CFG.springC * dummy.velX;
  const az = -CFG.springK * dummy.leanZ - CFG.springC * dummy.velZ;
  const at = -CFG.springK * 0.6 * dummy.twist - CFG.springC * dummy.velT;
  dummy.velX += ax * dt; dummy.velZ += az * dt; dummy.velT += at * dt;
  dummy.leanX += dummy.velX * dt; dummy.leanZ += dummy.velZ * dt; dummy.twist += dummy.velT * dt;
  dummy.leanX = THREE.MathUtils.clamp(dummy.leanX, -CFG.maxLean, CFG.maxLean);
  dummy.leanZ = THREE.MathUtils.clamp(dummy.leanZ, -CFG.maxLean, CFG.maxLean);
  body.rotation.set(dummy.leanX, dummy.twist, dummy.leanZ, 'YXZ');
  dummy.hitPulse = Math.max(0, dummy.hitPulse - dt * 3);
  ring.material.opacity = 0.35 + dummy.hitPulse * 0.5;
  ring.scale.setScalar(1 + dummy.hitPulse * 0.12);
}

// Reusable capsule list, rebuilt to world space each frame.
const _worldCaps = [];
const _iBase = new THREE.Vector3();
const _iTip = new THREE.Vector3();
const _hitPt = new THREE.Vector3();

function checkHits(dt) {
  if (!haveTip) return;
  const speed = bladeVel.length();
  speedN.textContent = speed.toFixed(1);
  powerFill.style.width = Math.min(100, speed * 8) + '%';
  setWhoosh(speed);
  const intensity = THREE.MathUtils.clamp((speed - 1.5) / 8, 0, 1);
  trail.push(curTrailInner, curTip, intensity);

  if (speed < CFG.hitSpeedMin) return;

  const power = Math.min(100, speed * 8.5);
  const dir = bladeVel.clone().normalize();
  const now = performance.now();

  body.updateMatrixWorld(true);

  // Gather all collision capsules in world space once.
  _worldCaps.length = 0;
  for (const p of parts) {
    _worldCaps.push({
      a: p.a.clone().applyMatrix4(p.mesh.matrixWorld),
      b: p.b.clone().applyMatrix4(p.mesh.matrixWorld),
      radius: p.radius, meta: p,
    });
  }
  for (const c of bodyCapsules) {
    _worldCaps.push({
      a: c.a.clone().applyMatrix4(body.matrixWorld),
      b: c.b.clone().applyMatrix4(body.matrixWorld),
      radius: c.radius, meta: c,
    });
  }

  // Continuous collision: sweep the blade from its previous pose to the current
  // one in small sub-steps so a fast swing can't tunnel through the dummy.
  const tipTravel = curTip.distanceTo(prevTip);
  const steps = THREE.MathUtils.clamp(Math.ceil(tipTravel / 0.05), 1, 16);
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    _iBase.copy(prevBase).lerp(curBase, f);
    _iTip.copy(prevTip).lerp(curTip, f);
    for (const cap of _worldCaps) {
      const d = segSegClosest(_iBase, _iTip, cap.a, cap.b, _c1, _c2);
      const clearance = d - cap.radius;
      if (clearance < CFG.bladeRadius && now - cap.meta.cd >= CFG.hitCooldownMs) {
        cap.meta.cd = now;
        _hitPt.copy(_c2).lerp(_c1, 0.5);
        registerHit(cap.meta, power, _hitPt.clone(), dir, cap.meta.name === 'head');
      }
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  updateSwordOrientation();

  // world tip / base for physics + trail
  curBase.copy(BLADE_BASE_LOCAL).applyQuaternion(sword.quaternion).add(sword.position);
  curTip.copy(BLADE_TIP_LOCAL).applyQuaternion(sword.quaternion).add(sword.position);
  curTrailInner.copy(BLADE_TRAIL_LOCAL).applyQuaternion(sword.quaternion).add(sword.position);
  if (haveTip && dt > 0) bladeVel.copy(curTip).sub(prevTip).multiplyScalar(1 / dt);
  else bladeVel.set(0, 0, 0);

  // Collision uses prev*+cur* (swept), so run it before updating prev*.
  if (game.running) checkHits(dt);
  prevTip.copy(curTip);
  prevBase.copy(curBase);
  haveTip = true;

  updateDummy(dt);
  updateSparks(dt);
  impactLight.intensity *= 0.86;

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Networking + pairing
// ---------------------------------------------------------------------------
let net = null;
let roomCode = '';

function setPair(connected) {
  pairDot.className = 'dot ' + (connected ? 'on' : 'warn');
  pairStatus.textContent = connected ? 'phone connected!' : 'waiting for phone…';
  startBtn.disabled = false;
  if (connected && !game.running) {
    // auto-enter shortly after phone connects
    startBtn.textContent = 'Enter Arena ▶';
  }
}

function setupNetworked() {
  roomCode = makeRoomCode();
  roomCodeEl.textContent = roomCode;
  const url = `${location.origin}/controller.html?room=${roomCode}`;
  joinUrlEl.textContent = location.host + '/controller.html';
  // QR (davidshimjs/qrcodejs renders into the #qr element)
  if (window.QRCode && $('qr')) {
    try {
      $('qr').innerHTML = '';
      new window.QRCode($('qr'), {
        text: url, width: 132, height: 132,
        colorDark: '#0a0d17', colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch { qrBox.style.display = 'none'; }
  } else if (qrBox) {
    qrBox.style.display = 'none';
  }

  net = new Net({
    role: 'game', room: roomCode,
    onStatus: () => {},
    onMessage: (msg) => {
      if (msg.t === 'imu') applyIMU(msg);
      else if (msg.t === 'calibrate') calibrate();
      else if (msg.t === 'presence' && msg.role === 'controller') setPair(msg.count > 0);
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function enterArena() {
  overlay.classList.add('hidden');
  hud.style.display = 'block';
  game.running = true;
  initAudio();
  ensureWhoosh();
}

startBtn.addEventListener('click', async () => {
  initAudio();
  if (LOCAL_MODE) {
    const ok = await requestLocalMotionPermission();
    if (!ok) localHint.textContent = 'Motion sensors were blocked — you can still test with mouse.';
    setupLocalSensors();
  }
  enterArena();
});

mouseBtn.addEventListener('click', () => {
  initAudio();
  setupMouse();
  enterArena();
  hintPill.innerHTML = 'Move mouse to aim · move fast to strike · click to thrust';
});

if (LOCAL_MODE) {
  // Solo mode: no pairing UI needed.
  qrBox.style.display = 'none';
  roomCodeEl.textContent = 'SOLO';
  joinUrlEl.textContent = 'this device';
  pairStatus.textContent = 'solo mode — this phone is the sword';
  pairDot.className = 'dot on';
  startBtn.textContent = 'Start & Enable Motion';
  document.querySelectorAll('.step')[1].style.display = 'none';
  localHint.textContent = 'Tap the screen any time to re-calibrate your neutral stance.';
} else {
  setupNetworked();
}

// Small public handle for debugging / automated tests.
window.iSword = { sword, dummy, game, input, calibrate };
