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
  comboWindowMs: 1500,      // time to keep a combo alive
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
const flashEl = $('flash');
const dmgLayer = $('dmg');

// HUD readouts
const scoreN = $('scoreN');
const hitsN = $('hitsN');
const bestComboEl = $('bestCombo');
const speedN = $('speedN');
const powerFill = $('powerFill');
const comboWrap = $('comboWrap');
const comboN = $('comboN');
const comboTierEl = $('comboTier');
const comboMeterFill = $('comboMeterFill');
const targetCard = $('targetCard');
const targetPartEl = $('targetPart');
const targetMultEl = $('targetMult');
const targetTimer = $('targetTimer');
const bannerHint = $('bannerHint');
const bannerTitle = $('bannerTitle');
const popText = $('popText');

function setHint(html) { if (bannerHint) bannerHint.innerHTML = html; }

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090f);
scene.fog = new THREE.Fog(0x07090f, 7, 24);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.copy(CFG.camPos);
camera.lookAt(CFG.camLook);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ---------------------------------------------------------------------------
// Lighting — warm, dramatic, gold key with cool rim
// ---------------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0x8fb0ff, 0x120d08, 0.4);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffe6c0, 2.4);
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

const rim = new THREE.DirectionalLight(0x4a90ff, 1.1);
rim.position.set(-5, 4, -3);
scene.add(rim);

const fill = new THREE.PointLight(0xffb060, 0.6, 20, 2);
fill.position.set(-2, 2.4, 3);
scene.add(fill);

// two braziers flanking the arena for atmosphere
function brazier(x) {
  const l = new THREE.PointLight(0xff8a3c, 12, 9, 2);
  l.position.set(x, 1.9, -1.4);
  scene.add(l);
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb060 })
  );
  orb.position.copy(l.position);
  scene.add(orb);
  return l;
}
const braziers = [brazier(-3.2), brazier(3.2)];

// ---------------------------------------------------------------------------
// Floor + arena
// ---------------------------------------------------------------------------
function makeFloorTexture() {
  const s = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#14110c';
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 40, s / 2, s / 2, s / 1.5);
  g.addColorStop(0, '#3a3220');
  g.addColorStop(1, '#0d0b07');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // engraved gold rings
  ctx.strokeStyle = 'rgba(230,180,90,0.28)';
  ctx.lineWidth = 3;
  for (let r = 70; r < s / 2; r += 82) {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // runic spokes
  ctx.strokeStyle = 'rgba(200,150,80,0.12)';
  ctx.lineWidth = 2;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
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
  new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: 0.82, metalness: 0.2 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// glowing ring under the dummy (tinted by combo tier)
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.85, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: 0xe6b45a, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.012;
scene.add(ring);

// ---------------------------------------------------------------------------
// Sword
// ---------------------------------------------------------------------------
const sword = new THREE.Group();
scene.add(sword);

const bladeMat = new THREE.MeshStandardMaterial({
  color: 0xeaf2ff, metalness: 1.0, roughness: 0.16,
  envMapIntensity: 1.5, emissive: 0x000000,
});
const guardMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1.0, roughness: 0.32 });
const gripMat = new THREE.MeshStandardMaterial({ color: 0x3a2417, metalness: 0.1, roughness: 0.9 });

const bladeMain = new THREE.Mesh(new THREE.BoxGeometry(0.05, CFG.bladeLength * 0.82, 0.012), bladeMat);
bladeMain.position.y = CFG.gripLength + CFG.bladeLength * 0.41;
bladeMain.castShadow = true;
sword.add(bladeMain);

const bladeTip = new THREE.Mesh(new THREE.ConeGeometry(0.025, CFG.bladeLength * 0.18, 4), bladeMat);
bladeTip.position.y = CFG.gripLength + CFG.bladeLength * 0.82 + CFG.bladeLength * 0.09;
bladeTip.rotation.y = Math.PI / 4;
bladeTip.scale.z = 0.28;
bladeTip.castShadow = true;
sword.add(bladeTip);

const fuller = new THREE.Mesh(
  new THREE.BoxGeometry(0.012, CFG.bladeLength * 0.7, 0.014),
  new THREE.MeshStandardMaterial({ color: 0xaeb9cc, metalness: 1, roughness: 0.35 })
);
fuller.position.y = bladeMain.position.y;
sword.add(fuller);

const guard = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.028, 0.05), guardMat);
guard.position.y = CFG.gripLength;
guard.castShadow = true;
sword.add(guard);

const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, CFG.gripLength, 16), gripMat);
grip.position.y = CFG.gripLength / 2;
sword.add(grip);

const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 12), guardMat);
pommel.position.y = 0;
pommel.castShadow = true;
sword.add(pommel);

// round tsuba guard (shown only for the katana skin)
const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.014, 24), guardMat);
tsuba.rotation.x = Math.PI / 2;
tsuba.position.y = CFG.gripLength;
tsuba.visible = false;
tsuba.castShadow = true;
sword.add(tsuba);

// combo glow light riding the blade
const bladeGlow = new THREE.PointLight(0x5cc8ff, 0, 3.5, 2);
bladeGlow.position.y = CFG.gripLength + CFG.bladeLength * 0.7;
sword.add(bladeGlow);

// persistent effect light for fire / ice blades (independent of combo glow)
const fxLight = new THREE.PointLight(0xff5a20, 0, 2.8, 2);
fxLight.position.y = CFG.gripLength + CFG.bladeLength * 0.55;
sword.add(fxLight);

const mountQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42, 0, 0, 'XYZ'));

const BLADE_BASE_LOCAL = new THREE.Vector3(0, CFG.gripLength, 0);
const BLADE_TIP_LOCAL = new THREE.Vector3(0, CFG.gripLength + CFG.bladeLength, 0);
const BLADE_TRAIL_LOCAL = new THREE.Vector3(0, CFG.gripLength + CFG.bladeLength * 0.62, 0);

// ---------------------------------------------------------------------------
// Training dummy (humanoid pell on a springy base) + selectable skins
// ---------------------------------------------------------------------------
const dummyRoot = new THREE.Group();
scene.add(dummyRoot);

const baseMat = new THREE.MeshStandardMaterial({ color: 0x20242f, metalness: 0.4, roughness: 0.6 });
const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.14, 32), baseMat);
base.position.y = 0.07;
base.castShadow = true; base.receiveShadow = true;
dummyRoot.add(base);
const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.34, 20), baseMat);
post.position.y = 0.24;
post.castShadow = true;
dummyRoot.add(post);

const PIVOT_Y = 0.35;
const body = new THREE.Group();
body.position.set(0, PIVOT_Y, 0);
dummyRoot.add(body);

// "main" and "dark" body materials — mutated by applySkin()
const woodMat = new THREE.MeshStandardMaterial({ color: 0xb0763f, metalness: 0.05, roughness: 0.7 });
const woodDark = new THREE.MeshStandardMaterial({ color: 0x7d5228, metalness: 0.05, roughness: 0.75 });
const faceMat = new THREE.MeshStandardMaterial({ color: 0x201007, roughness: 0.8 });

const SKINS = {
  oak: {
    label: 'Oak', swatch: '#b0763f',
    main: { color: 0xb0763f, metalness: 0.05, roughness: 0.7, emissive: 0x000000 },
    dark: { color: 0x7d5228, metalness: 0.05, roughness: 0.75, emissive: 0x000000 },
    base: { color: 0x20242f, metalness: 0.4, roughness: 0.6 },
    ring: 0xe6b45a,
  },
  iron: {
    label: 'Iron', swatch: '#9aa3ad',
    main: { color: 0x9aa3ad, metalness: 0.85, roughness: 0.38, emissive: 0x000000 },
    dark: { color: 0x5b636d, metalness: 0.9, roughness: 0.42, emissive: 0x000000 },
    base: { color: 0x15181f, metalness: 0.6, roughness: 0.5 },
    ring: 0x8fd0ff,
  },
  gold: {
    label: 'Gold', swatch: '#e9b74a',
    main: { color: 0xe9b74a, metalness: 1.0, roughness: 0.26, emissive: 0x1a0e00 },
    dark: { color: 0xb07d1f, metalness: 1.0, roughness: 0.32, emissive: 0x120800 },
    base: { color: 0x1c140a, metalness: 0.7, roughness: 0.45 },
    ring: 0xffd166,
  },
};
let currentSkin = 'oak';
function applySkin(id) {
  const sk = SKINS[id] || SKINS.oak;
  currentSkin = id;
  woodMat.color.setHex(sk.main.color); woodMat.metalness = sk.main.metalness; woodMat.roughness = sk.main.roughness; woodMat.emissive.setHex(sk.main.emissive);
  woodDark.color.setHex(sk.dark.color); woodDark.metalness = sk.dark.metalness; woodDark.roughness = sk.dark.roughness; woodDark.emissive.setHex(sk.dark.emissive);
  baseMat.color.setHex(sk.base.color); baseMat.metalness = sk.base.metalness; baseMat.roughness = sk.base.roughness;
  ringBaseColor = sk.ring;
}
let ringBaseColor = 0xe6b45a;

function addPart(mesh, x, y, z) {
  mesh.position.set(x, y - PIVOT_Y, z);
  mesh.castShadow = true;
  body.add(mesh);
  return mesh;
}

const parts = [];
function registerCapsule(mesh, a, b, radius, name, scoreMul = 1, front = new THREE.Vector3(0, 0, 0.24)) {
  parts.push({ mesh, a: a.clone(), b: b.clone(), radius, name, scoreMul, front: front.clone(), cd: 0 });
}

const torso = addPart(new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.62, 8, 20), woodMat), 0, 1.12, 0);
registerCapsule(torso, new THREE.Vector3(0, -0.31, 0), new THREE.Vector3(0, 0.31, 0), 0.28, 'chest', 1.5, new THREE.Vector3(0, 0.05, 0.27));

const hips = addPart(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.18, 8, 18), woodDark), 0, 0.72, 0);
registerCapsule(hips, new THREE.Vector3(0, -0.09, 0), new THREE.Vector3(0, 0.09, 0), 0.24, 'stomach', 1.2, new THREE.Vector3(0, 0, 0.24));

const neck = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.1, 16), woodDark), 0, 1.5, 0);
const head = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 18), woodMat), 0, 1.66, 0);
registerCapsule(head, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.02, 0), 0.18, 'head', 2.0, new THREE.Vector3(0, 0, 0.17));

const eyeL = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), faceMat), -0.06, 1.70, 0.15);
const eyeR = addPart(new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), faceMat), 0.06, 1.70, 0.15);

const bodyCapsules = [];
function registerCapsuleBody(mesh, a, b, radius, name, scoreMul, front) {
  bodyCapsules.push({ mesh, a: a.clone(), b: b.clone(), radius, name, scoreMul, front: front.clone(), cd: 0 });
}
function makeArm(side) {
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.5, 6, 14), woodDark);
  const shoulderX = 0.30 * side;
  arm.rotation.z = 0.5 * side;
  arm.rotation.x = -0.35;
  addPart(arm, shoulderX, 1.28, 0.08);
  const len = 0.32;
  const dir = new THREE.Vector3(Math.sin(0.5 * side), -Math.cos(0.5 * side), 0.34).normalize();
  const shoulderLocal = new THREE.Vector3(shoulderX, 1.28 - PIVOT_Y, 0.08);
  const a = shoulderLocal.clone().addScaledVector(dir, -len);
  const b = shoulderLocal.clone().addScaledVector(dir, len);
  registerCapsuleBody(body, a, b, 0.09, side < 0 ? 'arm' : 'arm', 1.1,
    shoulderLocal.clone().add(new THREE.Vector3(0.05 * side, -0.05, 0.12)));
  return arm;
}
const enemyArmStatic = makeArm(-1); // dummy's right arm — animated (rig) in Duel
makeArm(1);

