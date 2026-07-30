/**
 * MedWand bridge: browser emulator (development only)
 * ===================================================
 *
 * A drop-in stand-in for the native `window.MedWand` bridge so the web app can be
 * developed and demoed in a plain browser, with no Android shell and no physical
 * device. It speaks the exact wire protocol (see `../protocol`), so the bridge and
 * UI code path is identical to production.
 *
 * Unlike a scripted mock, the device is modelled as a small state machine driven by
 * *physical* inputs (the cable, the thermometer's target, the finger on the pulse
 * oximeter), which is how the hardware actually behaves. The dev panel
 * (`../../components/EmulatorPanel`) drives those inputs; everything else is
 * derived. The connect and sensor choreography, and the thermometer and pulse
 * oximeter behavior, are taken from real device traces; the ECG, stethoscope, and
 * camera are synthetic, and say so where they are implemented.
 *
 * Install it dev-only from the app entry point, before the app mounts:
 *
 *   if (import.meta.env.DEV) {
 *     const { installMedWandEmulator } = await import("./bridge/emulator");
 *     installMedWandEmulator();
 *   }
 *
 * Guarded by `import.meta.env.DEV`, the dynamic import is dropped from the
 * production bundle. The emulator also installs itself ONLY when no real bridge is
 * present, so it is a no-op inside the Android shell.
 */

import { Camera } from "./camera";
import {
  ATTACH_REPEAT_MS,
  ATTACH_REPEATS,
  CAPABILITIES_OFF,
  CAPABILITIES_ON,
  CAPTURE_MS,
  CONNECT_MS,
  CONTROL_MS,
  DEVICE_INFO_CONNECTED,
  DEVICE_INFO_IDLE,
  LICENSE_ERROR_MS,
  REJECT_MS,
  SENSOR_MS,
  STATE_LEAD_MS,
} from "./constants";
import { Ecg } from "./ecg";
import { PulseOximeter } from "./pulseOximeter";
import { Stethoscope } from "./stethoscope";
import { Thermometer } from "./thermometer";
import type { CameraFrame } from "./camera";
import type { NativeChannel } from "../MedWandBridge";
import type {
  ActiveSensor,
  CameraMode,
  Capture,
  DeviceState,
  DeviceStatus,
  Inbound,
  ReadingEvent,
  SdkReading,
  SensorId,
  StethMode,
} from "../protocol";
import type {
  EmulatorAction,
  EmulatorHandle,
  EmulatorPhysical,
  EmulatorView,
  FrameTransport,
} from "./types";

export type {
  EmulatorHandle,
  EmulatorView,
  FingerState,
  FrameTransport,
  ThermometerTarget,
} from "./types";

/** A command as the bridge posts it, before its arguments are read. */
interface InboundCommand {
  id: string;
  cmd: string;
  args: Record<string, unknown>;
}

/** A validated `startSensor`: the sensor, plus the mode it requires. */
type StartPlan =
  | { sensor: "thermometer" | "pulseOximeter" | "ecg" }
  | { sensor: "stethoscope"; mode: StethMode }
  | { sensor: "camera"; mode: CameraMode };

/**
 * The emulated device. Owns the wire state, the physical state the dev panel drives,
 * and the sensors; every command and every physical input goes through here.
 */
class MedWandEmulator implements EmulatorHandle {
  /**
   * A MedWand on the desk, unplugged and pointed at nothing, so the flow starts
   * where a tester starts: plug it in from the panel.
   */
  private readonly physical: EmulatorPhysical = {
    attached: false,
    target: "off",
    finger: "out",
  };

  private readonly state: DeviceState = {
    device: "detached",
    reading: "stopped",
    activeSensor: null,
    capabilities: CAPABILITIES_OFF,
    deviceInfo: DEVICE_INFO_IDLE,
  };

  /**
   * Which camera frame path to exercise. The native bridge decides this once from
   * the WebView's capability; here the panel switches it, so both the binary and
   * the base64 path can be driven from a browser.
   */
  private transport: FrameTransport = "base64";

  /**
   * Android grants USB permission per plugged-in device, so the dialog shows up once
   * and the answer is remembered until the device is unplugged. Null means it has
   * not been asked yet.
   */
  private usbPermission: boolean | null = null;

  /** The last reading and artifact put on the wire, kept for the panel's readout. */
  private lastReading: ReadingEvent | null = null;

  private lastCapture: Capture | null = null;

  private channel: NativeChannel | null = null;

  private readonly listeners = new Set<() => void>();

  private readonly thermometer = new Thermometer(this.physical, (sensor, reading) =>
    this.emitReading(sensor, reading),
  );

