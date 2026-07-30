import { BLANK_PNG } from "./artifacts";
import type { CameraMode, CameraSensorState, Capture } from "../protocol";
import type { Timer } from "./types";

const FRAME_MS = 90; // ~11 fps, matching the throttled native stream
const WIDTH = 640;
const HEIGHT = 480;

// Session ranges the SDK reports once a preview runs. Real hardware can differ by
// mode, and a fixed (non-dimmable) ring light is possible; this device dims.
const LED_MAX = 100;
const LED_ADJUSTABLE = true;
const FOCUS_MAX = 100;
const FOCUS_DEFAULT = 50;

// Otoscope tip-mask steps, mirroring the native OTOSCOPE_* constants.
const MOVE_STEP = 6;
const PAN_LIMIT = 40;
const ZOOM_LIMIT = 8;
const RADIUS_LIMIT = 8;

/** A live preview frame, as the pipeline hands it to the transport. */
export interface CameraFrame {
  mode: CameraMode;
  dataUri: string;
  width: number;
  height: number;
}

/**
 * The USB camera: a synthetic preview plus the live controls the SDK exposes while
 * it runs. The image is drawn rather than captured, so the ring light, the focus
 * position, and the otoscope tip mask all visibly affect it, which is what makes
 * the controls testable without hardware.
 */
export class Camera {
  private timer: Timer | null = null;

  private frame = 0;

  /** The running preview mode, or null when the camera is off. */
  private mode: CameraMode | null = null;

  private readonly settings = {
    ledIntensity: 0,
    manualFocusEnabled: false,
    focusValue: FOCUS_DEFAULT,
  };

  /** The otoscope tip mask's position, only meaningful in otoscope mode. */
  private readonly view = { panX: 0, panY: 0, zoom: 0, radius: 0 };

  constructor(private readonly emitFrame: (frame: CameraFrame) => void) {}

  /**
   * Starts (or restarts) the preview.
   * @param mode The preview to run.
   * @returns The live control state, for the snapshot's `activeSensor`.
   */
  start(mode: CameraMode): CameraSensorState {
    this.stop();
    this.frame = 0;
    this.settings.ledIntensity = 0;
    this.settings.manualFocusEnabled = false;
    this.settings.focusValue = FOCUS_DEFAULT;
    this.reset();
    this.mode = mode;
    this.timer = setInterval(() => this.tick(mode), FRAME_MS);

    return this.build(mode);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mode = null;
  }

  /** Whether a preview is running (the native `cameraIsMonitoring`). */
  monitoring(): boolean {
    return this.mode !== null;
  }

  /** Whether the running preview is the otoscope, which alone has a tip mask. */
  isOtoscope(): boolean {
    return this.mode === "otoscope";
  }

  /**
   * The live control state.
   * @returns The state, or null when the camera is off.
   */
  controls(): CameraSensorState | null {
    return this.mode ? this.build(this.mode) : null;
  }

  /** Sets the ring-light intensity (0..ledMax). */
  led(value: number): void {
    this.settings.ledIntensity = clampInt(value, 0, LED_MAX);
  }

  focusMode(manual: boolean): void {
    this.settings.manualFocusEnabled = manual;
  }

  focusValue(value: number): void {
    this.settings.focusValue = clampInt(value, 0, FOCUS_MAX);
  }

  move(horizontal: number, vertical: number): void {
    this.view.panX = clampInt(this.view.panX + horizontal * MOVE_STEP, -PAN_LIMIT, PAN_LIMIT);
    this.view.panY = clampInt(this.view.panY + vertical * MOVE_STEP, -PAN_LIMIT, PAN_LIMIT);
  }

  zoom(direction: number): void {
    this.view.zoom = clampInt(this.view.zoom + direction, -ZOOM_LIMIT, ZOOM_LIMIT);
  }

  radius(direction: number): void {
    this.view.radius = clampInt(this.view.radius + direction, -RADIUS_LIMIT, RADIUS_LIMIT);
  }

  reset(): void {
    this.view.panX = 0;
    this.view.panY = 0;
    this.view.zoom = 0;
    this.view.radius = 0;
  }

  /**
   * The one-shot recorded still.
   * @returns The capture, carrying a JPEG `data:` URI.
   */
  still(): Capture {
    if (!this.mode) return { sensor: "camera", dataUri: BLANK_PNG };

    return { sensor: "camera", mode: this.mode, dataUri: this.draw(this.mode, true) };
  }

  private build(mode: CameraMode): CameraSensorState {
    return {
      sensor: "camera",
      mode,
      monitoring: true,
      ledMax: LED_MAX,
      ledIntensity: this.settings.ledIntensity,
      ledAdjustable: LED_ADJUSTABLE,
      autoFocusAvailable: true,
      manualFocusAvailable: true,
      manualFocusEnabled: this.settings.manualFocusEnabled,
      focusValue: this.settings.focusValue,
      focusValueMax: FOCUS_MAX,
    };
  }

  private tick(mode: CameraMode): void {
    this.frame += 1;
    this.emitFrame({ mode, dataUri: this.draw(mode, false), width: WIDTH, height: HEIGHT });
  }

  /**
   * Draws a synthetic, moving preview so the panel shows live motion. Otoscope mode
   * adds the circular tip mask the SDK applies on the device.
   * @param mode The preview being drawn, which sets the palette and the mask.
   * @param still Whether this is the recorded still rather than a preview frame.
   * @returns A JPEG `data:` URI, or a blank PNG when there is no DOM to draw on.
   */
  private draw(mode: CameraMode, still: boolean): string {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return BLANK_PNG;

    const t = this.frame * 0.12;
    const zoom = 1 + this.view.zoom * 0.06;

    // A drifting tissue-like backdrop, lit by the ring light.
    const hue = mode === "otoscope" ? 8 : 335;
    ctx.fillStyle = `hsl(${hue}, 45%, ${18 + this.settings.ledIntensity * 0.18}%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 26; i += 1) {
      const x = (((i * 97 + Math.sin(t + i) * 30) % canvas.width) + canvas.width) % canvas.width;
      const y = (((i * 53 + Math.cos(t * 0.8 + i) * 24) % canvas.height) + canvas.height) % canvas.height;
      ctx.fillStyle = `hsla(${hue + (i % 5) * 6}, 60%, ${45 + (i % 4) * 6}%, 0.5)`;
      ctx.beginPath();
      ctx.arc(x, y, (14 + (i % 5) * 6) * zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // Focus blur proxy: a soft vignette that sharpens toward the set value.
    const focus = this.settings.manualFocusEnabled ? this.settings.focusValue : 60;
    const blur = Math.max(0, (60 - focus) / 12);
    if (blur > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.35, blur * 0.05)})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (mode === "otoscope") {
      const cx = canvas.width / 2 + this.view.panX * 3;
      const cy = canvas.height / 2 + this.view.panY * 3;
      const r = (150 + this.view.radius * 12) * zoom;
      ctx.globalCompositeOperation = "destination-in";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }

    if (still) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "20px system-ui";
      ctx.fillText(`${mode} still`, 16, 30);
    }

    return canvas.toDataURL("image/jpeg", 0.7);
  }
}

function clampInt(value: number, lo: number, hi: number): number {
  const n = Math.round(Number.isFinite(value) ? value : 0);

  return Math.max(lo, Math.min(hi, n));
}