applySkin('oak');

const dummy = { leanX: 0, leanZ: 0, twist: 0, velX: 0, velZ: 0, velT: 0, hitPulse: 0 };

// ---------------------------------------------------------------------------
// Lit target marker (Target Rush mode) — a glowing weak-point on the dummy
// ---------------------------------------------------------------------------
function makeTargetMarker() {
  // Kept small so it marks the weak-point without obscuring the dummy.
  const g = new THREE.Group();
  const ringGeo = new THREE.RingGeometry(0.058, 0.08, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthTest: false });
  const rings = new THREE.Mesh(ringGeo, ringMat);
  g.add(rings);
  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.032, 20),
    new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false })
  );
  g.add(core);
  // crosshair ticks
  const tickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false });
  for (let i = 0; i < 4; i++) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.032), tickMat);
    t.position.set(Math.cos(i * Math.PI / 2) * 0.098, Math.sin(i * Math.PI / 2) * 0.098, 0);
    t.rotation.z = i * Math.PI / 2;
    g.add(t);
  }
  // countdown ring (scales down over target lifetime)
  const timerGeo = new THREE.RingGeometry(0.088, 0.104, 32);
  const timerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthTest: false });
  const timer = new THREE.Mesh(timerGeo, timerMat);
  g.add(timer);
  g.renderOrder = 999;
  g.visible = false;
  g.userData = { rings, core, timer, ringMat, coreMat: core.material, timerMat };
  return g;
}
const targetMarker = makeTargetMarker();
scene.add(targetMarker);

const rush = {
  active: false,
  cap: null,          // capsule meta being targeted
  worldPos: new THREE.Vector3(),
  radius: 0.17,       // hit tolerance (a bit larger than the marker — phone aim)
  mult: 1,
  time: 0,            // remaining seconds
  maxTime: 3.2,
  pulse: 0,
};

const RUSH_TARGETS = () => [...parts, ...bodyCapsules].filter(
  (c) => ['head', 'chest', 'stomach', 'arm'].includes(c.name)
);

function targetWorldPos(cap, out) {
  cap.mesh.updateMatrixWorld(true);
  out.copy(cap.front).applyMatrix4(cap.mesh.matrixWorld);
  return out;
}

function spawnRushTarget() {
  const pool = RUSH_TARGETS();
  let pick = pool[Math.floor(Math.random() * pool.length)];
  // avoid repeating the exact same spot twice in a row
  if (rush.cap && pool.length > 1) {
    let guard = 0;
    while (pick === rush.cap && guard++ < 5) pick = pool[Math.floor(Math.random() * pool.length)];
  }
  rush.cap = pick;
  rush.mult = pick.scoreMul;
  rush.maxTime = Math.max(1.5, 3.4 - game.combo * 0.05);
  rush.time = rush.maxTime;
  rush.active = true;
  targetMarker.visible = true;
  const tint = pick.name === 'head' ? 0xff4d6d : pick.name === 'chest' ? 0xffa24d : 0x5ce08a;
  targetMarker.userData.ringMat.color.setHex(tint);
  // Position it immediately (collision runs before updateRush in the loop).
  body.updateMatrixWorld(true);
  targetWorldPos(pick, rush.worldPos);
  targetMarker.position.copy(rush.worldPos);
  updateTargetCard();
}

function clearRushTarget() {
  rush.active = false;
  rush.cap = null;
  targetMarker.visible = false;
}

// ---------------------------------------------------------------------------
// Blade trail
// ---------------------------------------------------------------------------
class Trail {
  constructor(maxSamples = 16) {
    this.max = maxSamples;
    this.samples = [];
    this.color = new THREE.Color(0x9fd8ff);
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
      vertexColors: true, transparent: true, opacity: 0.5,
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
    const cr = this.color.r, cg = this.color.g, cb = this.color.b;
    for (let i = 0; i < this.max; i++) {
      const s = this.samples[Math.min(i, n - 1)] || this.samples[0];
      const o = i * 6;
      if (!s) { this.positions[o + 1] = -100; this.positions[o + 4] = -100; continue; }
      this.positions[o] = s.base.x; this.positions[o + 1] = s.base.y; this.positions[o + 2] = s.base.z;
      this.positions[o + 3] = s.tip.x; this.positions[o + 4] = s.tip.y; this.positions[o + 5] = s.tip.z;
      const age = i / this.max;
      const a = Math.pow(age, 2.0) * (s.i || 0);
      const co = i * 6;
      this.colors[co] = cr * a * 0.7; this.colors[co + 1] = cg * a * 0.85; this.colors[co + 2] = cb * a;
      this.colors[co + 3] = cr * a; this.colors[co + 4] = cg * a; this.colors[co + 5] = cb * a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
const trail = new Trail();

// ---------------------------------------------------------------------------
// Hit particles
// ---------------------------------------------------------------------------
const MAX_P = 340;
const pPos = new Float32Array(MAX_P * 3);
const pCol = new Float32Array(MAX_P * 3);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const sparkTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const pMat = new THREE.PointsMaterial({
  size: 0.15, map: sparkTex, transparent: true, blending: THREE.AdditiveBlending,
  depthWrite: false, sizeAttenuation: true, vertexColors: true,
});
const points = new THREE.Points(pGeo, pMat);
points.frustumCulled = false;
scene.add(points);
const sparks = [];
const _sparkCol = new THREE.Color();
for (let i = 0; i < MAX_P; i++) pPos[i * 3 + 1] = -1000;

const WARM = 0xffcf7a;
function burst(pos, dir, power, color = WARM, spread = 3.4) {
  const count = Math.min(40, 12 + Math.floor(power * 0.3));
  _sparkCol.setHex(color);
  for (let i = 0; i < count; i++) {
    if (sparks.length >= MAX_P) break;
    const v = dir.clone().multiplyScalar(1.5 + Math.random() * 3.0 * (power / 60));
    v.x += (Math.random() - 0.5) * spread;
    v.y += (Math.random() - 0.5) * spread + 1.4;
    v.z += (Math.random() - 0.5) * spread;
    sparks.push({ pos: pos.clone(), vel: v, life: 0, max: 0.35 + Math.random() * 0.35, r: _sparkCol.r, g: _sparkCol.g, b: _sparkCol.b });
  }
}
function updateSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life += dt;
    if (s.life >= s.max) { sparks.splice(i, 1); continue; }
    s.vel.y -= 9.8 * dt;
    s.pos.addScaledVector(s.vel, dt);
  }
  for (let i = 0; i < MAX_P; i++) {
    if (i < sparks.length) {
      const s = sparks[i];
      const k = 1 - s.life / s.max;
      pPos[i * 3] = s.pos.x; pPos[i * 3 + 1] = s.pos.y; pPos[i * 3 + 2] = s.pos.z;
      pCol[i * 3] = s.r * k; pCol[i * 3 + 1] = s.g * k; pCol[i * 3 + 2] = s.b * k;
    } else pPos[i * 3 + 1] = -1000;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Fire embers (continuous drift from a fire blade) + ice shards (on ice hit)
// ---------------------------------------------------------------------------
const MAX_E = 140;
const ePos = new Float32Array(MAX_E * 3);
const eCol = new Float32Array(MAX_E * 3);
const eGeo = new THREE.BufferGeometry();
eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
eGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3));
const emberMat = new THREE.PointsMaterial({ size: 0.1, map: sparkTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, vertexColors: true });
const emberPoints = new THREE.Points(eGeo, emberMat);
emberPoints.frustumCulled = false;
scene.add(emberPoints);
const embers = [];
for (let i = 0; i < MAX_E; i++) ePos[i * 3 + 1] = -1000;
const _emberAt = new THREE.Vector3();
function emitEmber(worldPoint) {
  if (embers.length >= MAX_E) return;
  const hot = Math.random();
  embers.push({
    pos: worldPoint.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05)),
    vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4),
    life: 0, max: 0.5 + Math.random() * 0.5,
    r: 1.0, g: 0.45 + hot * 0.3, b: 0.1 * hot,
  });
}
function updateEmbers(dt) {
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i];
    e.life += dt;
    if (e.life >= e.max) { embers.splice(i, 1); continue; }
    e.vel.y += 1.2 * dt; // embers accelerate upward slightly
    e.pos.addScaledVector(e.vel, dt);
  }
  for (let i = 0; i < MAX_E; i++) {
    if (i < embers.length) {
      const e = embers[i];
      const k = 1 - e.life / e.max;
      ePos[i * 3] = e.pos.x; ePos[i * 3 + 1] = e.pos.y; ePos[i * 3 + 2] = e.pos.z;
      eCol[i * 3] = e.r * k; eCol[i * 3 + 1] = e.g * k; eCol[i * 3 + 2] = e.b * k;
    } else ePos[i * 3 + 1] = -1000;
  }
  eGeo.attributes.position.needsUpdate = true;
  eGeo.attributes.color.needsUpdate = true;
}

// Ice shards — pooled small crystals that burst and fall on an ice-blade hit.
const iceShards = [];
const shardGeo = new THREE.OctahedronGeometry(0.05, 0);
const shardMat = new THREE.MeshStandardMaterial({ color: 0xcdeeff, emissive: 0x2a80b0, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.9, flatShading: true });
for (let i = 0; i < 26; i++) {
  const m = new THREE.Mesh(shardGeo, shardMat.clone());
  m.visible = false;
  scene.add(m);
  iceShards.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, max: 0, active: false });
}
function spawnIceShards(worldPoint, dir, power) {
  let spawned = 0;
  for (const sh of iceShards) {
    if (sh.active) continue;
    sh.active = true;
    sh.life = 0; sh.max = 0.5 + Math.random() * 0.4;
    sh.mesh.visible = true;
    sh.mesh.position.copy(worldPoint);
    const s = 0.6 + Math.random() * 0.9;
    sh.mesh.scale.setScalar(s);
    const v = dir.clone().multiplyScalar(1.5 + Math.random() * 2.5 * (power / 60));
    v.x += (Math.random() - 0.5) * 3; v.y += Math.random() * 2.4 + 0.6; v.z += (Math.random() - 0.5) * 3;
    sh.vel.copy(v);
    sh.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
    sh.baseScale = s;
    if (++spawned >= 10) break;
  }
}
function updateIceShards(dt) {
  for (const sh of iceShards) {
    if (!sh.active) continue;
    sh.life += dt;
    if (sh.life >= sh.max) { sh.active = false; sh.mesh.visible = false; continue; }
    sh.vel.y -= 9.8 * dt;
    sh.mesh.position.addScaledVector(sh.vel, dt);
    sh.mesh.rotation.x += sh.spin.x * dt;
    sh.mesh.rotation.y += sh.spin.y * dt;
    const k = 1 - sh.life / sh.max;
    sh.mesh.material.opacity = 0.9 * k;
    sh.mesh.scale.setScalar(sh.baseScale * (0.5 + 0.5 * k));
  }
}

