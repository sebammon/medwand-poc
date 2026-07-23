/**
 * MedWand Bridge — Browser Mock
 * =============================
 *
 * A drop-in stand-in for the native `window.MedWand` bridge so the web app
 * can be developed and demoed in a plain browser, with no Android shell and no
 * physical device. It speaks the exact wire protocol described in
 * `medwand-bridge.md`, so your bridge/UI code path is identical to production.
 *
 * Usage — include it before your app in development only:
 *
 *   <script src="medwand-mock.js"></script>          // plain page, or
 *   if (import.meta.env.DEV) await import("./medwand-mock.js");   // bundler
 *
 * It installs `window.MedWand` ONLY if the real native bridge is absent, so the
 * same build runs unchanged inside the Android shell (where the mock is a no-op).
 *
 * What it simulates:
 *   - connect / disconnect, getState
 *   - startSensor / stopSensor for all sensors (one active at a time)
 *   - streamed `reading` events: thermometer, pulse oximeter, ECG (live ecgData)
 *   - startRecording / stopRecording → a `capture` event (ECG PNG, stethoscope WAV)
 *   - camera: live otoscope/dermatoscope `frame` events, `captureFrame` still,
 *     and the focus/LED/otoscope controls
 *   - typed error replies (e.g. SENSOR_BUSY)
 *
 * Detect the mock at runtime via `window.MedWand.__mock === true`.
 */
