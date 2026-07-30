// Types shared across the emulator's modules. Kept in their own file so the
// sensor modules and the installer can both import them without a cycle.

import type {
  Capture,
  DeviceStatus,
  ReadingEvent,
  ReadingStatus,
  SdkReading,
  SensorId,
} from "../protocol";

export type ThermometerTarget = "off" | "on" | "high";
export type FingerState = "out" | "in" | "moving";

/**
 * How live camera frames reach the bridge. The native shell picks this once from
 * the WebView's capability (raw `ArrayBuffer` when supported, base64 `frame`
 * events otherwise); here it's switchable so both paths can be exercised in a
 * browser.
 */
export type FrameTransport = "base64" | "binary";

/**
 * The physical situation the device finds itself in. The emulator owns it and the
 * sensors read it live, so a probe or finger change is visible on the very next
 * tick without anything being passed around.
 */
export interface EmulatorPhysical {
  attached: boolean;
  target: ThermometerTarget;
  finger: FingerState;
}

export type EmulatorAction =
  | { type: "attach" }
  | { type: "detach" }
  | { type: "target"; value: ThermometerTarget }
  | { type: "finger"; value: FingerState }
  | { type: "transport"; value: FrameTransport };

/** What the dev panel renders. */
export interface EmulatorView {
  device: DeviceStatus;
  reading: ReadingStatus;
  activeSensor: SensorId | null;
  physical: EmulatorPhysical;
  transport: FrameTransport;
  /** The pulse oximeter's current mode, or null when it isn't running. */
  pulseOxStatus: string | null;
  /** Whether USB permission was granted, or null while it is still unasked. */
  usbPermission: boolean | null;
  /** The last reading put on the wire, for the panel's debug readout. */
  lastReading: ReadingEvent | null;
  /** The last recorded artifact put on the wire, likewise. */
  lastCapture: Capture | null;
}

export interface EmulatorHandle {
  input: (action: EmulatorAction) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => EmulatorView;
}

/** Puts a reading on the wire. */
export type EmitReading = (sensor: SensorId, reading: SdkReading) => void;

/** A pending timer, whichever clock the host provides. */
export type Timer = ReturnType<typeof setTimeout>;