// ---------------------------------------------------------------------------
// Sword skins — Classic, Katana, Fire, Ice
// ---------------------------------------------------------------------------
const SWORD_SKINS = {
  classic: {
    label: 'Classic', swatch: 'linear-gradient(180deg,#f2f6ff,#9fb0c8)',
    blade: { color: 0xeaf2ff, metalness: 1.0, roughness: 0.16, emissive: 0x000000, ei: 0 },
    guard: 'cross', guardColor: 0xd9a441, gripColor: 0x3a2417, width: 1.0,
    trail: 0x9fd8ff, effect: null, fx: { color: 0x000000, intensity: 0 }, spark: WARM,
  },
  katana: {
    label: 'Katana', swatch: 'linear-gradient(180deg,#e7edf5,#8b97a8)',
    blade: { color: 0xdfe8f2, metalness: 1.0, roughness: 0.1, emissive: 0x000000, ei: 0 },
    guard: 'tsuba', guardColor: 0x191919, gripColor: 0x5a1420, width: 0.68,
    trail: 0xffe0b0, effect: null, fx: { color: 0x000000, intensity: 0 }, spark: 0xfff0d0,
  },
  fire: {
    label: 'Fire', swatch: 'linear-gradient(180deg,#ffd08a,#ff4d10)',
    blade: { color: 0xffb45c, metalness: 0.5, roughness: 0.32, emissive: 0xff4a10, ei: 1.2 },
    guard: 'cross', guardColor: 0x6a2a10, gripColor: 0x2a1206, width: 1.0,
    trail: 0xff7a2c, effect: 'fire', fx: { color: 0xff5a20, intensity: 2.8 }, spark: 0xff6a1e,
  },
  ice: {
    label: 'Ice', swatch: 'linear-gradient(180deg,#eafaff,#4aa8d8)',
    blade: { color: 0xbfeaff, metalness: 0.55, roughness: 0.08, emissive: 0x1f88c0, ei: 0.85 },
    guard: 'cross', guardColor: 0x2a5a70, gripColor: 0x123040, width: 1.0,
    trail: 0x9fe8ff, effect: 'ice', fx: { color: 0x5cc8ff, intensity: 2.2 }, spark: 0x9fe8ff,
  },
};
let swordEffect = null;
let swordTrailColor = 0x9fd8ff;
let swordSparkColor = WARM;
let currentSword = 'classic';

function setSwordSkin(id) {
  const sk = SWORD_SKINS[id] || SWORD_SKINS.classic;
  currentSword = id;
  bladeMat.color.setHex(sk.blade.color);
  bladeMat.metalness = sk.blade.metalness;
  bladeMat.roughness = sk.blade.roughness;
  bladeMat.emissive.setHex(sk.blade.emissive);
  bladeMat.emissiveIntensity = sk.blade.ei;
  fuller.material.color.setHex(sk.blade.color);
  fuller.material.emissive.setHex(sk.blade.emissive);
  fuller.material.emissiveIntensity = sk.blade.ei * 0.6;
  guardMat.color.setHex(sk.guardColor);
  gripMat.color.setHex(sk.gripColor);
  const katana = sk.guard === 'tsuba';
  guard.visible = !katana;
  pommel.visible = !katana;
  tsuba.visible = katana;
  bladeMain.scale.x = sk.width;
  fuller.scale.x = sk.width;
  bladeTip.scale.x = sk.width;
  fxLight.color.setHex(sk.fx.color);
  fxLight.intensity = sk.fx.intensity;
  swordEffect = sk.effect;
  swordTrailColor = sk.trail;
  swordSparkColor = sk.spark;
  if (game.combo < 2) trail.color.setHex(swordTrailColor);
}

function swordHitFX(worldPoint, dir, power) {
  if (swordEffect === 'fire') {
    for (let i = 0; i < 12; i++) emitEmber(worldPoint);
    impactLight.color.setHex(0xff6a20);
  } else if (swordEffect === 'ice') {
    spawnIceShards(worldPoint, dir, power);
    impactLight.color.setHex(0x8fd6ff);
  }
}

const impactLight = new THREE.PointLight(0xffd9a0, 0, 6, 2);
scene.add(impactLight);

// ---------------------------------------------------------------------------
// Floating damage numbers (DOM, projected from 3D)
// ---------------------------------------------------------------------------
const _proj = new THREE.Vector3();
function spawnDamageNumber(worldPoint, text, cls) {
  if (!dmgLayer) return;
  _proj.copy(worldPoint).project(camera);
  if (_proj.z > 1) return;
  const x = (_proj.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
  const el = document.createElement('div');
  el.className = 'dmg ' + (cls || '');
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  dmgLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ---------------------------------------------------------------------------
// Audio
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
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(metal ? 620 : 160, t);
  osc.frequency.exponentialRampToValueAtTime(metal ? 200 : 70, t + 0.25);
  osc.connect(gain); osc.start(t); osc.stop(t + 0.32);
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer(0.18);
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = metal ? 3400 : 900; bp.Q.value = 0.8;
  const ng = audioCtx.createGain();
  ng.gain.setValueAtTime(vol * 0.8, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  src.connect(bp); bp.connect(ng); ng.connect(audioCtx.destination);
  src.start(t); src.stop(t + 0.18);
}
function playChime(freq, dur = 0.25) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
  const g = audioCtx.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + dur);
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
// Input
// ---------------------------------------------------------------------------
const zee = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const eulerTmp = new THREE.Euler();
function deviceQuaternion(alpha, beta, gamma, orient, out) {
  eulerTmp.set(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(eulerTmp);
  out.multiply(q1);
  out.multiply(new THREE.Quaternion().setFromAxisAngle(zee, -orient));
  return out;
}

const input = {
  mode: LOCAL_MODE ? 'sensor' : 'idle',
  rawQ: new THREE.Quaternion(),
  refInv: new THREE.Quaternion(),
  hasCalib: false,
  mYaw: 0, mPitch: 0, mYawT: 0, mPitchT: 0,
};

// Tap = stab: lunge the whole blade forward at the target, then draw back.
const stab = { active: false, t: 0, dur: 0.34 };
function triggerStab() {
  if (stab.active && stab.t < 0.14) return; // debounce a held tap
  stab.active = true; stab.t = 0;
  setWhoosh(9);
  if (typeof recordSwing === 'function') recordSwing('stab');
}

function calibrate() {
  input.refInv.copy(input.rawQ).invert();
  input.hasCalib = true;
  setHint('Calibrated · <b>swing!</b>');
  setTimeout(() => setHint(defaultHint()), 1600);
}
function defaultHint() {
  if (game.mode === 'rush') return 'Strike the <b>glowing point</b> before it fades · chain them!';
  if (game.mode === 'duel') return 'The dummy strikes back — <b>block its blade with yours</b>, then counter!';
  if (game.mode === 'drones') return 'Drones incoming — <b>slash them</b> before they reach you!';
  if (game.mode === 'idle') return 'Every hit pays gold — open the <b>🛒 shop</b> to upgrade!';
  return 'Swing to strike · <b>tap to stab</b> · aim for the head for 2×';
}

function applyIMU(msg) {
  input.mode = 'sensor';
  deviceQuaternion(msg.o[0], msg.o[1], msg.o[2], msg.orient || 0, input.rawQ);
  if (!input.hasCalib) { input.refInv.copy(input.rawQ).invert(); input.hasCalib = true; }
}

function setupMouse() {
  input.mode = 'mouse';
  input.hasCalib = true;
  window.addEventListener('pointermove', (e) => {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    input.mYawT = -nx * 1.4;
    input.mPitchT = -ny * 1.3;
  });
}

function setupLocalSensors() {
  const onO = (e) => {
    if (e.alpha == null && e.beta == null && e.gamma == null) return;
    const orient = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
    deviceQuaternion((e.alpha || 0) * Math.PI / 180, (e.beta || 0) * Math.PI / 180, (e.gamma || 0) * Math.PI / 180, orient, input.rawQ);
    input.mode = 'sensor';
    if (!input.hasCalib) { input.refInv.copy(input.rawQ).invert(); input.hasCalib = true; }
  };
  window.addEventListener('deviceorientation', onO, true);
}

async function requestLocalMotionPermission() {
  const needsO = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  if (needsO) {
    try { return (await DeviceOrientationEvent.requestPermission()) === 'granted'; } catch { return false; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
function segSegClosest(p1, q1v, p2, q2v, outC1, outC2) {
  _d1.subVectors(q1v, p1); _d2.subVectors(q2v, p2); _r.subVectors(p1, p2);
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
// Scoring / combos
// ---------------------------------------------------------------------------
const game = {
  mode: 'free', score: 0, hits: 0, combo: 0, bestCombo: 0,
  lastHitTime: -999, running: false, lastTier: -1,
  playerHP: 100, enemyHP: 130, duelOver: false,
};

const TIERS = [
  { min: 0, name: 'GOOD', color: '#7fd4ff' },
  { min: 5, name: 'GREAT', color: '#5ce08a' },
  { min: 15, name: 'AMAZING', color: '#ffd166' },
  { min: 30, name: 'MASTER', color: '#ff9f45' },
  { min: 50, name: 'LEGENDARY', color: '#ff4d6d' },
];
function tierIndex(n) {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (n >= TIERS[i].min) idx = i;
  return idx;
}
const PART_LABEL = { head: 'HEAD', chest: 'CHEST', stomach: 'STOMACH', arm: 'ARM', body: 'BODY' };

function updateComboUI() {
  const n = game.combo;
  if (n >= 2) {
    comboWrap.classList.add('show');
    comboN.textContent = n;
    const ti = tierIndex(n);
    const tier = TIERS[ti];
    comboTierEl.textContent = tier.name;
    comboN.style.color = tier.color;
    comboTierEl.style.color = tier.color;
    comboMeterFill.style.height = Math.min(100, (n / 50) * 100) + '%';
    comboMeterFill.style.background = tier.color;
    // blade + ring glow follow the tier
    const c = new THREE.Color(tier.color);
    bladeGlow.color.copy(c);
    bladeGlow.intensity = Math.min(5, 0.4 + n * 0.12);
    bladeMat.emissive.copy(c).multiplyScalar(Math.min(0.5, n * 0.012));
    trail.color.copy(c);
    ring.material.color.copy(c);
    // tier-up announcement
    if (ti !== game.lastTier && ti > 0) {
      announce(tier.name + '!', tier.color);
      playChime(440 + ti * 120, 0.3);
    }
    game.lastTier = ti;
  } else {
    comboWrap.classList.remove('show');
    bladeGlow.intensity = 0;
    // restore the sword skin's own blade emissive (fire/ice glow)
    const sk = SWORD_SKINS[currentSword] || SWORD_SKINS.classic;
    bladeMat.emissive.setHex(sk.blade.emissive);
    bladeMat.emissiveIntensity = sk.blade.ei;
    trail.color.setHex(swordTrailColor);
    ring.material.color.setHex(ringBaseColor);
    game.lastTier = -1;
  }
}

function announce(text, color) {
  if (!popText) return;
  popText.textContent = text;
  popText.style.color = color || '#ffd166';
  popText.classList.remove('pop');
  void popText.offsetWidth; // restart animation
  popText.classList.add('pop');
}

function updateTargetCard() {
  if (game.mode === 'rush') {
    targetCard.classList.add('rush');
    if (rush.cap) {
      targetPartEl.textContent = PART_LABEL[rush.cap.name] || rush.cap.name.toUpperCase();
      targetMultEl.textContent = '×' + rush.mult;
    }
  } else {
    targetCard.classList.remove('rush');
    targetPartEl.textContent = 'HEAD';
    targetMultEl.textContent = '×2';
  }
}

let shake = 0;
function registerHit(cap, power, worldPoint, dir, metal) {
  const now = performance.now();

  // Target Rush: only the lit weak-point advances the chain.
  let onTarget = true;
  let mult = cap.scoreMul || 1;
  if (game.mode === 'rush') {
    onTarget = rush.active && cap === rush.cap && worldPoint.distanceTo(rush.worldPos) < rush.radius;
    if (onTarget) {
      mult = rush.mult * 1.5;      // precision bonus
      rush.pulse = 1;
      spawnRushTarget();           // immediately light the next one
    } else {
      // glancing off-target hit: small feedback, no combo, keep the chain alive
      burst(worldPoint, dir, power * 0.4, swordSparkColor);
      playHit(power * 0.5, metal);
      applyImpulse(worldPoint, dir, power * 0.5);
      spawnDamageNumber(worldPoint, '' + Math.round(power * 0.6), 'graze');
      return;
    }
  }

  game.hits++;
  if (now - game.lastHitTime < CFG.comboWindowMs) game.combo++; else game.combo = 1;
  game.lastHitTime = now;
  game.bestCombo = Math.max(game.bestCombo, game.combo);

  const isHead = cap.name === 'head';
  const isPerfect = power > 78;
  const base = power * mult * 2.4;
  const comboFactor = 1 + (game.combo - 1) * 0.14;
  const dmg = Math.round(base * comboFactor);

  if (game.mode !== 'idle') {
    game.score += dmg;
    scoreN.textContent = game.score.toLocaleString();
  }
  hitsN.textContent = game.hits;
  bestComboEl.textContent = game.bestCombo;
  updateComboUI();

  // floating number (Gold Rush spawns its own gold numbers instead)
  if (game.mode !== 'idle') {
    let cls = '';
    if (isHead) cls = 'crit';
    else if (isPerfect) cls = 'perfect';
    else if (mult >= 1.5) cls = 'big';
    spawnDamageNumber(worldPoint, (isHead ? 'CRIT ' : '') + dmg, cls);
    if (isHead) announce('CRITICAL!', '#ff4d6d');
    else if (isPerfect && game.combo < 5) announce('PERFECT!', '#a48bff');
  }

  // effects
  burst(worldPoint, dir, power, swordSparkColor);
  impactLight.color.setHex(isHead ? 0xff9db0 : 0xffd9a0);
  impactLight.position.copy(worldPoint);
  impactLight.intensity = 4 + power * 0.06;
  swordHitFX(worldPoint, dir, power);
  playHit(power, metal || currentSkin !== 'oak');
  flashEl.style.background = `radial-gradient(circle at 50% 55%, rgba(255,240,210,${Math.min(0.3, power / 240)}), rgba(255,255,255,0) 60%)`;
  clearTimeout(registerHit._f);
  registerHit._f = setTimeout(() => { flashEl.style.background = 'none'; }, 70);
  shake = Math.min(0.13, 0.03 + power * 0.0011);

  applyImpulse(worldPoint, dir, power);
  if (game.mode === 'duel') damageEnemy(power, mult);
  if (game.mode === 'idle') idleOnHit(power * mult, worldPoint);

  if (net && net.joined) net.send({ t: 'haptic', ms: Math.min(70, 18 + power * 0.5) });
}

function applyImpulse(worldPoint, dir, power) {
  const lever = THREE.MathUtils.clamp((worldPoint.y - PIVOT_Y) / 1.2, 0.15, 1.2);
  const push = new THREE.Vector3(dir.x, 0, dir.z);
  const mag = Math.min(1.6, power * CFG.impulseScale) * lever;
  dummy.velX += push.z * mag;
  dummy.velZ -= push.x * mag;
  dummy.velT += (dir.x * 0.4 - dir.z * 0.2) * mag * 0.6;
  dummy.hitPulse = 1;
}

// ---------------------------------------------------------------------------
// Duel mode — the dummy fights back; block its blade with your own
// ---------------------------------------------------------------------------
const duelHud = $('duelHud');
const enemyHpEl = $('enemyHp');
const playerHpEl = $('playerHp');
const blockPrompt = $('blockPrompt');

function buildEnemySword() {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xc6ccd6, metalness: 1, roughness: 0.3, envMapIntensity: 1.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a1414, metalness: 0.3, roughness: 0.75 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0x7a4a24, metalness: 1, roughness: 0.45 });
  const L = 0.8, grip = 0.12;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, L * 0.85, 0.012), steel);
  blade.position.y = grip + L * 0.42; blade.castShadow = true; g.add(blade);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.028, L * 0.16, 4), steel);
  tip.position.y = grip + L * 0.85 + L * 0.08; tip.rotation.y = Math.PI / 4; tip.scale.z = 0.3; tip.castShadow = true; g.add(tip);
  const gd = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.028, 0.045), bronze); gd.position.y = grip; g.add(gd);
  const gp = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, grip, 12), dark); gp.position.y = grip / 2; g.add(gp);
  const glow = new THREE.PointLight(0xff3018, 0, 2.2, 2); glow.position.y = grip + L * 0.6; g.add(glow);
  g.userData = { L, grip, glow };
  return g;
}
const enemySword = buildEnemySword();
enemySword.visible = false;
scene.add(enemySword);

