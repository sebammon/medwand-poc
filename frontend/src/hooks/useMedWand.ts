import { useCallback, useEffect, useMemo, useState } from "react";
import { MedWandBridge } from "../bridge/MedWandBridge";
import type {
  BridgeError,
  Capture,
  DeviceState,
  FrameEvent,
  ReadingEvent,
  SensorId,
  SensorOptions,
} from "../bridge/protocol";

export interface MedWand {
  /** True when running inside the real Android shell (vs. the browser mock). */
  native: boolean;
  state: DeviceState | null;
  reading: ReadingEvent | null;
  capture: Capture | null;
  error: BridgeError | null;
  connect: () => void;
  disconnect: () => void;
  startSensor: (sensor: SensorId, options?: SensorOptions) => void;
  stopSensor: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  clearError: () => void;
  // Camera (otoscope/dermatoscope) — the preview starts via startSensor.
  captureFrame: () => void;
  cameraLed: (value: number) => void;
  cameraFocusMode: (manual: boolean) => void;
  cameraFocusValue: (value: number) => void;
  cameraMove: (horizontal?: number, vertical?: number) => void;
  cameraZoom: (direction: number) => void;
  cameraRadius: (direction: number) => void;
  cameraReset: () => void;
  /**
   * Subscribe to live preview frames. Kept off React state on purpose: frames
   * arrive ~12×/s, so consumers wire them straight into an <img> to avoid
   * re-rendering the app on every frame. Returns an unsubscribe fn.
   */
  onFrame: (handler: (frame: FrameEvent) => void) => () => void;
}

export function useMedWand(): MedWand {
  // The real bridge and the browser mock both expose window.MedWand; the mock
  // additionally sets `__mock`, so we can tell which one we're talking to.
  const channel = window.MedWand;
  const native = channel != null && !channel.__mock;
  const bridge = useMemo(() => {
    if (!channel) {
      throw new Error("window.MedWand is unavailable; the browser emulator installs it in dev.");
    }
    return new MedWandBridge(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, setState] = useState<DeviceState | null>(null);
  const [reading, setReading] = useState<ReadingEvent | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState<BridgeError | null>(null);

  useEffect(() => {
    const offs = [
      bridge.on("state", setState),
      bridge.on("reading", setReading),
      bridge.on("error", setError),
      bridge.on("capture", setCapture),
    ];
    bridge.getState().catch(setError);
    return () => offs.forEach((off) => off());
  }, [bridge]);

  const run = useCallback(
    (action: () => Promise<unknown>) => {
      action().catch((e: BridgeError) => setError(e));
    },
    [],
  );

  const startSensor = useCallback(
    (sensor: SensorId, options?: SensorOptions) => {
      setReading(null);
      setCapture(null);
      run(() => bridge.startSensor(sensor, options));
    },
    [bridge, run],
  );

  const onFrame = useCallback(
    (handler: (frame: FrameEvent) => void) => bridge.on("frame", handler),
    [bridge],
  );

  return {
    native,
    state,
    reading,
    capture,
    error,
    connect: () => run(() => bridge.connect()),
    disconnect: () => run(() => bridge.disconnect()),
    startSensor,
    stopSensor: () => run(() => bridge.stopSensor()),
    startRecording: () => run(() => bridge.startRecording()),
    stopRecording: () => run(() => bridge.stopRecording()),
    clearError: () => setError(null),
    captureFrame: () => run(() => bridge.captureFrame()),
    cameraLed: (value: number) => run(() => bridge.cameraLed(value)),
    cameraFocusMode: (manual: boolean) => run(() => bridge.cameraFocusMode(manual)),
    cameraFocusValue: (value: number) => run(() => bridge.cameraFocusValue(value)),
    cameraMove: (horizontal?: number, vertical?: number) =>
      run(() => bridge.cameraMove(horizontal, vertical)),
    cameraZoom: (direction: number) => run(() => bridge.cameraZoom(direction)),
    cameraRadius: (direction: number) => run(() => bridge.cameraRadius(direction)),
    cameraReset: () => run(() => bridge.cameraReset()),
    onFrame,
  };
}