  private readonly pulseOximeter = new PulseOximeter(
    this.physical,
    (sensor, reading) => this.emitReading(sensor, reading),
    () => this.publish(),
  );

  private readonly ecg = new Ecg((sensor, reading) => this.emitReading(sensor, reading));

  private readonly stethoscope = new Stethoscope();

  private readonly camera = new Camera((frame) => this.deliverFrame(frame));

  /**
   * Cached so getSnapshot returns a stable reference between changes; a fresh object
   * on every read would spin React's store subscription.
   */
  private view: EmulatorView = this.snapshot();

  // ---------------------------------------------------------------------------
  // Panel contract (useSyncExternalStore). Arrow fields so the panel can pass
  // these straight to the hook without binding.
  // ---------------------------------------------------------------------------

  getSnapshot = (): EmulatorView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  input = (action: EmulatorAction): void => {
    switch (action.type) {
      case "attach":
        return this.attach();

      case "detach":
        return this.detach();

      case "target":
        if (action.value !== this.physical.target) {
          this.physical.target = action.value;
          this.thermometer.retarget();
        }

        // The thermometer re-reads on its next tick; nothing to restart.
        return this.publish();

      case "finger":
        this.physical.finger = action.value;
        if (this.state.activeSensor?.sensor === "pulseOximeter") {
          this.pulseOximeter.onFingerChange();
        }

        return this.publish();

      case "transport":
        this.transport = action.value;

        return this.publish();
    }
  };

  /**
   * Points the emulator at the channel it should deliver events through.
   * @param channel The channel installed on `window.MedWand`.
   */
  useChannel(channel: NativeChannel): void {
    this.channel = channel;
  }

  /**
   * Handles one raw command from the bridge, ignoring anything unparseable.
   * @param message The JSON command string as the bridge posted it.
   */
  receive(message: string): void {
    const command = parseCommand(message);
    if (command) this.dispatch(command);
  }

  // ---------------------------------------------------------------------------
  // Wire
  // ---------------------------------------------------------------------------

  private deliver(payload: Inbound): void {
    this.channel?.onmessage?.({ data: JSON.stringify(payload) });
  }

  private emitState(): void {
    this.deliver({ event: "state", data: structuredClone(this.state) });
    this.publish();
  }

  private replyOk(id: string): void {
    this.deliver({ event: "reply", data: { id, ok: true } });
  }

  private replyError(id: string, code: string, message: string): void {
    this.deliver({ event: "reply", data: { id, ok: false, error: { code, message } } });
  }

  private reject(id: string, code: string, message: string): void {
    this.later(REJECT_MS, () => this.replyError(id, code, message));
  }

  private emitReading(sensor: SensorId, reading: SdkReading): void {
    this.deliver({ event: "reading", data: { sensor, reading } });
    this.lastReading = { sensor, reading };
    this.publish();
  }

  private emitCapture(capture: Capture): void {
    this.deliver({ event: "capture", data: capture });
    this.lastCapture = capture;
    this.publish();
  }

  private deliverFrame(frame: CameraFrame): void {
    if (this.transport === "base64") {
      return this.deliver({
        event: "frame",
        data: {
          sensor: "camera",
          mode: frame.mode,
          dataUri: frame.dataUri,
          width: frame.width,
          height: frame.height,
        },
      });
    }

    // Fast path: the raw JPEG bytes, no envelope. Any binary message on this channel
    // is a camera frame, exactly as the native bridge posts it.
    const bytes = decodeJpegDataUri(frame.dataUri);
    if (bytes) this.channel?.onmessage?.({ data: bytes });
  }

  private later(ms: number, run: () => void): void {
    setTimeout(run, ms);
  }

  private snapshot(): EmulatorView {
    return {
      device: this.state.device,
      reading: this.state.reading,
      activeSensor: this.state.activeSensor?.sensor ?? null,
      physical: { ...this.physical },
      transport: this.transport,
      pulseOxStatus: this.pulseOximeter.status(),
      usbPermission: this.usbPermission,
      lastReading: this.lastReading,
      lastCapture: this.lastCapture,
    };
  }