(function () {
  "use strict";

  // The real WebMessageListener bridge injects window.MedWand. If it's already
  // here we're inside the Android shell — leave it alone.
  if (window.MedWand) return;
  const LATENCY_MS = 40; // simulated native round-trip latency
  const READING_MS = 250; // cadence of streamed readings
  const CAPTURE_MS = 150; // delay before a recorded artifact is delivered
  const state = {
    // The mock represents a device that is always plugged in, so it starts
    // "attached" (present, not yet connected) rather than "detached".
    device: "attached", // detached | attached | connecting | connected
    reading: "idle", // idle | active | recording
    // The running sensor as a tagged object (or null): { sensor, ...settings }.
    activeSensor: null,
    capabilities: { thermometer: false, pulseOximeter: false, ecg: false, stethoscope: false, camera: false },
    deviceInfo: { udi: null, firmwareVersion: null, generation: null, comPort: null, vendorId: null, productId: null },
  };

  // The live camera control object while a preview runs. It IS state.activeSensor
  // during that time (same reference), and null when the camera is off.
  function makeCamera(mode) {
    return {
      sensor: "camera",
      mode: mode,
      monitoring: true,
      ledMax: 100,
      ledIntensity: 0,
      ledAdjustable: true,
      autoFocusAvailable: true,
      manualFocusAvailable: true,
      manualFocusEnabled: false,
      focusValue: 50,
      focusValueMax: 100,
    };
  }
  let camera = null;

  let ticker = null;
  let readingIndex = 0;
  let ecgPhase = 0;
  const ecgHistory = [];

  // Camera preview simulation.
  let cameraTicker = null;
  let cameraFrame = 0;
  const cameraView = { panX: 0, panY: 0, zoom: 0, radius: 0 };
  let onmessageHandler = null;
  const listeners = new Set();

  function deliver(payload) {
    const message = { data: JSON.stringify(payload) };
    setTimeout(() => {
      if (typeof onmessageHandler === "function") onmessageHandler(message);
      listeners.forEach((fn) => fn(message));
    }, LATENCY_MS);
  }

  const replyOk = (id) => deliver({ event: "reply", data: { id, ok: true } });
  const replyError = (id, code, message) => deliver({ event: "reply", data: { id, ok: false, error: { code, message } } });
  const emit = (event, data) => deliver({ event, data });
  const emitState = () => emit("state", clone(state));

  // A MedWandReading, verbatim: every field present, nulls where not applicable.
  function makeReading(sensorType, index, count, fields) {
    return Object.assign(
      {
        sensorType: sensorType,
        timeStamp: new Date().toISOString(),
        status: "",
        index: index,
        count: count,
        tempAmbient: null,
        tempObject: null,
        pulseRate: null,
        spo2: null,
        ecgData: null,
      },
      fields,
    );
  }

  function startReadings(sensor) {
    stopReadings();
    readingIndex = 0;
    ecgHistory.length = 0;
    ticker = setInterval(() => {
      readingIndex += 1;
      if (sensor === "thermometer") {
        const temp = (97.6 + Math.min(readingIndex, 10) * 0.1).toFixed(1);
        const ambient = (70.0 + Math.min(readingIndex, 10) * 0.05).toFixed(1);
        emit("reading", { sensor, reading: makeReading("Thermometer", null, null, { tempObject: temp, tempAmbient: ambient }) });
      } else if (sensor === "pulseOximeter") {
        const fields = { spo2: String(96 + (readingIndex % 3)), pulseRate: String(70 + (readingIndex % 6)) };
        emit("reading", { sensor, reading: makeReading("spo2", null, null, fields) });
      } else if (sensor === "ecg") {
        const samples = [];
        for (let i = 0; i < 12; i++) {
          ecgPhase += 0.28;
          // A dimensionless synthetic beat centered on zero: baseline wander that
          // swings both ways, plus a periodic QRS spike (up) with a small S dip (down).
          const beat = Math.sin(ecgPhase) * 40;
          const phaseInBeat = ecgPhase % (Math.PI * 2);
          const spike = phaseInBeat < 0.3 ? 320 : phaseInBeat < 0.5 ? -120 : 0;
          const value = Math.round(beat + spike);
          samples.push(value);
          ecgHistory.push(value);
        }
        emit("reading", { sensor, reading: makeReading("ecg", readingIndex, 0, { ecgData: samples.join(" ") }) });
      }
      // stethoscope pushes no readings — its audio plays natively.
    }, READING_MS);
  }

  function stopReadings() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  const CAMERA_MS = 90; // ~11 fps, matching the throttled native stream

  function startCamera(mode) {
    stopCamera();
    cameraFrame = 0;
    cameraView.panX = cameraView.panY = cameraView.zoom = cameraView.radius = 0;
    camera = makeCamera(mode);
    state.activeSensor = camera;
    state.reading = "active";
    cameraTicker = setInterval(() => {
      cameraFrame += 1;
      emit("frame", { sensor: "camera", mode: camera.mode, dataUri: cameraFrameDataUri(false), width: 640, height: 480 });
    }, CAMERA_MS);
  }

  function stopCamera() {
    if (cameraTicker) clearInterval(cameraTicker);
    cameraTicker = null;
    camera = null;
  }

  // Draws a synthetic, moving preview so the panel shows live motion. Otoscope
  // mode adds the circular tip mask the SDK applies on the device.
  function cameraFrameDataUri(still) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const t = cameraFrame * 0.12;
      const zoom = 1 + cameraView.zoom * 0.06;

      // A drifting tissue-like backdrop.
      const hue = camera.mode === "otoscope" ? 8 : 335;
      ctx.fillStyle = "hsl(" + hue + ", 45%, " + (18 + camera.ledIntensity * 0.18) + "%)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < 26; i++) {
        const x = ((i * 97 + Math.sin(t + i) * 30) % canvas.width + canvas.width) % canvas.width;
        const y = ((i * 53 + Math.cos(t * 0.8 + i) * 24) % canvas.height + canvas.height) % canvas.height;
        ctx.fillStyle = "hsla(" + (hue + (i % 5) * 6) + ", 60%, " + (45 + (i % 4) * 6) + "%, 0.5)";
        ctx.beginPath();
        ctx.arc(x, y, (14 + (i % 5) * 6) * zoom, 0, Math.PI * 2);
        ctx.fill();
      }

      // Focus blur proxy: a soft vignette that sharpens toward the set value.
      const focus = camera.manualFocusEnabled ? camera.focusValue : 60;
      const blur = Math.max(0, (60 - focus) / 12);
      if (blur > 0) {
        ctx.fillStyle = "rgba(0,0,0," + Math.min(0.35, blur * 0.05) + ")";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      if (camera.mode === "otoscope") {
        const cx = canvas.width / 2 + cameraView.panX * 3;
        const cy = canvas.height / 2 + cameraView.panY * 3;
        const r = (150 + cameraView.radius * 12) * zoom;
        ctx.globalCompositeOperation = "destination-in";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }

      if (still) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "20px system-ui";
        ctx.fillText(camera.mode + " still", 16, 30);
      }
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    }
  }

  function clampInt(value, lo, hi) {
    const n = Math.round(Number(value) || 0);
    return Math.max(lo, Math.min(hi, n));
  }
  function handle(cmd, args, id) {
    switch (cmd) {
      case "getState":
        replyOk(id);
        return emitState();

      case "connect":
        state.device = "connected";
        state.capabilities = { thermometer: true, pulseOximeter: true, ecg: true, stethoscope: true, camera: true };
        state.deviceInfo = {
          udi: "MOCK-UDI-0001",
          firmwareVersion: "3.0.1",
          generation: "Gen2",
          comPort: "mock0",
          vendorId: "1234",
          productId: "60",
        };
        replyOk(id);
        return emitState();

      case "disconnect":
        stopReadings();
        stopCamera();
        state.device = "attached";
        state.reading = "idle";
        state.activeSensor = null;
        state.capabilities = { thermometer: false, pulseOximeter: false, ecg: false, stethoscope: false, camera: false };
        replyOk(id);
        return emitState();

      case "startSensor": {
        if (state.device !== "connected") return replyError(id, "NOT_CONNECTED", "MedWand is not connected.");
        const sensor = args.sensor;
        if (!state.capabilities[sensor]) return replyError(id, "DEVICE_ERROR", "Unknown or unsupported sensor.");
        if (state.activeSensor && state.activeSensor.sensor !== sensor) {
          return replyError(id, "SENSOR_BUSY", state.activeSensor.sensor + " is already active.");
        }
        if (sensor === "stethoscope" && !args.mode) {
          return replyError(id, "DEVICE_ERROR", "Stethoscope requires a mode (heart, lungs, or bowel).");
        }
        if (sensor === "camera") {
          if (args.mode !== "dermatoscope" && args.mode !== "otoscope") {
            return replyError(id, "DEVICE_ERROR", "Camera requires a mode (dermatoscope or otoscope).");
          }
          startCamera(args.mode);
          replyOk(id, {});
          return emitState();
        }
        state.activeSensor = sensor === "stethoscope" ? { sensor: sensor, mode: args.mode } : { sensor: sensor };
        state.reading = "active";
        replyOk(id, {});
        emitState();
        if (sensor !== "stethoscope") startReadings(sensor);
        return;
      }

      case "stopSensor":
        stopReadings();
        stopCamera();
        state.activeSensor = null;
        state.reading = "idle";
        replyOk(id, {});
        return emitState();

      case "captureFrame": {
        if (!camera || !camera.monitoring) {
          return replyError(id, "DEVICE_ERROR", "The camera preview is not running.");
        }
        replyOk(id, {});
        setTimeout(() => emit("capture", { sensor: "camera", mode: camera.mode, dataUri: cameraFrameDataUri(true) }), CAPTURE_MS);
        return;
      }

      case "cameraLed": {
        if (!camera || !camera.monitoring) return replyError(id, "DEVICE_ERROR", "The camera preview is not running.");
        const max = camera.ledMax;
        camera.ledIntensity = camera.ledAdjustable ? clampInt(args.value, 0, max) : args.value > 0 ? max : 0;
        replyOk(id, {});
        return emitState();
      }

      case "cameraFocusMode":
        if (!camera || !camera.monitoring) return replyError(id, "DEVICE_ERROR", "The camera preview is not running.");
        camera.manualFocusEnabled = !!args.manual;
        replyOk(id, {});
        return emitState();

      case "cameraFocusValue":
        if (!camera || !camera.monitoring) return replyError(id, "DEVICE_ERROR", "The camera preview is not running.");
        camera.focusValue = clampInt(args.value, 0, camera.focusValueMax);
        replyOk(id, {});
        return emitState();

      case "cameraMove":
        if (!camera || camera.mode !== "otoscope") return replyError(id, "DEVICE_ERROR", "This control is otoscope-only.");
        cameraView.panX = clampInt(cameraView.panX + (args.horizontal || 0) * 6, -40, 40);
        cameraView.panY = clampInt(cameraView.panY + (args.vertical || 0) * 6, -40, 40);
        return replyOk(id, {});

      case "cameraZoom":
        if (!camera || camera.mode !== "otoscope") return replyError(id, "DEVICE_ERROR", "This control is otoscope-only.");
        cameraView.zoom = clampInt(cameraView.zoom + (args.direction || 0), -8, 8);
        return replyOk(id, {});

      case "cameraRadius":
        if (!camera || camera.mode !== "otoscope") return replyError(id, "DEVICE_ERROR", "This control is otoscope-only.");
        cameraView.radius = clampInt(cameraView.radius + (args.direction || 0), -8, 8);
        return replyOk(id, {});

      case "cameraReset":
        if (!camera || !camera.monitoring) return replyError(id, "DEVICE_ERROR", "The camera preview is not running.");
        cameraView.panX = cameraView.panY = cameraView.zoom = cameraView.radius = 0;
        return replyOk(id, {});

      case "startRecording":
        if (!state.activeSensor) return replyError(id, "DEVICE_ERROR", "No active sensor to record.");
        state.reading = "recording";
        replyOk(id, {});
        return emitState();

      case "stopRecording": {
        const active = state.activeSensor;
        const sensor = active && active.sensor;
        state.reading = sensor ? "active" : "idle";
        replyOk(id, {});
        emitState();
        if (sensor === "ecg") {
          setTimeout(() => emit("capture", { sensor: "ecg", dataUri: ecgCaptureDataUri() }), CAPTURE_MS);
        } else if (sensor === "stethoscope") {
          setTimeout(() => emit("capture", { sensor: "stethoscope", mode: active.mode || "heart", dataUri: wavCaptureDataUri() }), CAPTURE_MS);
        }
        return;
      }

      default:
        return replyError(id, "DEVICE_ERROR", "Unknown command: " + cmd);
    }
  }

  function ecgCaptureDataUri() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 260;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff5f5";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#c0392b";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const shown = ecgHistory.slice(-canvas.width);
      // Autoscale into the canvas so any value range (incl. negatives) fits.
      let min = Infinity;
      let max = -Infinity;
      for (const value of shown) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
      const range = max - min || 1;
      const pad = canvas.height * 0.1;
      shown.forEach((value, i) => {
        const y = canvas.height - pad - ((value - min) / range) * (canvas.height - pad * 2);
        if (i === 0) ctx.moveTo(i, y);
        else ctx.lineTo(i, y);
      });
      ctx.stroke();
      return canvas.toDataURL("image/png");
    } catch (e) {
      // 1x1 transparent PNG fallback (e.g. no DOM).
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    }
  }

  function wavCaptureDataUri() {
    const sampleRate = 8000;
    const total = Math.floor(sampleRate * 3);
    const pcm = new Int16Array(total);
    for (let i = 0; i < total; i++) {
      // A soft "lub-dub" style pulse so the clip is audibly non-trivial.
      const t = i / sampleRate;
      const env = Math.exp(-((t % 0.75) * 6));
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 90 * t) * env * 12000);
    }
    const bytes = wavFromPcm(pcm, sampleRate);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return "data:audio/wav;base64," + btoa(binary);
  }

  function wavFromPcm(pcm, sampleRate) {
    const bytesPerSample = 2;
    const dataSize = pcm.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * bytesPerSample, pcm[i], true);
    return new Uint8Array(buffer);
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  window.MedWand = {
    __mock: true,

    postMessage(str) {
      let msg;
      try {
        msg = JSON.parse(str);
      } catch (e) {
        return;
      }
      handle(msg.cmd, msg.args || {}, msg.id);
    },

    set onmessage(fn) {
      onmessageHandler = fn;
    },
    get onmessage() {
      return onmessageHandler;
    },

    addEventListener(type, fn) {
      if (type === "message") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "message") listeners.delete(fn);
    },
  };

  console.info("[MedWand mock] window.MedWand installed (browser mock — no real device).");
})();
