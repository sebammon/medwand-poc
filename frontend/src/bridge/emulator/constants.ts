/**
 * Wire timings and payload fragments. The connect, sensor, and state timings are
 * measured from real device traces; the two marked synthetic were never captured,
 * because the recorded-artifact and camera paths were traced only by hand.
 * Sensor-specific timings live with their sensor.
 */

import type { Capabilities, DeviceInfo } from "../protocol";

export const LICENSE_ERROR_MS = 10; // LICENSE_INVALID, before every connect reply
export const CONNECT_MS = 2050; // connect reply
export const SENSOR_MS = 55; // startSensor / stopSensor reply
export const REJECT_MS = 4; // any rejected command
export const STATE_LEAD_MS = 3; // first state event of a choreography
export const ATTACH_REPEAT_MS = 260; // gap between repeated attach/detach snapshots
export const ATTACH_REPEATS = 3; // the device always sends this state three times
export const CONTROL_MS = 40; // synthetic: recording and camera-control replies
export const CAPTURE_MS = 150; // synthetic: recorded artifact, after the reply

export const CAPABILITIES_OFF: Capabilities = {
  thermometer: false,
  pulseOximeter: false,
  ecg: false,
  stethoscope: false,
  camera: false,
};

// Every sensor, because this emulator streams every sensor. Capabilities have to
// say exactly what `startSensor` will accept: advertising one it cannot serve
// would leave the UI waiting on readings that never arrive.
export const CAPABILITIES_ON: Capabilities = {
  thermometer: true,
  pulseOximeter: true,
  ecg: true,
  stethoscope: true,
  camera: true,
};

// Mock values shaped like a real device's, identifying no actual hardware.
export const DEVICE_INFO_CONNECTED: DeviceInfo = {
  udi: "(01)00000000000000(11)250101(21)EMULATOR",
  firmwareVersion: "0.0.0.0",
  generation: "Generation2",
  comPort: "/dev/bus/usb/000/000",
  vendorId: "0000",
  productId: "0000",
};

// Present but not initialized: the SDK knows nothing yet, and reports the empty
// string / "Unknown" rather than null.
export const DEVICE_INFO_IDLE: DeviceInfo = {
  udi: "",
  firmwareVersion: null,
  generation: "Unknown",
  comPort: null,
  vendorId: null,
  productId: null,
};
