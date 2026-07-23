// Wire protocol shared with the native bridge (see docs/medwand-bridge.md).

export type SensorId = "thermometer" | "pulseOximeter" | "ecg" | "stethoscope" | "camera";
export type StethMode = "heart" | "lungs" | "bowel";
export type CameraMode = "dermatoscope" | "otoscope";

// Per-sensor start options (mirror of the native SensorOptions). Only the
// stethoscope and camera need one; the relevant field is picked by sensor.
export interface SensorOptions {
  stethMode?: StethMode;
  cameraMode?: CameraMode;
}

export type ErrorCode =
  | "SENSOR_BUSY"
  | "NOT_CONNECTED"
  | "USB_PERMISSION_DENIED"
  | "LICENSE_INVALID"
  | "DEVICE_ERROR";

export interface BridgeError {
  code: ErrorCode | string;
  message: string;
}

export interface DeviceState {
  device: string; // detached | attached | connecting | connected
  reading: string; // idle | active | recording
  // The running sensor plus its live, user-settable state (null when idle).
  activeSensor: ActiveSensor | null;
  capabilities: {
    thermometer: boolean;
    pulseOximeter: boolean;
    ecg: boolean;
    stethoscope: boolean;
    camera: boolean;
  };
  deviceInfo: {
    udi: string | null;
    firmwareVersion: string | null;
    generation: string | null;
    comPort: string | null;
    vendorId: string | null;
    productId: string | null;
  };
}

// The active sensor is a tagged union discriminated on `sensor`: the camera and
// stethoscope carry their live control state, the rest carry nothing.
export type ActiveSensor = CameraSensorState | StethoscopeSensorState | PlainSensorState;

// Live camera control state (present only while the camera is active). Ranges
// (`ledMax`, `focusValueMax`, availability flags) sit here with the current
// values because they're session-scoped and can differ by mode.
export interface CameraSensorState {
  sensor: "camera";
  mode: "off" | CameraMode; // active preview mode
  monitoring: boolean;
  ledMax: number;
  ledIntensity: number;
  ledAdjustable: boolean;
  autoFocusAvailable: boolean;
  manualFocusAvailable: boolean;
  manualFocusEnabled: boolean;
  focusValue: number;
  focusValueMax: number;
}

export interface StethoscopeSensorState {
  sensor: "stethoscope";
  mode: StethMode;
}

export interface PlainSensorState {
  sensor: "thermometer" | "pulseOximeter" | "ecg";
}

// The SDK's MedWandReading, forwarded verbatim (all fields, incl. nulls).
// Scalars are strings; the frontend parses them. ECG's `ecgData` is the raw
// whitespace-separated dimensionless waveform.
export interface SdkReading {
  sensorType: string | null;
  timeStamp: string | null;
  status: string | null;
  index: number;
  count: number;
  tempAmbient: string | null;
  tempObject: string | null;
  pulseRate: string | null;
  spo2: string | null;
  ecgData: string | null;
}

// The `reading` event: our sensor name + the raw SDK reading.
export interface ReadingEvent {
  sensor: SensorId;
  reading: SdkReading;
}

// A recorded artifact, forwarded from the SDK as a base64 `data:` URI that can
// be used directly as an <img>/<audio> source.
export interface Capture {
  sensor: SensorId | string;
  mode?: string;
  dataUri: string;
}

// A live camera preview frame as it arrives over the JSON string channel: a JPEG
// `data:` URI plus its dimensions. Used by the browser mock and by the native
// base64 fallback. The native fast path instead delivers the JPEG bytes as a raw
// binary `ArrayBuffer` message (no envelope) — see MedWandBridge.
export interface WireFrameEvent {
  sensor: "camera";
  mode: string;
  dataUri: string;
  width: number;
  height: number;
}

// The normalized frame handed to listeners, regardless of transport: a
// ready-to-use image `src` (a base64 `data:` URI on the string path, an object
// URL on the binary path).
export interface FrameEvent {
  sensor: "camera";
  src: string;
}

// Reply payload, carried by the `reply` event and matched to a command by id.
export interface ReplyData {
  id: string;
  ok: boolean;
  error?: BridgeError;
}

// Every native → web message is a uniform `{ event, data }` envelope.
export type Inbound =
  | { event: "reply"; data: ReplyData }
  | { event: "state"; data: DeviceState }
  | { event: "reading"; data: ReadingEvent }
  | { event: "capture"; data: Capture }
  | { event: "frame"; data: WireFrameEvent }
  | { event: "error"; data: BridgeError };

/** Parse a numeric value the SDK emits as a string, tolerating transient junk. */
export function parseNumeric(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** Parse ECG `ecgData` into its dimensionless sample values. */
export function parseEcgData(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}
