# 🗡️ iSword

**Swing your phone like a real sword.** iSword turns a phone into a motion
controller for a 3D sword-fighting game rendered on a big screen. This is the
**single-player training build**: you control a sword with your phone's motion
sensors and fight a reactive training dummy with real, physically-modelled
impacts.

## How it works

The phone's **gyroscope + accelerometer** (the IMU) are read in the browser via
the `DeviceOrientation` / `DeviceMotion` web APIs and streamed over a
WebSocket to the game screen ~60 times a second. The game screen — a browser on
a TV or laptop — renders the arena with [three.js](https://threejs.org) and maps
your phone's orientation onto the blade. There is **no app to install**: it's
all web, so you can **AirPlay-mirror the browser to an Apple TV** (or cast to any
screen) and play.

```
 phone  ──DeviceOrientation──▶  WebSocket relay (server.js)  ──▶  game screen (three.js)
  IMU / gyro                        pairs by room code               sword + dummy + physics
```

This same client/server split is what will later allow **two phones on one TV**
for head-to-head duels — a second controller just joins the same room.

## Run it

Requires Node 18+.

```bash
npm install
npm start
# → http://localhost:3000
```

Then open the pages:

| Page | Where to open it |
|------|------------------|
| **Game Screen** — `/game.html` | On the TV / laptop. Shows a room code + QR. AirPlay-mirror this browser to your TV. |
| **Phone Controller** — `/controller.html` | On your phone. Scan the QR or type the room code. |
| **Solo (one phone)** — `/game.html?mode=local` | One phone as *both* screen and sword. Mirror it to the TV. Fastest way to try it. |
| **Mouse / keyboard** | On the game screen, click **"Try with mouse"** — no phone needed, great for a quick look. |

### Important: motion sensors need a secure context

Browsers only expose motion sensors over **HTTPS** or on **localhost**. To use a
real phone against a laptop on your Wi-Fi, put the server behind HTTPS — the
quickest way is a tunnel:

```bash
npx localtunnel --port 3000     # or: ngrok http 3000, cloudflared tunnel, etc.
```

Open the HTTPS URL it gives you on both the TV and the phone. On **iPhone**,
the controller will ask for permission to use *Motion & Orientation* — tap
**Allow**.

## Playing

1. Open the **Game Screen**, note the room code / QR.
2. Open the **Controller** on your phone and join.
3. Hold the phone like a sword grip (blade pointing up), tap **Calibrate** to
   set your neutral stance.
4. **Swing.** Aim for the head for a 2× bonus. Chain hits for combos.

## What's physically modelled

- **Continuous (swept) collision** — the blade is tested along its full path
  each frame, so fast swings can't tunnel through the dummy.
- **Tip velocity → impact power** — strike strength comes from the real speed of
  the blade tip in m/s.
- **Torque + lever arm** — a hit's push into the dummy scales with where along
  the body it lands (a high strike topples it more).
- **Damped-spring recovery** — the dummy is a weighted pell that leans away from
  a strike and wobbles back to upright.

## Project layout

```
server.js                 Express + ws: pairs game/controller by room, relays IMU
public/
  index.html              landing / role picker
  game.html   js/game.js  the 3D arena, sword, dummy, physics, effects
  controller.html js/controller.js   phone IMU reader + streamer
  js/net.js               tiny reconnecting-WebSocket helper (shared)
  vendor/                 three.js + qrcode, vendored so it runs offline / on a LAN
```

## Roadmap

- [x] Single-player training vs. a reactive dummy (this build)
- [ ] Two phones → one TV: real-time duels
- [ ] Blocking / parrying, blade-on-blade collision
- [ ] Rounds, health, win conditions

## License

MIT