// The dummy faces you, so its RIGHT hand is on your left (screen -x) — the
// mirror of your own grip.
const enemyHand = new THREE.Vector3(-0.26, 1.26, 0.32);
const Q = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
const enemyGuard = Q(-0.45, -0.15, 0.3);

// Each attack ends by aiming the blade (local +Y) from the hand at a point on
// your body; the wind-up offset decides which arc it swings through, so the
// four swings come at you from clearly different directions.
const UP = new THREE.Vector3(0, 1, 0);
const AX_X = new THREE.Vector3(1, 0, 0), AX_Y = new THREE.Vector3(0, 1, 0);
const _aimD = new THREE.Vector3();
function aimQuat(target, out, from) {
  _aimD.copy(target).sub(from).normalize();
  return out.setFromUnitVectors(UP, _aimD);
}
const ENEMY_ATTACKS = [
  { name: 'overhead', aim: new THREE.Vector3(0.0, 1.55, 1.0), axis: AX_X, wind: -2.3, dur: 0.30 },
  { name: 'slashL',   aim: new THREE.Vector3(-0.30, 1.34, 1.0), axis: AX_Y, wind: 1.8, dur: 0.26 },
  { name: 'slashR',   aim: new THREE.Vector3(0.30, 1.34, 1.0), axis: AX_Y, wind: -1.8, dur: 0.26 },
  { name: 'thrust',   aim: new THREE.Vector3(0.0, 1.2, 1.05), axis: AX_X, wind: 1.4, dur: 0.22 },
];

const enemy = {
  L: enemySword.userData.L, grip: enemySword.userData.grip,
  q: enemyGuard.clone(), state: 'idle', t: 0, nextT: 1.2, stun: 0,
  strikeQ: new THREE.Quaternion(), windupQ: new THREE.Quaternion(),
  strikeDur: 0.28, attackName: '', resolved: false,
  base: new THREE.Vector3(), tip: new THREE.Vector3(), prevTip: new THREE.Vector3(),
};
const _offQ = new THREE.Quaternion();
function pickEnemyAttack() {
  const atk = ENEMY_ATTACKS[Math.floor(Math.random() * ENEMY_ATTACKS.length)];
  enemy.attack = atk;
  enemy.attackName = atk.name;
  enemy.strikeDur = atk.dur;
  aimQuat(atk.aim, enemy.strikeQ, enemyHand);
  _offQ.setFromAxisAngle(atk.axis, atk.wind);
  enemy.windupQ.copy(_offQ).multiply(enemy.strikeQ);
}

// Animated sword-arm: a forearm that swings from the shoulder so the hand (and
// sword) actually move with the strike, instead of the blade pivoting in place.
const enemyArmRig = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.062, 1, 12), woodDark);
enemyArmRig.castShadow = true;
enemyArmRig.visible = false;
scene.add(enemyArmRig);
const enemyHandMesh = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 12), woodDark);
enemyHandMesh.castShadow = true; enemyHandMesh.visible = false;
scene.add(enemyHandMesh);
const enemyShoulder = new THREE.Vector3(-0.31, 1.42, 0.05);
const ARM_LEN = 0.4;
const ARM_GUARD = new THREE.Vector3(0.18, -0.55, 0.5).normalize();
const ARM_WINDUP = new THREE.Vector3(-0.1, 0.85, -0.2).normalize();
const ARM_STRIKE = new THREE.Vector3(0.28, -0.05, 0.95).normalize();
const armDir = ARM_GUARD.clone();
const _handPos = new THREE.Vector3();
const _armVec = new THREE.Vector3();
function armTargetFor(state) {
  if (state === 'windup') return ARM_WINDUP;
  if (state === 'strike') return ARM_STRIKE;
  return ARM_GUARD;
}

const playerZone = new THREE.Vector3(0, 1.34, 1.0); // your body — enemy blade reaching here hits you
const PLAYER_HIT_R = 0.34;
const BLOCK_DIST = 0.18;
const ENEMY_MAX = 130, PLAYER_MAX = 100;

const _eB = new THREE.Vector3(), _eT = new THREE.Vector3();
const _cc1 = new THREE.Vector3(), _cc2 = new THREE.Vector3(), _mid = new THREE.Vector3();

