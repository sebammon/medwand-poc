import type {
  BridgeError,
  Capture,
  DeviceState,
  FrameEvent,
  Inbound,
  ReadingEvent,
  SensorId,
  SensorOptions,
} from "./protocol";

/**
 * The native channel injected by the Android shell (WebMessageListener). Every
 * message is a JSON string — replies and events (captures included, forwarded
 * as base64 `data:` URIs).
 */
export interface NativeChannel {
  postMessage: (message: string) => void;
  // `data` is a JSON string for every message except live camera frames on the
  // native fast path, which arrive as a raw binary ArrayBuffer.
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  /** Present and true when this is the browser mock, absent for the real bridge. */
  __mock?: boolean;
}

declare global {
  interface Window {
    MedWand?: NativeChannel;
  }
}

type Events = {
  state: DeviceState;
  reading: ReadingEvent;
  error: BridgeError;
  capture: Capture;
  frame: FrameEvent;
};

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

/**
 * Promise-based client over the native channel. Each command carries a caller
 * -generated `id` so replies can be matched while multiple commands are in
 * flight; events (no `id`) and captures (binary) are dispatched to listeners.
 */
export class MedWandBridge {
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: BridgeError) => void }
  >();
  private readonly listeners: { [K in keyof Events]: Set<Handler<K>> } = {
    state: new Set(),
    reading: new Set(),
    error: new Set(),
    capture: new Set(),
    frame: new Set(),
  };

  // The object URL backing the most recent binary frame. Kept alive until the
  // next frame supersedes it, then revoked, so at most one is ever live.
  private lastFrameUrl: string | null = null;

  constructor(private readonly channel: NativeChannel) {
    channel.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string") this.route(data);
      else this.emitFrameBuffer(data); // raw ArrayBuffer → a camera frame
    };
  }

  on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  // Commands (bridge doc §3).
  getState = () => this.send("getState");
  connect = () => this.send("connect");
  disconnect = () => this.send("disconnect");
  // Every sensor starts here, camera included. The wire carries a single `mode`
  // string; at most one options field is set, so they collapse to it.
  startSensor = (sensor: SensorId, options?: SensorOptions) => {
    const mode = options?.cameraMode ?? options?.stethMode;
    return this.send("startSensor", mode ? { sensor, mode } : { sensor });
  };
  stopSensor = () => this.send("stopSensor");
  startRecording = () => this.send("startRecording");
  stopRecording = () => this.send("stopRecording");

  // Camera (otoscope/dermatoscope) controls — the preview itself starts through
  // startSensor with a camera mode; these drive the live controls and capture.
  captureFrame = () => this.send("captureFrame");
  cameraLed = (value: number) => this.send("cameraLed", { value });
  cameraFocusMode = (manual: boolean) => this.send("cameraFocusMode", { manual });
  cameraFocusValue = (value: number) => this.send("cameraFocusValue", { value });
  cameraMove = (horizontal?: number, vertical?: number) =>
    this.send("cameraMove", { horizontal, vertical });
  cameraZoom = (direction: number) => this.send("cameraZoom", { direction });
  cameraRadius = (direction: number) => this.send("cameraRadius", { direction });
  cameraReset = () => this.send("cameraReset");

  private send<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.channel.postMessage(JSON.stringify({ id, cmd, args }));
    });
  }

  private route(data: string): void {
    const message = JSON.parse(data) as Inbound;
    switch (message.event) {
      case "reply": {
        const { id, ok, error } = message.data;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (!ok && error) entry.reject(error);
        else entry.resolve(undefined);
        break;
      }
      case "state":
        this.emit("state", message.data);
        break;
      case "reading":
        this.emit("reading", message.data);
        break;
      case "capture":
        this.emit("capture", message.data);
        break;
      case "frame":
        // String path (mock / base64 fallback): the data URI is the image src.
        this.emit("frame", { sensor: "camera", src: message.data.dataUri });
        break;
      case "error":
        this.emit("error", message.data);
        break;
    }
  }

  private emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event].forEach((handler) => handler(payload));
  }

  // Binary path: wrap the raw JPEG bytes in a Blob and hand listeners an object
  // URL. Revoke the previous one now that this frame supersedes it — the <img>
  // has already painted it — so only one object URL is ever live.
  private emitFrameBuffer(buffer: ArrayBuffer): void {
    const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
    this.emit("frame", { sensor: "camera", src: url });
    if (this.lastFrameUrl) URL.revokeObjectURL(this.lastFrameUrl);
    this.lastFrameUrl = url;
  }
}