  private publish(): void {
    this.view = this.snapshot();
    this.listeners.forEach((listener) => listener());
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  private dispatch({ cmd, args, id }: InboundCommand): void {
    switch (cmd) {
      case "getState":
        this.replyOk(id);

        return this.emitState();

      case "connect":
        return this.connect(id);

      case "disconnect":
        return this.disconnect(id);

      case "startSensor":
        return this.startSensor(id, stringArg(args, "sensor"), stringArg(args, "mode"));

      case "stopSensor":
        return this.stopSensor(id);

      case "startRecording":
        return this.startRecording(id);

      case "stopRecording":
        return this.stopRecording(id);

      case "captureFrame":
        return this.captureFrame(id);

      case "cameraLed":
        return this.cameraSetting(id, () => this.camera.led(numberArg(args, "value")));

      case "cameraFocusMode":
        return this.cameraSetting(id, () => this.camera.focusMode(args.manual === true));

      case "cameraFocusValue":
        return this.cameraSetting(id, () => this.camera.focusValue(numberArg(args, "value")));

      case "cameraMove":
        return this.otoscopeSetting(id, () =>
          this.camera.move(numberArg(args, "horizontal"), numberArg(args, "vertical")),
        );

      case "cameraZoom":
        return this.otoscopeSetting(id, () => this.camera.zoom(numberArg(args, "direction")));

      case "cameraRadius":
        return this.otoscopeSetting(id, () => this.camera.radius(numberArg(args, "direction")));

      case "cameraReset":
        return this.cameraAction(id, () => this.camera.reset());

      default:
        return this.reject(id, "DEVICE_ERROR", `Unknown command: ${cmd}`);
    }
  }

  private connect(id: string): void {
    this.later(LICENSE_ERROR_MS, () => {
      // The license check runs on every connect and complains either way, so it says
      // nothing about whether the connect will succeed.
      this.deliver({
        event: "error",
        data: { code: "LICENSE_INVALID", message: "License error: Expiring" },
      });
      this.askUsbPermission();
    });

    this.later(CONNECT_MS, () => {
      if (!this.physical.attached) {
        return this.replyError(
          id,
          "NOT_CONNECTED",
          "MedWand not found. Connect the device and try again.",
        );
      }
      if (!this.usbPermission) {
        return this.replyError(id, "USB_PERMISSION_DENIED", "USB permission denied.");
      }

      this.state.device = "connected";
      this.state.capabilities = CAPABILITIES_ON;
      this.state.deviceInfo = DEVICE_INFO_CONNECTED;
      this.emitState();
      this.replyOk(id);
    });
  }

  /**
   * Android asks between the license check and the connect itself, and only when it
   * does not already hold permission for the device. `confirm` blocks, which is what
   * makes this faithful: the connect cannot make progress while the dialog is up,
   * exactly as on the device.
   */
  private askUsbPermission(): void {
    if (!this.physical.attached || this.usbPermission !== null) return;

    this.usbPermission = window.confirm(
      "Allow the app to access the MedWand?\n\nEmulated Android USB permission dialog; Cancel denies.",
    );
    this.publish();
  }

  private disconnect(id: string): void {
    this.stopStreams();
    this.resetToIdle("attached");
    this.later(STATE_LEAD_MS, () => {
      this.emitState();
      this.replyOk(id);
    });
  }

  private startSensor(id: string, sensor?: string, mode?: string): void {
    if (this.state.device !== "connected") {
      return this.reject(id, "NOT_CONNECTED", "MedWand is not connected.");
    }
    if (!isSensorId(sensor) || !this.state.capabilities[sensor]) {
      return this.reject(id, "DEVICE_ERROR", "Unknown or unsupported sensor.");
    }

    const active = this.state.activeSensor;
    // Restarting the running sensor is how the UI switches stethoscope and camera
    // modes, so only a *different* sensor is busy (mirrors the native check).
    if (active && active.sensor !== sensor) {
      return this.reject(id, "SENSOR_BUSY", `${active.sensor} is already active.`);
    }

    const plan = this.planStart(id, sensor, mode);
    if (!plan) return;

    // A restart replaces whatever that sensor was already streaming.
    this.stopStreams();
    this.state.reading = "starting";
    this.later(STATE_LEAD_MS, () => this.emitState());
    this.later(SENSOR_MS, () => {
      // The reading state advances one snapshot before the active sensor is
      // populated, so `reading: 'reading'` with a null activeSensor is real.
      this.state.reading = "reading";
      this.emitState();
      this.state.activeSensor = this.launch(plan);
      this.emitState();
      this.replyOk(id);
    });
  }

  /**
   * Validates the mode the sensor requires, rejecting the command when it is missing.
   * @returns The plan, or null once the command has been rejected.
   */
  private planStart(id: string, sensor: SensorId, mode?: string): StartPlan | null {
    switch (sensor) {
      case "stethoscope":
        if (!isStethMode(mode)) {
          this.reject(id, "DEVICE_ERROR", "Stethoscope requires a mode (heart, lungs, or bowel).");

          return null;
        }

        return { sensor, mode };

      case "camera":
        if (!isCameraMode(mode)) {
          this.reject(id, "DEVICE_ERROR", "Camera requires a mode (dermatoscope or otoscope).");

          return null;
        }

        return { sensor, mode };

      default:
        return { sensor };
    }
  }

  /**
   * Starts the planned sensor streaming.
   * @returns The active sensor for the snapshot, carrying live control state where
   * the sensor has any.
   */
  private launch(plan: StartPlan): ActiveSensor {
    switch (plan.sensor) {
      case "thermometer":
        this.thermometer.start();

        return { sensor: plan.sensor };

      case "pulseOximeter":
        this.pulseOximeter.start();

        return { sensor: plan.sensor };

      case "ecg":
        this.ecg.start();

        return { sensor: plan.sensor };

      case "stethoscope":
        this.stethoscope.start(plan.mode);

        return { sensor: plan.sensor, mode: plan.mode };

      case "camera":
        return this.camera.start(plan.mode);
    }
  }

  private stopSensor(id: string): void {
    this.stopStreams();
    this.later(STATE_LEAD_MS, () => this.windDown(() => this.replyOk(id)));
  }

  private startRecording(id: string): void {
    // Native leaves this to the SDK; the emulator is explicit, since with no sensor
    // running there would be nothing to record.
    if (!this.state.activeSensor) {
      return this.reject(id, "DEVICE_ERROR", "No active sensor to record.");
    }

    this.state.reading = "recording";
    this.later(STATE_LEAD_MS, () => this.emitState());
    this.later(CONTROL_MS, () => this.replyOk(id));
  }

  private stopRecording(id: string): void {
    const active = this.state.activeSensor;
    if (!active) return this.reject(id, "DEVICE_ERROR", "Nothing is being recorded.");

    // Monitoring carries on where recording left off, so the sensor goes back to
    // streaming rather than stopping.
    this.state.reading = "reading";
    this.later(STATE_LEAD_MS, () => this.emitState());
    this.later(CONTROL_MS, () => this.replyOk(id));

    // The SDK delivers the artifact after the reply, and only for the two sensors
    // that record one; the camera's still comes from `captureFrame` instead.
    if (active.sensor === "ecg") {
      this.later(CAPTURE_MS, () => this.emitCapture(this.ecg.capture()));
    } else if (active.sensor === "stethoscope") {
      this.later(CAPTURE_MS, () => this.emitCapture(this.stethoscope.capture()));
    }
  }

  private captureFrame(id: string): void {
    if (!this.requireCameraMonitoring(id)) return;

    this.later(CONTROL_MS, () => this.replyOk(id));
    this.later(CAPTURE_MS, () => this.emitCapture(this.camera.still()));
  }

  /**
   * Applies a camera setting that shows up in the snapshot, so the UI can render the
   * value the device actually settled on.
   */
  private cameraSetting(id: string, apply: () => void): void {
    if (!this.requireCameraMonitoring(id)) return;

    apply();
    this.later(CONTROL_MS, () => {
      this.replyOk(id);
      this.refreshCamera();
    });
  }

  /**
   * Applies a camera command whose effect stays inside the SDK. The tip-mask lives
   * there, so pan, zoom, radius, and reset emit no state, and the native side is
   * silent for them too.
   */
  private cameraAction(id: string, apply: () => void): void {
    if (!this.requireCameraMonitoring(id)) return;

    apply();
    this.later(CONTROL_MS, () => this.replyOk(id));
  }

  /** Applies a tip-mask command, which the otoscope alone has. */
  private otoscopeSetting(id: string, apply: () => void): void {
    if (!this.camera.monitoring() || !this.camera.isOtoscope()) {
      return this.reject(id, "DEVICE_ERROR", "This control is otoscope-only.");
    }

    apply();
    this.later(CONTROL_MS, () => this.replyOk(id));
  }

  /** Mirrors the native `requireCameraMonitoring`. */
  private requireCameraMonitoring(id: string): boolean {
    if (this.camera.monitoring()) return true;

    this.reject(id, "DEVICE_ERROR", "The camera preview is not running.");

    return false;
  }

  /** Republishes the camera's live control state after a setting changed. */
  private refreshCamera(): void {
    const controls = this.camera.controls();
    if (!controls) return;

    this.state.activeSensor = controls;
    this.emitState();
  }

  // ---------------------------------------------------------------------------
  // Physical inputs (the dev panel)
  // ---------------------------------------------------------------------------

  private attach(): void {
    this.physical.attached = true;
    this.state.device = "attached";
    this.state.deviceInfo = DEVICE_INFO_IDLE;
    this.emitAttachBurst();
    this.publish();
  }

  private detach(): void {
    this.stopStreams();
    this.physical.attached = false;
    // Permission belongs to the plugged-in device, so replugging asks again.
    this.usbPermission = null;

    const finish = (): void => {
      this.resetToIdle("detached");
      // Nothing is on the wire now, so the readout should not imply otherwise.
      this.lastReading = null;
      this.lastCapture = null;
      this.emitAttachBurst();
      this.publish();
    };

    // Unplugging mid-reading is an orderly shutdown as far as the SDK is concerned:
    // the same wind-down as a stopSensor, then the detach. No error.
    if (this.state.activeSensor) this.windDown(finish);
    else finish();
  }

  // ---------------------------------------------------------------------------
  // Shared choreography
  // ---------------------------------------------------------------------------

  private stopStreams(): void {
    this.thermometer.stop();
    this.pulseOximeter.stop();
    this.ecg.stop();
    this.stethoscope.stop();
    this.camera.stop();
  }

  private resetToIdle(device: DeviceStatus): void {
    this.state.device = device;
    this.state.reading = "stopped";
    this.state.activeSensor = null;
    this.state.capabilities = CAPABILITIES_OFF;
    this.state.deviceInfo = DEVICE_INFO_IDLE;
  }

  /**
   * The teardown the device performs whenever a sensor stops running, whether the app
   * asked or the cable was pulled: the reading state winds down first, and only then
   * is the active sensor cleared.
   * @param then Runs once the wind-down states have been emitted.
   */
  private windDown(then: () => void): void {
    this.state.reading = "stopping";
    this.emitState();
    this.later(SENSOR_MS, () => {
      this.state.reading = "stopped";
      this.emitState();
      this.state.activeSensor = null;
      this.emitState();
      then();
    });
  }

  /** Physical attach/detach; the device always reports it three times. */
  private emitAttachBurst(): void {
    for (let i = 0; i < ATTACH_REPEATS; i += 1) {
      this.later(i * ATTACH_REPEAT_MS, () => this.emitState());
    }
  }
}

// ---------------------------------------------------------------------------
// Command parsing. The sender is our own bridge, so this validates the envelope
// and reads arguments defensively rather than schema-checking every command.
// ---------------------------------------------------------------------------

function parseCommand(message: string): InboundCommand | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const { id, cmd, args } = raw;
  if (typeof id !== "string" || typeof cmd !== "string") return null;