function updateDuelHUD() {
  if (enemyHpEl) enemyHpEl.style.width = Math.max(0, (game.enemyHP / ENEMY_MAX) * 100) + '%';
  if (playerHpEl) playerHpEl.style.width = Math.max(0, (game.playerHP / PLAYER_MAX) * 100) + '%';
}
function startDuel() {
  game.playerHP = PLAYER_MAX; game.enemyHP = ENEMY_MAX; game.duelOver = false;
  enemy.state = 'idle'; enemy.t = 0; enemy.nextT = 1.1; enemy.stun = 0; enemy.resolved = false;
  enemy.q.copy(enemyGuard);
  enemySword.visible = true;
  enemySword.userData.glow.intensity = 0;
  updateDuelHUD();
  if (blockPrompt) blockPrompt.classList.remove('show');
  setHint('The dummy strikes back — <b>block its blade with yours</b>, then counter!');
}
function damageEnemy(power, mult) {
  if (game.duelOver) return;
  game.enemyHP -= 6 + power * 0.11 * mult;
  enemy.stun = Math.max(enemy.stun, 0.25);
  if (enemy.state === 'windup') { enemy.state = 'recover'; enemy.t = 0; if (blockPrompt) blockPrompt.classList.remove('show'); }
  updateDuelHUD();
  if (game.enemyHP <= 0) { game.enemyHP = 0; updateDuelHUD(); endDuel(true); }
}
function endDuel(win) {
  game.duelOver = true;
  enemy.state = 'idle'; enemy.q.copy(enemyGuard);
  if (blockPrompt) blockPrompt.classList.remove('show');
  announce(win ? 'VICTORY!' : 'DEFEATED', win ? '#ffd166' : '#ff4d6d');
  setHint(win ? 'You bested the dummy! · <b>tap to fight again</b>' : 'The dummy won this round · <b>tap to fight again</b>');
  playChime(win ? 720 : 150, 0.5);
}
function onBlock(mid) {
  enemy.resolved = true; enemy.state = 'recover'; enemy.t = 0; enemy.stun = 0.5;
  if (blockPrompt) blockPrompt.classList.remove('show');
  burst(mid, new THREE.Vector3(0, 1, 0.4).normalize(), 95, 0xfff0c0, 4.6);
  impactLight.color.setHex(0xfff0c0); impactLight.position.copy(mid); impactLight.intensity = 5.5;
  playHit(95, true);
  shake = 0.12;
  announce('PARRIED!', '#7fd4ff');
  if (net && net.joined) net.send({ t: 'haptic', ms: 50 });
}
function onPlayerStruck() {
  enemy.resolved = true; enemy.state = 'recover'; enemy.t = 0;
  if (blockPrompt) blockPrompt.classList.remove('show');
  game.playerHP -= 14;
  game.combo = 0; updateComboUI();
  updateDuelHUD();
  flashEl.style.background = 'radial-gradient(circle at 50% 55%, rgba(255,40,40,0.36), rgba(255,0,0,0) 65%)';
  clearTimeout(onPlayerStruck._f);
  onPlayerStruck._f = setTimeout(() => { flashEl.style.background = 'none'; }, 150);
  shake = 0.22;
  playHit(60, false);
  announce('HIT!', '#ff4d6d');
  if (net && net.joined) net.send({ t: 'haptic', ms: 120 });
  if (game.playerHP <= 0) { game.playerHP = 0; updateDuelHUD(); endDuel(false); }
}
function updateDuel(dt) {
  enemy.stun = Math.max(0, enemy.stun - dt);

  if (!game.duelOver) {
    switch (enemy.state) {
      case 'idle':
        enemy.q.slerp(enemyGuard, 1 - Math.pow(0.001, dt));
        enemy.t += dt;
        if (enemy.t >= enemy.nextT && enemy.stun <= 0) {
          enemy.state = 'windup'; enemy.t = 0; enemy.resolved = false;
          pickEnemyAttack();
          if (blockPrompt) blockPrompt.classList.add('show');
        }
        break;
      case 'windup':
        enemy.q.slerp(enemy.windupQ, 1 - Math.pow(0.0006, dt));
        enemySword.userData.glow.intensity = 1.6 + Math.sin(animTime * 20) * 0.8;
        enemy.t += dt;
        if (enemy.t >= 0.5) { enemy.state = 'strike'; enemy.t = 0; }
        break;
      case 'strike':
        enemy.q.slerp(enemy.strikeQ, 1 - Math.pow(1e-7, dt));
        enemy.t += dt;
        if (enemy.t >= enemy.strikeDur + 0.06) { enemy.state = 'recover'; enemy.t = 0; }
        break;
      case 'recover':
        enemy.q.slerp(enemyGuard, 1 - Math.pow(0.01, dt));
        enemySword.userData.glow.intensity *= 0.85;
        if (blockPrompt) blockPrompt.classList.remove('show');
        enemy.t += dt;
        if (enemy.t >= 0.5) { enemy.state = 'idle'; enemy.t = 0; enemy.nextT = 0.7 + Math.random() * 1.0; }
        break;
    }
  }

  // Swing the sword-arm: the hand moves along the shoulder, so the arm & sword
  // travel with the strike. The blade re-aims from wherever the hand is.
  armDir.lerp(armTargetFor(enemy.state), 1 - Math.pow(enemy.state === 'strike' ? 1e-4 : 0.02, dt)).normalize();
  _handPos.copy(enemyShoulder).addScaledVector(armDir, ARM_LEN);
  enemySword.position.copy(_handPos);
  if (enemy.state === 'strike' && enemy.attack) aimQuat(enemy.attack.aim, enemy.strikeQ, _handPos);
  // orient the forearm from shoulder to hand
  _armVec.copy(_handPos).sub(enemyShoulder);
  const armLen = _armVec.length();
  enemyArmRig.position.copy(enemyShoulder).addScaledVector(_armVec, 0.5);
  enemyArmRig.quaternion.setFromUnitVectors(UP, _armVec.clone().normalize());
  enemyArmRig.scale.set(1, armLen, 1);
  enemyHandMesh.position.copy(_handPos);

  enemySword.quaternion.copy(enemy.q);
  enemySword.updateMatrixWorld(true);

  _eB.set(0, enemy.grip, 0).applyMatrix4(enemySword.matrixWorld);
  _eT.set(0, enemy.grip + enemy.L, 0).applyMatrix4(enemySword.matrixWorld);
  enemy.base.copy(_eB); enemy.tip.copy(_eT);

  // Resolve the strike once, at the instant the incoming blade reaches you:
  // if your blade is meeting theirs then → parry, otherwise you take the hit.
  if (enemy.state === 'strike' && !enemy.resolved) {
    const reach = segSegClosest(playerZone, playerZone, _eB, _eT, _cc1, _cc2);
    if (reach < PLAYER_HIT_R) {
      const d = segSegClosest(curBase, curTip, _eB, _eT, _cc1, _cc2);
      const bladeLen = Math.max(0.001, curBase.distanceTo(curTip));
      const contactS = _cc1.distanceTo(curBase) / bladeLen; // where on your blade
      if (d < BLOCK_DIST && contactS > 0.28) {
        _mid.copy(_cc1).lerp(_cc2, 0.5);
        onBlock(_mid);
      } else {
        onPlayerStruck();
      }
    }
  }
  enemy.prevTip.copy(enemy.tip);
}

// ---------------------------------------------------------------------------
// Combo attacks — 4 swings in a series (or a named pattern) unleash a finisher
// ---------------------------------------------------------------------------
const COMBOS = [
  { id: 'cross',  name: 'Cross Slash',   seq: ['left', 'right', 'left', 'right'], keys: '← → ← →', color: '#5cc8ff' },
  { id: 'rising', name: 'Rising Dragon', seq: ['down', 'down', 'up'],             keys: '↓ ↓ ↑',   color: '#5ce08a' },
  { id: 'skewer', name: 'Skewer',        seq: ['stab', 'stab', 'stab'],           keys: '⊙ ⊙ ⊙',   color: '#ffd166' },
  { id: 'flurry', name: 'Blade Flurry',  seq: ['any', 'any', 'any', 'any'],       keys: '4 fast swings', color: '#ff5c7a' },
];
const swingBuf = []; // { dir, t }
let swingArmed = true;
function detectSwing(speed) {
  if (stab.active) { swingArmed = false; return; } // stab records itself
  if (speed < 2.6) swingArmed = true;
  else if (speed > 6 && swingArmed) {
    swingArmed = false;
    let dir;
    if (Math.abs(bladeVel.y) > Math.abs(bladeVel.x)) dir = bladeVel.y > 0 ? 'up' : 'down';
    else dir = bladeVel.x > 0 ? 'right' : 'left';
    recordSwing(dir);
  }
}
function recordSwing(dir) {
  const now = performance.now();
  if (swingBuf.length && now - swingBuf[swingBuf.length - 1].t > 1200) swingBuf.length = 0;
  swingBuf.push({ dir, t: now });
  if (swingBuf.length > 6) swingBuf.shift();
  for (const c of COMBOS) {
    const n = c.seq.length;
    if (swingBuf.length < n) continue;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const s = c.seq[n - 1 - i];
      if (s !== 'any' && swingBuf[swingBuf.length - 1 - i].dir !== s) { ok = false; break; }
    }
    if (ok) { triggerCombo(c); swingBuf.length = 0; return; }
  }
}

// expanding shockwave visual
const comboRing = new THREE.Mesh(
  new THREE.RingGeometry(0.5, 0.62, 48),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
);
comboRing.position.set(0, 1.15, 0.2);
comboRing.rotation.x = 0;
scene.add(comboRing);
let comboFx = 0;

function triggerCombo(c) {
  announce(c.name.toUpperCase() + '!', c.color);
  playChime(300, 0.12); setTimeout(() => playChime(600, 0.25), 90);
  comboFx = 1;
  comboRing.material.color.setHex(parseInt(c.color.slice(1), 16));
  shake = 0.25;
  flashEl.style.background = `radial-gradient(circle at 50% 55%, ${c.color}55, rgba(255,255,255,0) 60%)`;
  clearTimeout(triggerCombo._f);
  triggerCombo._f = setTimeout(() => { flashEl.style.background = 'none'; }, 160);

  const bonus = 800;
  game.score += bonus;
  scoreN.textContent = game.score.toLocaleString();
  spawnDamageNumber(new THREE.Vector3(0, 1.5, 0.2), 'COMBO +' + bonus, 'crit');

  // big burst across the dummy
  body.updateMatrixWorld(true);
  for (const p of parts) {
    const wp = p.a.clone().add(p.b).multiplyScalar(0.5).applyMatrix4(p.mesh.matrixWorld);
    burst(wp, new THREE.Vector3(0, 1, 0.3).normalize(), 80, swordSparkColor, 4.5);
  }
  dummy.velX += 2.2; dummy.hitPulse = 1;

  if (game.mode === 'duel' && !game.duelOver) {
    game.enemyHP -= 42; enemy.stun = 1.2;
    if (enemy.state === 'windup') { enemy.state = 'recover'; enemy.t = 0; if (blockPrompt) blockPrompt.classList.remove('show'); }
    updateDuelHUD();
    if (game.enemyHP <= 0) { game.enemyHP = 0; updateDuelHUD(); endDuel(true); }
  }
  if (game.mode === 'drones') {
    for (const d of drones) if (d.alive) killDrone(d, true);
  }
}
function updateComboFx(dt) {
  if (comboFx <= 0) { comboRing.visible = false; return; }
  comboFx = Math.max(0, comboFx - dt * 2);
  comboRing.visible = true;
  const s = 0.4 + (1 - comboFx) * 3.4;
  comboRing.scale.setScalar(s);
  comboRing.material.opacity = comboFx * 0.8;
  comboRing.lookAt(camera.position);
}

// ---------------------------------------------------------------------------
// Drone Slayer mode — flying drones swarm in; slash them out of the air
// ---------------------------------------------------------------------------
function buildDrone() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.7, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), mat);
  g.add(body);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3040 }));
  led.position.set(0, 0, 0.12); g.add(led);
  const glow = new THREE.PointLight(0xff3040, 0.6, 1.4, 2); g.add(glow);
  const rotors = [];
  for (const [x, z] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]]) {
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.16), mat);
    stalk.position.set(x * 0.6, 0.02, z * 0.6); stalk.lookAt(new THREE.Vector3(x, 0.05, z)); g.add(stalk);
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.006, 14),
      new THREE.MeshStandardMaterial({ color: 0x0f1218, metalness: 0.5, roughness: 0.6, transparent: true, opacity: 0.45 }));
    rotor.position.set(x, 0.06, z); g.add(rotor); rotors.push(rotor);
  }
  g.userData = { rotors, led, body };
  g.visible = false;
  return g;
}
const DRONE_R = 0.16;
const drones = [];
for (let i = 0; i < 12; i++) {
  const d = buildDrone();
  scene.add(d);
  drones.push({ group: d, alive: false, vel: new THREE.Vector3(), wobble: Math.random() * 6 });
}
const droneState = { spawnTimer: 0, spawnEvery: 1.4, killed: 0 };
const droneHudEl = $('droneCount');

