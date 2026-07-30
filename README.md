# MedWand POC

A small proof-of-concept that runs a **React** frontend inside an **Android
WebView shell** and drives a **MedWand** USB medical device (thermometer, pulse
oximeter, ECG, stethoscope, and the otoscope/dermatoscope camera) through a
native bridge.

- The **web app** owns the UI and clinical flow.
- The **native shell** owns the hardware (the MedWand BETA SDK).
- They talk over the modern **WebMessageListener** channel (see
  [The bridge channel](#the-bridge-channel) below).

The frontend can select a sensor, start a reading, and display results:

| Sensor | What it shows |
|---|---|
| Thermometer | Live object temperature (°F) |
| Pulse Oximeter | Live SpO₂ and pulse rate |
| ECG | Live plot of the dimensionless `ecgData` waveform while monitoring; the captured strip **image** after recording |
| Stethoscope | No live readings (audio plays on the device); the recorded **WAV clip** after recording |
| Camera | Live otoscope/dermatoscope **video** preview streamed from the device's USB camera, with focus/LED/otoscope controls; a captured still **image** on demand |

## Layout

```
medwand-poc/
├── frontend/                 React + Vite + TypeScript web app
│   └── src/
│       ├── bridge/           protocol types + transport client
│       │   └── emulator/     browser stand-in for the device (dev only)
│       ├── hooks/            useMedWand — bridge state as React state
│       └── components/       one panel per sensor, plus the emulator's dev panel
└── android/                  WebView shell (plain Activity, no Compose)
    └── app/src/main/java/com/medwand/poc/
        ├── web/              WebView + asset loader
        ├── bridge/           WebMessageListener transport + JSON protocol
        └── device/           MedWandDevice — owns the SDK controller & hardware
```

## Architecture

Three layers, each ignorant of the one two steps away:

```
 React UI  ──window.MedWand──►  MedWandBridge  ──►  MedWandDevice  ──►  MedWand SDK
 (frontend)  postMessage/onmessage   (bridge/)          (device/)          (AAR)
           ◄─────────────────────  replies · events · captures  ◄──────────────
```

- **`device/MedWandDevice`** is the hardware layer. It owns the SDK
  `MedWandController` lifecycle (USB permission → connect → initialize), starts
  and stops sensors, drives recording, forwards captured artifacts, and emits
  everything through a plain `Listener`. It knows nothing about JSON or WebViews.
  Its SDK call sequences mirror the (tested) MedWand Developer Suite sample
  exactly.
- **`bridge/MedWandBridge`** is the transport. It registers
  `window.MedWand` as a `WebMessageListener` scoped to the app's first-party
  origin, translates inbound JSON commands into device calls, and pushes replies,
  events, and captures back to the web app. It contains no hardware logic.
- **`web/WebViewFactory`** serves the bundled web build over a real https origin
  (`WebViewAssetLoader`) so the bridge can be origin-scoped.

### The bridge channel

- **Commands** (web → native) are JSON strings carrying a caller `id`:
  `{ "id": "c7", "cmd": "startSensor", "args": { "sensor": "ecg" } }`.
- **Replies** echo the `id`; **events** (`state`, `reading`, `capture`, `error`)
  carry none. Replies are matched to commands by `id`.

> Captures could be shipped as length-delimited **binary** frames to avoid
> base64 inflation, but the BETA SDK already hands them back as base64 `data:`
> URIs (`ecgBmpFromCapture` / `wavFromFrames`), so decoding them to raw bytes just
> to re-frame — and then re-wrapping them in a `Blob` on the web side — is pure
> round-trip overhead. Instead a **`capture` event** carries the `data:` URI
> straight through, and the frontend uses it directly as an `<img>`/`<audio>`
> source. (Live camera **frames** are the exception — see below.)

### ECG and stethoscope specifics

- **ECG** — during monitoring the SDK's `MedWandReading.ecgData` (a
  whitespace-separated string of dimensionless values) is forwarded unchanged as
  `reading` events; the frontend parses and plots it live. Recording produces a
  strip PNG (`ecgBmpFromCapture` returns a `data:image/png;base64,…` URI), sent
  as a `capture` event; the frontend shows it as an image.
- **Stethoscope** — live audio plays natively on the device speaker and never
  crosses the bridge. Recording produces a WAV clip (`wavFromFrames` returns a
  `data:audio/wav;base64,…` URI), sent as a `capture` event; the frontend shows
  an `<audio>` player.

### Camera specifics

The otoscope/dermatoscope is a **USB Video (UVC) camera**, separate from the
serial sensor channel. It needs SDK **BETA 0.0.0.3+** and pulls in the
`com.herohan:UVCAndroid` backend the SDK's `UvcCameraPreviewTarget` delegates to;
the shell requests the runtime **`CAMERA`** permission before starting a preview.

- **Starting a preview** — unlike the other sensors, the camera does not start
  through `startSensor`/`startX()`; the device layer calls
  `MedWandController.setCameraMode(previewTarget, mode)` with a mode of
  `Dermatoscope` or `Otoscope`. A `SizedUvcCameraPreviewTarget` (mirrored from the
  Developer Suite sample) wraps the SDK's UVC target so the actual frame
  dimensions are known. Over the bridge this is still just
  `startSensor { sensor: "camera", mode }`.
- **Live frames** — `setCameraFrameHandler` delivers processed **ARGB** frames
  (no dimensions) on a camera thread. `CameraFramePipeline` JPEG-encodes each
  frame off that thread on a single dedicated executor with a **drop-on-busy
  guard** (no framerate throttle) so a slow encode never stalls the camera or
  backs up. Each encoded frame ships over the WebView **array-buffer** channel as
  raw JPEG **bytes** (`JavaScriptReplyProxy.postMessage(byte[])`) — no base64, no
  JSON envelope. The frontend wraps the bytes in a `blob:` object URL and wires it
  straight into an `<img>` (bypassing React state, since frames arrive many times
  a second).

  > **Transport — binary frames, with a base64 fallback.** The binary array-buffer
  > path is used whenever the WebView supports it
  > (`WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER`): raw JPEG bytes, no envelope, so
  > none of the ~33% base64 inflation and no per-frame JSON hop. The camera mode
  > isn't sent per frame — it rides in the `state` snapshot — so the bytes need no
  > wrapper. Older WebViews that lack array-buffer support fall back to a base64
  > `data:image/jpeg;base64,…` URI delivered as a **`frame` event** (plus
  > `width`/`height`); the frontend feeds either form into the same `<img>`. This
  > is the one place the bridge uses a binary transport rather than the JSON string
  > channel — deliberately, since frame throughput benefits most from it.
- **Capturing a still** — `captureFrame` calls `camera.recordFrame()`; the SDK
  returns the recorded frame, converted to a `data:image/png;base64,…` URI via
  `cameraBmpFromCapture` (same shape as the ECG strip) and delivered as a
  `capture` event.
- **Controls** — the panel drives the SDK controls the sample exposes: ring-LED
  intensity (`cameraLed`), auto/manual focus and focus position
  (`cameraFocusMode`/`cameraFocusValue`), and the otoscope tip mask —
  pan/zoom/circle-size (`cameraMove`/`cameraZoom`/`cameraRadius`) and `cameraReset`.
  Their availability and current values ride in the `state` snapshot's
  `activeSensor` — a tagged object (`{ sensor: "camera", … }` while a preview
  runs) — so the UI enables/positions them exactly like the reference app.

## Build & run

### 1. Frontend

```bash
cd frontend
npm install
npm run build      # type-checks and bundles into ../android/app/src/main/assets/
```

Run it standalone in a browser with the **device emulator** (no hardware needed),
great for iterating on the UI:

```bash
npm run dev        # http://localhost:5173
```

`src/main.tsx` installs `src/bridge/emulator` **only in development, and only when
the real native bridge is absent**, so it is a no-op inside the Android shell and
absent from production builds. The emulator speaks the identical wire protocol
(same envelope, `{ sensor, reading }` readings, base64 `data:` URI captures, and
both camera frame transports), so the app's bridge code path is the same in the
browser and the shell.

It models the device as a state machine driven by **physical** inputs rather than a
script: the cable, what the thermometer is aimed at, and the finger on the pulse
oximeter. A floating dev panel (**Ctrl/Cmd+Shift+9**) drives those inputs and reads
back what is on the wire. The connect choreography (including the license error and
the Android USB permission dialog) and the thermometer and pulse oximeter behavior
come from real device traces; the ECG, stethoscope, and camera are synthetic, and
say so where they are implemented.

### 2. Android shell

Prerequisites: Android Studio (JDK 21 bundled), and MedWand SDK credentials.

```bash
cd android
cp local.properties.template local.properties
# then set sdk.dir, MW_SDK_LICENSE, and MW_SDK_PUBLIC_KEY (from your MedWand rep)

./gradlew installDebug     # build the frontend first (step 1)
```

Plug in the MedWand over USB, launch the app, tap **Connect**, then pick a sensor.

> **Note:** the MedWand SDK here is a BETA build for development only — not for
> production or clinical use. A valid license is required to connect; the app
> builds without one but cannot talk to the device.