  return { id, cmd, args: isRecord(args) ? args : {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];

  return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = Number(args[key]);

  return Number.isFinite(value) ? value : 0;
}

function isSensorId(value?: string): value is SensorId {
  return (
    value === "thermometer" ||
    value === "pulseOximeter" ||
    value === "ecg" ||
    value === "stethoscope" ||
    value === "camera"
  );
}

function isStethMode(value?: string): value is StethMode {
  return value === "heart" || value === "lungs" || value === "bowel";
}

function isCameraMode(value?: string): value is CameraMode {
  return value === "dermatoscope" || value === "otoscope";
}

/** Unwraps a base64 `data:` URI back into the bytes the binary path posts. */
function decodeJpegDataUri(dataUri: string): ArrayBuffer | null {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  try {
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    return buffer;
  } catch {
    return null;
  }
}

let handle: MedWandEmulator | null = null;

/**
 * The installed emulator's control handle. `subscribe`/`getSnapshot` match React's
 * `useSyncExternalStore` contract.
 * @returns The handle, or null when no emulator is running (production, or inside
 * the Android shell).
 */
export function getMedWandEmulator(): EmulatorHandle | null {
  return handle;
}

/**
 * Installs the browser emulator on `window.MedWand`.
 *
 * Does nothing when a bridge (real or emulated) is already present, so it is safe to
 * call unconditionally at startup. Intended for development only.
 */
export function installMedWandEmulator(): void {
  // The real WebMessageListener bridge injects window.MedWand. If it's already here
  // we're inside the Android shell (or already emulated), so leave it alone.
  if (window.MedWand) return;

  const emulator = new MedWandEmulator();
  const channel: NativeChannel = {
    __mock: true,
    onmessage: null,
    postMessage: (message: string) => emulator.receive(message),
  };

  emulator.useChannel(channel);
  handle = emulator;
  window.MedWand = channel;

  console.info("[MedWand emulator] window.MedWand installed (dev browser mock, no real device).");
}