function spawnDrone() {
  const d = drones.find((x) => !x.alive);
  if (!d) return;
  const ang = Math.random() * Math.PI - Math.PI / 2; // in front arc
  const r = 5 + Math.random() * 2;
  d.group.position.set(Math.sin(ang) * r, 1.2 + Math.random() * 1.4, -Math.cos(ang) * r + 0.2);
  d.alive = true; d.group.visible = true;
  d.wobble = Math.random() * 6;
}
function killDrone(d, byCombo) {
  if (!d.alive) return;
  d.alive = false; d.group.visible = false;
  droneState.killed++;
  if (droneHudEl) droneHudEl.textContent = droneState.killed;
  burst(d.group.position, new THREE.Vector3(0, 0.4, 1).normalize(), 70, 0xffb060, 4);
  impactLight.color.setHex(0xffc070); impactLight.position.copy(d.group.position); impactLight.intensity = 4;
  playHit(70, true);
  const now = performance.now();
  if (now - game.lastHitTime < CFG.comboWindowMs) game.combo++; else game.combo = 1;
  game.lastHitTime = now; game.hits++;
  game.bestCombo = Math.max(game.bestCombo, game.combo);
  const pts = Math.round(150 * (1 + (game.combo - 1) * 0.14));
  game.score += pts;
  scoreN.textContent = game.score.toLocaleString();
  hitsN.textContent = game.hits; bestComboEl.textContent = game.bestCombo;
  updateComboUI();
  spawnDamageNumber(d.group.position, '' + pts, byCombo ? 'crit' : 'big');
}
function startDrones() {
  game.playerHP = PLAYER_MAX; game.dronesOver = false;
  droneState.spawnTimer = 0; droneState.spawnEvery = 1.4; droneState.killed = 0;
  game.score = 0; game.combo = 0; game.hits = 0;
  scoreN.textContent = '0'; if (droneHudEl) droneHudEl.textContent = '0';
  for (const d of drones) { d.alive = false; d.group.visible = false; }
  updateDuelHUD();
  setHint('Drones incoming — <b>slash them</b> before they reach you!');
}
const _dToPlayer = new THREE.Vector3();
function updateDrones(dt) {
  if (!game.dronesOver) {
    droneState.spawnTimer += dt;
    droneState.spawnEvery = Math.max(0.5, 1.4 - droneState.killed * 0.02);
    if (droneState.spawnTimer >= droneState.spawnEvery) { droneState.spawnTimer = 0; spawnDrone(); }
  }
  for (const d of drones) {
    if (!d.alive) continue;
    d.wobble += dt * 6;
    for (const r of d.group.userData.rotors) r.rotation.y += dt * 40;
    d.group.userData.led.material.color.setHex((Math.sin(d.wobble * 2) > 0) ? 0xff3040 : 0x661018);
    // steer toward the player
    _dToPlayer.copy(playerZone).sub(d.group.position);
    const dist = _dToPlayer.length();
    _dToPlayer.normalize();
    const spd = game.dronesOver ? 0 : (1.1 + droneState.killed * 0.02);
    d.group.position.addScaledVector(_dToPlayer, spd * dt);
    d.group.position.y += Math.sin(d.wobble) * 0.004;
    d.group.lookAt(camera.position);
    // slashed?
    if (haveTip) {
      const dd = segSegClosest(d.group.position, d.group.position, curBase, curTip, _cc1, _cc2);
      if (dd < DRONE_R + CFG.bladeRadius && bladeVel.length() > 2.5) { killDrone(d, false); continue; }
    }
    // reached the player
    if (dist < 0.55 && !game.dronesOver) {
      d.alive = false; d.group.visible = false;
      game.playerHP -= 12; game.combo = 0; updateComboUI(); updateDuelHUD();
      flashEl.style.background = 'radial-gradient(circle at 50% 55%, rgba(255,40,40,0.34), rgba(255,0,0,0) 65%)';
      clearTimeout(updateDrones._f); updateDrones._f = setTimeout(() => { flashEl.style.background = 'none'; }, 150);
      shake = 0.2; playHit(50, false);
      if (net && net.joined) net.send({ t: 'haptic', ms: 120 });
      if (game.playerHP <= 0) {
        game.playerHP = 0; updateDuelHUD(); game.dronesOver = true;
        announce('OVERRUN!', '#ff4d6d');
        setHint('Drones down: <b>' + droneState.killed + '</b> · score <b>' + game.score.toLocaleString() + '</b> · tap to retry');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gold Rush — idle-clicker mode. Every hit pays gold; buy upgrades in the
// shop; kill the dummy to level it up (more HP, better loot, new look).
// Math follows the idle-game standard: exponential HP/costs, multiplicative
// upgrades, so it scales infinitely.
// ---------------------------------------------------------------------------
const IDLE_KEY = 'isword-goldrush-v1';
const idle = {
  gold: 0, level: 1, hp: 30, maxHP: 30, totalKills: 0,
  up: { dmg: 0, gold: 0, crit: 0, squire: 0 },
  owned: {}, equip: 'classic',
  squireT: 0, saveT: 0, coinT: 0,
};
const IDLE_UPGRADES = [
  { id: 'dmg', icon: '🗡️', name: 'Sharpen Blade', desc: '+25% damage per level', base: 15, growth: 1.5 },
  { id: 'gold', icon: '✨', name: 'Golden Touch', desc: '+20% gold per hit per level', base: 25, growth: 1.55 },
  { id: 'crit', icon: '💥', name: 'Critical Edge', desc: '+3% crit chance (5× damage)', base: 80, growth: 1.7, max: 15 },
  { id: 'squire', icon: '🤺', name: 'Squire', desc: 'Auto-hits every 2s (stacks per level)', base: 200, growth: 1.6 },
];
const IDLE_ITEMS = [
  { id: 'coins', icon: '🔔', name: 'Coin Shower', desc: 'Richer coin sound · +20% gold', cost: 1200, goldBonus: 1.2 },
  { id: 'katana', icon: '⚔️', name: 'Katana', desc: 'Swift blade skin · +25% gold', cost: 3000, goldBonus: 1.25, sword: 'katana' },
  { id: 'fire', icon: '🔥', name: 'Fire Sword', desc: 'Embers & flames · +50% gold', cost: 12000, goldBonus: 1.5, sword: 'fire' },
  { id: 'ice', icon: '❄️', name: 'Ice Sword', desc: 'Ice shards · +100% gold', cost: 50000, goldBonus: 2.0, sword: 'ice' },
];
function idleMaxHP(lv) { return Math.floor(30 * Math.pow(1.45, lv - 1)); }
function idleDmgMult() { return Math.pow(1.25, idle.up.dmg); }
function idleGoldMult() {
  let m = Math.pow(1.2, idle.up.gold);
  for (const it of IDLE_ITEMS) if (it.goldBonus && idle.owned[it.id]) m *= it.goldBonus;
  return m;
}
function idleCritChance() { return Math.min(0.45, idle.up.crit * 0.03); }
function upgradeCost(u) { return Math.floor(u.base * Math.pow(u.growth, idle.up[u.id])); }

const SUFF = ['', 'K', 'M', 'B', 'T', 'q', 'Q', 's', 'S', 'o', 'N', 'd'];
function fmt(n) {
  if (!isFinite(n)) return '∞';
  if (n < 1000) return String(n < 100 ? Math.round(n * 10) / 10 : Math.round(n));
  let i = 0;
  while (n >= 1000 && i < SUFF.length - 1) { n /= 1000; i++; }
  if (n >= 1000) return n.toExponential(2);
  return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + SUFF[i];
}

// bright coin "cha-ching" — richer with the Coin Shower upgrade
function playCoin(rich) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const freqs = rich ? [1319, 1760, 2217] : [1319, 1760];
  freqs.forEach((f, i) => {
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.012);
    const g = audioCtx.createGain();
    const t0 = t + i * 0.045;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(rich ? 0.2 : 0.14, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t0); o.stop(t0 + 0.25);
  });
}

function idleSave() {
  try {
    localStorage.setItem(IDLE_KEY, JSON.stringify({
      gold: idle.gold, level: idle.level, hp: idle.hp, up: idle.up,
      owned: idle.owned, equip: idle.equip, totalKills: idle.totalKills,
    }));
  } catch { /* private mode etc. */ }
}
function idleLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(IDLE_KEY) || 'null');
    if (!d) return;
    Object.assign(idle.up, d.up || {});
    idle.gold = d.gold || 0;
    idle.level = d.level || 1;
    idle.owned = d.owned || {};
    idle.equip = d.equip || 'classic';
    idle.totalKills = d.totalKills || 0;
    idle.maxHP = idleMaxHP(idle.level);
    idle.hp = Math.min(d.hp || idle.maxHP, idle.maxHP) || idle.maxHP;
  } catch { /* corrupt save — start fresh */ }
}
idleLoad();

// Dummy look levels up with you: named skins first, then endless hue tiers.
const IDLE_TIER_SKINS = ['oak', 'iron', 'gold'];
function applyIdleTier() {
  const tier = Math.floor((idle.level - 1) / 5);
  if (tier < IDLE_TIER_SKINS.length) {
    applySkin(IDLE_TIER_SKINS[tier]);
  } else {
    applySkin('gold'); // metallic base, then re-tint
    const c = new THREE.Color().setHSL(((tier * 47) % 360) / 360, 0.68, 0.5);
    woodMat.color.copy(c);
    woodMat.emissive.copy(c).multiplyScalar(0.18);
    woodDark.color.copy(c).multiplyScalar(0.55);
    ringBaseColor = c.getHex();
    ring.material.color.setHex(ringBaseColor);
  }
}

function updateIdleHUD() {
  scoreN.textContent = fmt(idle.gold);
  if (enemyHpEl) enemyHpEl.style.width = Math.max(0, (idle.hp / idle.maxHP) * 100) + '%';
  const lbl = $('enemyHpLbl');
  if (lbl) lbl.textContent = 'DUMMY · LEVEL ' + idle.level;
  const sub = $('idleSub');
  if (sub) sub.innerHTML = 'level <b style="color:var(--gold)">' + idle.level + '</b> · ~' + fmt((4 + 7.2) * idleDmgMult() * 0.5 * idleGoldMult()) + ' 🪙/hit · ' + idle.totalKills + ' felled';
  const sg = $('shopGold');
  if (sg) sg.textContent = fmt(idle.gold);
}

function idleDealDamage(dmg, worldPoint, crit) {
  const g = dmg * 0.5 * idleGoldMult();
  idle.gold += g;
  idle.hp -= dmg;
  // rate-limit the coin sound so fast flurries don't stack into noise
  const now = performance.now();
  if (now - idle.coinT > 70) { idle.coinT = now; playCoin(!!idle.owned.coins); }
  spawnDamageNumber(worldPoint, '+' + fmt(g) + ' 🪙', crit ? 'crit' : 'gold');
  if (idle.hp <= 0) idleKill();
  updateIdleHUD();
  if (shopPanelEl && shopPanelEl.classList.contains('open')) refreshShopAfford();
}
function idleOnHit(power, worldPoint) {
  const crit = Math.random() < idleCritChance();
  const dmg = (4 + power * 0.12) * idleDmgMult() * (crit ? 5 : 1);
  if (crit) announce('CRIT!', '#ff4d6d');
  idleDealDamage(dmg, worldPoint, crit);
}
function idleKill() {
  const bonus = idle.maxHP * 0.6 * idleGoldMult();
  idle.gold += bonus;
  idle.totalKills++;
  idle.level++;
  idle.maxHP = idleMaxHP(idle.level);
  idle.hp = idle.maxHP;
  announce('LEVEL ' + idle.level + '!', '#ffd166');
  spawnDamageNumber(new THREE.Vector3(0, 1.65, 0.2), '+' + fmt(bonus) + ' 🪙 BONUS', 'crit');
  burst(new THREE.Vector3(0, 1.2, 0.2), new THREE.Vector3(0, 1, 0.3).normalize(), 95, 0xffd166, 5);
  playCoin(true);
  playChime(880, 0.3);
  dummy.velX += 1.8; dummy.hitPulse = 1;
  applyIdleTier();
  renderShop();
  idleSave();
}
function idleTick(dt) {
  if (idle.up.squire > 0) {
    idle.squireT += dt;
    if (idle.squireT >= 2.0) {
      idle.squireT = 0;
      const p = new THREE.Vector3((Math.random() - 0.5) * 0.3, 1.0 + Math.random() * 0.5, 0.26);
      burst(p, new THREE.Vector3(0, 0.5, 1).normalize(), 40, 0xcfd8ff, 2.4);
      dummy.velX += 0.35; dummy.hitPulse = Math.max(dummy.hitPulse, 0.5);
      idleDealDamage((4 + 6) * idleDmgMult() * 0.5 * idle.up.squire, p, false);
    }
  }
  idle.saveT += dt;
  if (idle.saveT > 5) { idle.saveT = 0; idleSave(); }
}

// --- Shop UI ---------------------------------------------------------------
const shopPanelEl = $('shopPanel');
function renderShop() {
  const list = $('shopList');
  if (!list) return;
  list.innerHTML = '';
  for (const u of IDLE_UPGRADES) {
    const cost = upgradeCost(u);
    const maxed = u.max && idle.up[u.id] >= u.max;
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.innerHTML =
      `<span class="ic">${u.icon}</span>` +
      `<span class="info"><b>${u.name}</b> <em>Lv ${idle.up[u.id]}${u.max ? '/' + u.max : ''}</em><small>${u.desc}</small></span>` +
      `<button class="buy" data-up="${u.id}" data-cost="${cost}">${maxed ? 'MAX' : fmt(cost) + ' 🪙'}</button>`;
    list.appendChild(row);
  }
  for (const it of IDLE_ITEMS) {
    const owned = !!idle.owned[it.id];
    const row = document.createElement('div');
    row.className = 'shop-row';
    const label = owned ? (it.sword ? (idle.equip === it.sword ? '✓ EQUIPPED' : 'EQUIP') : '✓ OWNED') : fmt(it.cost) + ' 🪙';
    row.innerHTML =
      `<span class="ic">${it.icon}</span>` +
      `<span class="info"><b>${it.name}</b><small>${it.desc}</small></span>` +
      `<button class="buy${owned ? ' owned' : ''}" data-item="${it.id}" data-cost="${owned ? 0 : it.cost}">${label}</button>`;
    list.appendChild(row);
  }
  list.querySelectorAll('button[data-up]').forEach((b) => b.addEventListener('click', () => buyUpgrade(b.dataset.up)));
  list.querySelectorAll('button[data-item]').forEach((b) => b.addEventListener('click', () => buyItem(b.dataset.item)));
  refreshShopAfford();
}
function refreshShopAfford() {
  if (!shopPanelEl) return;
  shopPanelEl.querySelectorAll('.buy').forEach((b) => {
    b.classList.toggle('no', !b.classList.contains('owned') && idle.gold < Number(b.dataset.cost || 0));
  });
  const sg = $('shopGold');
  if (sg) sg.textContent = fmt(idle.gold);
}
function buyUpgrade(id) {
  const u = IDLE_UPGRADES.find((x) => x.id === id);
  if (!u || (u.max && idle.up[id] >= u.max)) return;
  const cost = upgradeCost(u);
  if (idle.gold < cost) return;
  idle.gold -= cost;
  idle.up[id]++;
  playCoin(true); playChime(660, 0.2);
  idleSave(); renderShop(); updateIdleHUD();
}
function buyItem(id) {
  const it = IDLE_ITEMS.find((x) => x.id === id);
  if (!it) return;
  if (idle.owned[id]) {
    if (it.sword) { idle.equip = it.sword; selectSword(it.sword); idleSave(); renderShop(); }
    return;
  }
  if (idle.gold < it.cost) return;
  idle.gold -= it.cost;
  idle.owned[id] = true;
  if (it.sword) { idle.equip = it.sword; selectSword(it.sword); }
  playCoin(true); playChime(880, 0.25);
  idleSave(); renderShop(); updateIdleHUD();
}
function toggleShop(open) {
  if (!shopPanelEl) return;
  const willOpen = open !== undefined ? open : !shopPanelEl.classList.contains('open');
  shopPanelEl.classList.toggle('open', willOpen);
  if (willOpen) renderShop();
}

// ---------------------------------------------------------------------------
// Hitbox debug overlay (toggle in Settings) — see the real collision volumes
// ---------------------------------------------------------------------------
let debugHit = false;
const debugGroup = new THREE.Group();
debugGroup.visible = false;
scene.add(debugGroup);
const dbgMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.8 });
const dbgMatE = new THREE.MeshBasicMaterial({ color: 0xff3366, wireframe: true, transparent: true, opacity: 0.9 });
const dbgBlade = new THREE.Mesh(new THREE.CylinderGeometry(CFG.bladeRadius, CFG.bladeRadius, 1, 8), new THREE.MeshBasicMaterial({ color: 0x66ccff, wireframe: true }));
debugGroup.add(dbgBlade);
const dbgEnemyBlade = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), dbgMatE);
debugGroup.add(dbgEnemyBlade);
const dbgParts = [];
for (const p of parts) {
  const len = p.a.distanceTo(p.b);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(p.radius, len, 4, 10), dbgMat);
  debugGroup.add(m); dbgParts.push({ m, p });
}
function segToMesh(mesh, a, b) {
  const v = b.clone().sub(a);
  const len = Math.max(0.001, v.length());
  mesh.position.copy(a).addScaledVector(v, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, v.normalize());
  mesh.scale.set(1, len, 1);
}
function updateDebug() {
  debugGroup.visible = debugHit;
  if (!debugHit) return;
  segToMesh(dbgBlade, curBase, curTip);
  for (const d of dbgParts) {
    const a = d.p.a.clone().applyMatrix4(d.p.mesh.matrixWorld);
    const b = d.p.b.clone().applyMatrix4(d.p.mesh.matrixWorld);
    d.m.position.copy(a).add(b).multiplyScalar(0.5);
    d.m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  }
  dbgEnemyBlade.visible = game.mode === 'duel';
  if (game.mode === 'duel') segToMesh(dbgEnemyBlade, enemy.base, enemy.tip);
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
const bladeVel = new THREE.Vector3();

function updateSwordOrientation(dt) {
  if (input.mode === 'mouse') {
    input.mYaw += (input.mYawT - input.mYaw) * 0.25;
    input.mPitch += (input.mPitchT - input.mPitch) * 0.25;
    _mq.setFromEuler(new THREE.Euler(input.mPitch - 0.42, input.mYaw, 0, 'YXZ'));
    sword.quaternion.copy(_mq);
  } else {
    _rel.copy(input.refInv).multiply(input.rawQ);
    sword.quaternion.copy(_rel).multiply(mountQ);
  }
  sword.position.copy(handAnchor);

  // stab lunge — thrust the blade toward the dummy (-z) and back
  if (stab.active) {
    stab.t += dt;
    if (stab.t >= stab.dur) stab.active = false;
    else {
      const lunge = Math.sin((stab.t / stab.dur) * Math.PI) * 0.5;
      sword.position.z -= lunge;
      sword.position.y += lunge * 0.04;
    }
  }
}

function updateDummy(dt) {
  const ax = -CFG.springK * dummy.leanX - CFG.springC * dummy.velX;
  const az = -CFG.springK * dummy.leanZ - CFG.springC * dummy.velZ;
  const at = -CFG.springK * 0.6 * dummy.twist - CFG.springC * dummy.velT;
  dummy.velX += ax * dt; dummy.velZ += az * dt; dummy.velT += at * dt;
  dummy.leanX += dummy.velX * dt; dummy.leanZ += dummy.velZ * dt; dummy.twist += dummy.velT * dt;
  dummy.leanX = THREE.MathUtils.clamp(dummy.leanX, -CFG.maxLean, CFG.maxLean);
  dummy.leanZ = THREE.MathUtils.clamp(dummy.leanZ, -CFG.maxLean, CFG.maxLean);
  body.rotation.set(dummy.leanX, dummy.twist, dummy.leanZ, 'YXZ');
  dummy.hitPulse = Math.max(0, dummy.hitPulse - dt * 3);
  ring.material.opacity = 0.4 + dummy.hitPulse * 0.5;
  ring.scale.setScalar(1 + dummy.hitPulse * 0.12);
}

let animTime = 0;
function updateRush(dt) {
  if (game.mode !== 'rush') return;
  if (!rush.active) return;
  // keep marker glued to the moving weak-point, facing the camera
  targetWorldPos(rush.cap, rush.worldPos);
  targetMarker.position.copy(rush.worldPos);
  targetMarker.lookAt(camera.position);
  const pulse = 1 + Math.sin(animTime * 9) * 0.12 + rush.pulse * 0.6;
  targetMarker.scale.setScalar(pulse);
  rush.pulse = Math.max(0, rush.pulse - dt * 4);
  // countdown ring shrinks; colour warms as time runs out
  rush.time -= dt;
  const frac = Math.max(0, rush.time / rush.maxTime);
  targetMarker.userData.timer.scale.setScalar(0.5 + frac * 0.9);
  targetMarker.userData.timerMat.opacity = 0.3 + frac * 0.5;
  if (rush.time <= 0) {
    // missed in time — break the chain
    if (game.combo > 1) announce('CHAIN LOST', '#8b93b8');
    game.combo = 0;
    updateComboUI();
    playChime(180, 0.18);
    spawnRushTarget();
  }
}

const _worldCaps = [];
const _iBase = new THREE.Vector3();
const _iTip = new THREE.Vector3();
const _hitPt = new THREE.Vector3();

function checkHits() {
  if (!haveTip) return;
  const speed = bladeVel.length();
  speedN.textContent = speed.toFixed(1);
  powerFill.style.width = Math.min(100, speed * 8) + '%';
  setWhoosh(speed);
  detectSwing(speed);
  const intensity = THREE.MathUtils.clamp((speed - 1.5) / 8, 0, 1);
  trail.push(curTrailInner, curTip, intensity);

  if (speed < CFG.hitSpeedMin) return;
  if (game.mode === 'drones') return; // drones are the only targets in that mode

  const power = Math.min(100, speed * 8.5);
  const dir = bladeVel.clone().normalize();
  const now = performance.now();
  body.updateMatrixWorld(true);

  _worldCaps.length = 0;
  for (const p of parts) {
    _worldCaps.push({ a: p.a.clone().applyMatrix4(p.mesh.matrixWorld), b: p.b.clone().applyMatrix4(p.mesh.matrixWorld), radius: p.radius, meta: p });
  }
  for (const c of bodyCapsules) {
    _worldCaps.push({ a: c.a.clone().applyMatrix4(body.matrixWorld), b: c.b.clone().applyMatrix4(body.matrixWorld), radius: c.radius, meta: c });
  }

  const tipTravel = curTip.distanceTo(prevTip);
  const steps = THREE.MathUtils.clamp(Math.ceil(tipTravel / 0.05), 1, 16);
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    _iBase.copy(prevBase).lerp(curBase, f);
    _iTip.copy(prevTip).lerp(curTip, f);
    for (const cap of _worldCaps) {
      const d = segSegClosest(_iBase, _iTip, cap.a, cap.b, _c1, _c2);
      if (d - cap.radius < CFG.bladeRadius && now - cap.meta.cd >= CFG.hitCooldownMs) {
        cap.meta.cd = now;
        _hitPt.copy(_c2).lerp(_c1, 0.5);
        registerHit(cap.meta, power, _hitPt.clone(), dir, cap.meta.name === 'head');
      }
    }
  }
}

const _camOff = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const camBase = CFG.camPos.clone();
const camLookAt = CFG.camLook.clone();
let zoomLevel = 1; // <1 zoomed in (closer), >1 zoomed out
const ZOOM_MIN = 0.5, ZOOM_MAX = 1.9;
function setZoom(z) { zoomLevel = THREE.MathUtils.clamp(z, ZOOM_MIN, ZOOM_MAX); }
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  animTime += dt;

  updateSwordOrientation(dt);

  curBase.copy(BLADE_BASE_LOCAL).applyQuaternion(sword.quaternion).add(sword.position);
  curTip.copy(BLADE_TIP_LOCAL).applyQuaternion(sword.quaternion).add(sword.position);
  curTrailInner.copy(BLADE_TRAIL_LOCAL).applyQuaternion(sword.quaternion).add(sword.position);
  if (haveTip && dt > 0) bladeVel.copy(curTip).sub(prevTip).multiplyScalar(1 / dt);
  else bladeVel.set(0, 0, 0);

  if (game.running) checkHits();
  prevTip.copy(curTip);
  prevBase.copy(curBase);
  haveTip = true;

  // combo expiry
  if (game.combo > 0 && performance.now() - game.lastHitTime > CFG.comboWindowMs) {
    if (game.mode !== 'rush') { game.combo = 0; updateComboUI(); }
  }

  updateDummy(dt);
  updateRush(dt);
  if (game.mode === 'duel') updateDuel(dt);
  if (game.mode === 'drones') updateDrones(dt);
  if (game.mode === 'idle' && game.running) idleTick(dt);
  updateSparks(dt);

  // fire blade continuously sheds embers along its length
  if (swordEffect === 'fire' && game.running) {
    emitEmber(curTrailInner);
    if (Math.random() < 0.6) emitEmber(curBase.clone().lerp(curTip, 0.45));
    fxLight.intensity = 2.4 + Math.sin(animTime * 22) * 0.7;
  }
  updateEmbers(dt);
  updateIceShards(dt);
  updateComboFx(dt);
  updateDebug();
  impactLight.intensity *= 0.86;

  // brazier flicker
  const fl = 0.85 + Math.sin(animTime * 13) * 0.1 + Math.sin(animTime * 7.3) * 0.06;
  braziers[0].intensity = 12 * fl; braziers[1].intensity = 12 * (1.7 - fl);

  // camera shake decay
  shake *= 0.86;
  _camOff.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5) * 0.4).multiplyScalar(shake);
  _camDir.copy(camBase).sub(camLookAt).multiplyScalar(zoomLevel);
  camera.position.copy(camLookAt).add(_camDir).add(_camOff);
  camera.lookAt(camLookAt);

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
  if (connected && !game.running) startBtn.textContent = 'Enter Arena ▶';
}

function setupNetworked() {
  roomCode = makeRoomCode();
  roomCodeEl.textContent = roomCode;
  const url = new URL('controller.html?room=' + roomCode, location.href).href;
  joinUrlEl.textContent = new URL('controller.html', location.href).href.replace(/^https?:\/\//, '');
  if (window.QRCode && $('qr')) {
    try {
      $('qr').innerHTML = '';
      new window.QRCode($('qr'), { text: url, width: 132, height: 132, colorDark: '#0a0d17', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
    } catch { qrBox.style.display = 'none'; }
  } else if (qrBox) qrBox.style.display = 'none';

  net = new Net({
    role: 'game', room: roomCode,
    onStatus: () => {},
    onMessage: (msg) => {
      if (msg.t === 'imu') applyIMU(msg);
      else if (msg.t === 'calibrate') calibrate();
      else if (msg.t === 'stab') triggerStab();
      else if (msg.t === 'presence' && msg.role === 'controller') setPair(msg.count > 0);
    },
  });
}

// ---------------------------------------------------------------------------
// Mode + skin selection (start overlay)
// ---------------------------------------------------------------------------
const MODE_TITLE = { duel: 'DUEL', rush: 'TARGET RUSH', drones: 'DRONE SLAYER', idle: 'GOLD RUSH', free: 'SWING TO STRIKE' };
function selectMode(m) {
  game.mode = m;
  document.querySelectorAll('.mode-opt').forEach((el) => el.classList.toggle('sel', el.dataset.mode === m));
  bannerTitle.textContent = MODE_TITLE[m] || 'SWING TO STRIKE';
}
function selectSkin(id) {
  applySkin(id);
  document.querySelectorAll('.skin-opt').forEach((el) => el.classList.toggle('sel', el.dataset.skin === id));
}
function selectSword(id) {
  setSwordSkin(id);
  document.querySelectorAll('.sword-opt').forEach((el) => el.classList.toggle('sel', el.dataset.sword === id));
}
document.querySelectorAll('.mode-opt').forEach((el) => el.addEventListener('click', () => selectMode(el.dataset.mode)));
document.querySelectorAll('.skin-opt').forEach((el) => el.addEventListener('click', () => selectSkin(el.dataset.skin)));
document.querySelectorAll('.sword-opt').forEach((el) => el.addEventListener('click', () => selectSword(el.dataset.sword)));
const MODE_IDS = ['free', 'rush', 'duel', 'drones', 'idle'];
const wantMode = params.get('game');
selectMode(MODE_IDS.includes(wantMode) ? wantMode : 'free');
selectSkin('oak');
selectSword('classic');

// --- Settings / combo-list modal + debug toggle ----------------------------
const settingsModal = $('settings');
const comboListEl = $('comboList');
function populateCombos() {
  if (!comboListEl) return;
  comboListEl.innerHTML = '';
  for (const c of COMBOS) {
    const row = document.createElement('div');
    row.className = 'combo-row';
    row.innerHTML = `<span class="dot-c" style="background:${c.color}"></span><span class="nm">${c.name}</span><span class="keys">${c.keys}</span>`;
    comboListEl.appendChild(row);
  }
}
populateCombos();
function openSettings() { if (settingsModal) settingsModal.classList.add('show'); }
function closeSettings() { if (settingsModal) settingsModal.classList.remove('show'); }
const gearBtn = $('gearBtn'), recalBtn = $('recalBtn'), combosBtn = $('combosBtn'), settingsClose = $('settingsClose'), dbgToggle = $('dbgToggle');
if (gearBtn) gearBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); openSettings(); });
if (combosBtn) combosBtn.addEventListener('click', openSettings);
if (settingsClose) settingsClose.addEventListener('click', closeSettings);
if (settingsModal) settingsModal.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === settingsModal) closeSettings(); });
if (recalBtn) recalBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); calibrate(); });
if (dbgToggle) dbgToggle.addEventListener('change', () => { debugHit = dbgToggle.checked; });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function enterArena() {
  overlay.classList.add('hidden');
  hud.style.display = 'block';
  game.running = true;
  initAudio();
  ensureWhoosh();
  scoreN.textContent = '0';

  const isDuel = game.mode === 'duel';
  const isDrones = game.mode === 'drones';
  const isIdle = game.mode === 'idle';
  // HUD panels
  if (duelHud) duelHud.style.display = (isDuel || isDrones || isIdle) ? 'block' : 'none';
  if (duelHud) duelHud.classList.toggle('drones', isDrones); // hides enemy bar / block prompt via CSS
  if (duelHud) duelHud.classList.toggle('idle', isIdle);     // hides player bar / block prompt via CSS
  targetCard.style.display = (isDuel || isDrones || isIdle) ? 'none' : 'block';
  const scoreLbl = $('scoreLbl');
  if (scoreLbl) scoreLbl.textContent = isIdle ? 'GOLD 🪙' : 'SCORE';
  const subEl = $('subline'), idleSubEl = $('idleSub');
  if (subEl) subEl.style.display = isIdle ? 'none' : 'block';
  if (idleSubEl) idleSubEl.style.display = isIdle ? 'block' : 'none';
  const shopBtn = $('shopBtn');
  if (shopBtn) shopBtn.style.display = isIdle ? 'block' : 'none';
  if (!isIdle) toggleShop(false);
  const enemyLbl = $('enemyHpLbl');
  if (enemyLbl && isDuel) enemyLbl.textContent = 'DUMMY';
  // camera framing (duel is closer)
  if (isDuel) { camBase.set(0, 1.58, 1.5); camLookAt.set(0, 1.25, 0); }
  else { camBase.copy(CFG.camPos); camLookAt.copy(CFG.camLook); }
  // dummy + arm rig visibility
  dummyRoot.visible = !isDrones;              // no dummy in drone mode
  enemyArmStatic.visible = !isDuel;
  enemyArmRig.visible = isDuel;
  enemyHandMesh.visible = isDuel;
  enemySword.visible = isDuel;

  const droneRow = $('droneRow');
  if (droneRow) droneRow.style.display = isDrones ? 'block' : 'none';
  const recal = $('recalBtn');
  if (recal) recal.style.display = LOCAL_MODE ? 'block' : 'none';

  updateTargetCard();
  setHint(defaultHint());
  bannerTitle.textContent = MODE_TITLE[game.mode] || 'SWING TO STRIKE';
  if (game.mode === 'rush') spawnRushTarget(); else clearRushTarget();
  if (isDuel) startDuel();
  if (isDrones) startDrones();
  if (isIdle) {
    idle.maxHP = idleMaxHP(idle.level);
    if (idle.hp <= 0 || idle.hp > idle.maxHP) idle.hp = idle.maxHP;
    applyIdleTier();
    if (idle.equip !== 'classic') selectSword(idle.equip);
    updateIdleHUD();
    renderShop();
    updateDuelHUD(); // keeps duel bars sane if switching later
  }
}

// A tap is a stab attack — unless a round is over, when it restarts.
function onTap() {
  if (!game.running) return;
  if (game.mode === 'duel' && game.duelOver) { startDuel(); return; }
  if (game.mode === 'drones' && game.dronesOver) { startDrones(); return; }
  triggerStab();
}
window.addEventListener('pointerdown', (e) => {
  if (e.target && e.target.closest && e.target.closest('.hud-btn, #shopPanel, .modal')) return; // ignore UI
  onTap();
});
const shopBtnEl = $('shopBtn');
if (shopBtnEl) shopBtnEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); toggleShop(); });
const shopCloseEl = $('shopClose');
if (shopCloseEl) shopCloseEl.addEventListener('click', () => toggleShop(false));

// --- Zoom: two-finger pinch (mobile) + mouse wheel (desktop) ----------------
window.addEventListener('wheel', (e) => { setZoom(zoomLevel * (e.deltaY > 0 ? 1.08 : 0.925)); }, { passive: true });
let pinchDist = 0;
window.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (pinchDist) setZoom(zoomLevel * (pinchDist / d)); // spread fingers -> zoom in
    pinchDist = d;
  }
}, { passive: true });
window.addEventListener('touchend', () => { pinchDist = 0; });

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
  setHint('Move mouse to aim · move fast to strike · click to thrust');
});

// "Use THIS phone as the sword" — reload into the already-working solo IMU mode
// (reads this device's own motion sensors, no relay server). Preserves any
// chosen mode (duel / drones / …) across the reload.
const soloBtn = $('soloBtn');
if (soloBtn) soloBtn.addEventListener('click', () => {
  const p = new URLSearchParams(location.search);
  p.set('mode', 'local');
  if (game.mode && game.mode !== 'free') p.set('game', game.mode);
  location.search = p.toString();
});

if (LOCAL_MODE) {
  qrBox.style.display = 'none';
  roomCodeEl.textContent = 'SOLO';
  joinUrlEl.textContent = 'this device';
  pairStatus.textContent = 'solo mode — this phone is the sword';
  pairDot.className = 'dot on';
  startBtn.textContent = 'Start & Enable Motion';
  const pairBlock = $('pairBlock');
  if (pairBlock) pairBlock.style.display = 'none';
  localHint.textContent = 'Tap the screen any time to re-calibrate your neutral stance.';
} else {
  setupNetworked();
}

window.iSword = {
  sword, dummy, game, input, calibrate, selectMode, selectSkin, selectSword, setSwordSkin,
  spawnRushTarget, enemy, startDuel, triggerStab, triggerCombo, recordSwing, COMBOS,
  drones, spawnDrone, killDrone, startDrones, enemyArmRig, enemyHandMesh,
  idle, idleOnHit, idleKill, buyUpgrade, buyItem, renderShop, toggleShop, idleSave, fmt,
  setDebug: (v) => { debugHit = v; debugGroup.visible = v; },
};
