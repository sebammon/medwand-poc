import { useEffect, useRef, useState } from "react";
import type { CameraMode, CameraSensorState } from "../bridge/protocol";
import type { MedWand } from "../hooks/useMedWand";
import { Panel } from "./ui";

const MODES: { id: CameraMode; label: string; icon: string }[] = [
  { id: "dermatoscope", label: "Dermatoscope", icon: "🔬" },
  { id: "otoscope", label: "Otoscope", icon: "👂" },
];

export function CameraPanel({ mw }: { mw: MedWand }) {
  const active = mw.state?.activeSensor;
  const cam = active?.sensor === "camera" ? active : null;
  const running = cam?.monitoring === true;
  const mode = cam?.mode ?? "off";
  const capture = mw.capture?.sensor === "camera" ? mw.capture : null;

  const imgRef = useRef<HTMLImageElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [starting, setStarting] = useState<CameraMode | null>(null);

  // Delivered-frame counter, sampled once a second — this is what actually
  // differs between the binary and base64 transports (see the transport tag:
  // `blob:` URLs come over the binary channel, `data:` URIs over base64).
  const frameCountRef = useRef(0);
  const transportRef = useRef<"binary" | "base64" | null>(null);
  const [stats, setStats] = useState<{ fps: number; transport: string } | null>(null);

  // Feed live frames straight into the <img> element. Frames arrive many times a
  // second, so this deliberately bypasses React state to avoid re-rendering on
  // each one; we only count them here.
  useEffect(() => {
    if (!running) return;
    const off = mw.onFrame((frame) => {
      if (frame.sensor !== "camera") return;
      const img = imgRef.current;
      if (img) img.src = frame.src;
      frameCountRef.current += 1;
      transportRef.current = frame.src.startsWith("blob:") ? "binary" : "base64";
      setHasFrame(true);
    });
    return off;
  }, [running, mw]);

  // Sample the delivered frame rate once a second (no per-frame re-render).
  useEffect(() => {
    if (!running) {
      setStats(null);
      return;
    }
    frameCountRef.current = 0;
    const id = window.setInterval(() => {
      setStats({ fps: frameCountRef.current, transport: transportRef.current ?? "—" });
      frameCountRef.current = 0;
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // Reset the preview when monitoring stops or the mode changes.
  useEffect(() => {
    if (!running) {
      setHasFrame(false);
      if (imgRef.current) imgRef.current.removeAttribute("src");
    }
  }, [running, mode]);

  // Clear the "starting…" affordance once the preview is actually up.
  useEffect(() => {
    if (running) setStarting(null);
  }, [running]);

  const selectMode = (next: CameraMode) => {
    setStarting(next);
    setHasFrame(false);
    mw.startSensor("camera", { cameraMode: next });
  };

  const stop = () => {
    setStarting(null);
    mw.stopSensor();
  };

  const isOtoscope = mode === "otoscope";

  return (
    <Panel title="Camera">
      <p className="hint">
        Live otoscope / dermatoscope preview streamed from the MedWand's USB camera. Pick a mode,
        aim, then capture a still.
      </p>

      <div className="modes">
        {MODES.map((option) => {
          const active = running && mode === option.id;
          const isStarting = starting === option.id && !running;
          return (
            <button
              key={option.id}
              className={`mode${active ? " mode--active" : ""}`}
              disabled={isStarting}
              onClick={() => selectMode(option.id)}
            >
              {option.icon} {option.label}
              {isStarting ? " …" : ""}
            </button>
          );
        })}
        <button className="mode" disabled={!running} onClick={stop}>
          Off
        </button>
      </div>

      <div className="camera-stage">
        {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
        <img ref={imgRef} className="camera-stage__img" alt="Live camera preview" />
        {!hasFrame && (
          <div className="camera-stage__placeholder">
            {starting || running ? "Starting preview…" : "Preview off"}
          </div>
        )}
        {running && hasFrame && stats && (
          <div className="camera-stage__stat">
            {stats.fps} fps · {stats.transport}
          </div>
        )}
      </div>

      <div className="controls">
        <button className="action action--start" disabled={!running} onClick={mw.captureFrame}>
          Capture still
        </button>
        {isOtoscope && (
          <button className="action action--neutral" disabled={!running} onClick={mw.cameraReset}>
            Reset view
          </button>
        )}
      </div>

      {running && cam && (
        <div className="camera-controls">
          <LedControl mw={mw} cam={cam} />
          <FocusControl mw={mw} cam={cam} />
          {isOtoscope && <OtoscopePad mw={mw} />}
        </div>
      )}

      {capture && (
        <figure className="capture">
          <figcaption className="hint">
            Captured still{capture.mode ? ` · ${capture.mode}` : ""}
          </figcaption>
          <img className="capture__img" src={capture.dataUri} alt="Captured camera still" />
        </figure>
      )}
    </Panel>
  );
}

type CamState = CameraSensorState;

/** Ring-light control: a slider for dimmable LEDs, a toggle otherwise. */
function LedControl({ mw, cam }: { mw: MedWand; cam: CamState }) {
  if (cam.ledMax <= 0) return null;
  if (!cam.ledAdjustable) {
    const on = cam.ledIntensity > 0;
    return (
      <div className="camera-control">
        <span className="camera-control__label">Light</span>
        <button className={`mode${on ? " mode--active" : ""}`} onClick={() => mw.cameraLed(on ? 0 : cam.ledMax)}>
          {on ? "On" : "Off"}
        </button>
      </div>
    );
  }
  return (
    <CommitSlider
      label="Light"
      value={cam.ledIntensity}
      min={0}
      max={cam.ledMax}
      onCommit={(v) => mw.cameraLed(v)}
    />
  );
}

/** Focus: auto/manual toggle plus a position slider in manual mode. */
function FocusControl({ mw, cam }: { mw: MedWand; cam: CamState }) {
  if (!cam.autoFocusAvailable && !cam.manualFocusAvailable) return null;
  return (
    <div className="camera-control camera-control--focus">
      <span className="camera-control__label">Focus</span>
      <div className="camera-control__row">
        {cam.autoFocusAvailable && (
          <button
            className={`mode${!cam.manualFocusEnabled ? " mode--active" : ""}`}
            onClick={() => mw.cameraFocusMode(false)}
          >
            Auto
          </button>
        )}
        {cam.manualFocusAvailable && (
          <button
            className={`mode${cam.manualFocusEnabled ? " mode--active" : ""}`}
            onClick={() => mw.cameraFocusMode(true)}
          >
            Manual
          </button>
        )}
      </div>
      {cam.manualFocusEnabled && cam.manualFocusAvailable && (
        <CommitSlider
          label=""
          value={cam.focusValue}
          min={0}
          max={cam.focusValueMax}
          onCommit={(v) => mw.cameraFocusValue(v)}
        />
      )}
    </div>
  );
}

/** Otoscope tip mask: pan, zoom, and circle size. */
function OtoscopePad({ mw }: { mw: MedWand }) {
  return (
    <div className="camera-control otoscope-pad">
      <span className="camera-control__label">Otoscope</span>
      <div className="otoscope-pad__grid">
        <button className="pad" onClick={() => mw.cameraMove(undefined, -1)}>↑</button>
        <div className="otoscope-pad__mid">
          <button className="pad" onClick={() => mw.cameraMove(-1)}>←</button>
          <button className="pad" onClick={() => mw.cameraMove(1)}>→</button>
        </div>
        <button className="pad" onClick={() => mw.cameraMove(undefined, 1)}>↓</button>
      </div>
      <div className="otoscope-pad__row">
        <span className="camera-control__sublabel">Zoom</span>
        <button className="pad" onClick={() => mw.cameraZoom(-1)}>−</button>
        <button className="pad" onClick={() => mw.cameraZoom(1)}>+</button>
        <span className="camera-control__sublabel">Circle</span>
        <button className="pad" onClick={() => mw.cameraRadius(-1)}>−</button>
        <button className="pad" onClick={() => mw.cameraRadius(1)}>+</button>
      </div>
    </div>
  );
}

/**
 * A range slider that tracks its value locally while dragging and only sends the
 * command on release, so the bridge isn't spammed on every pixel of movement.
 */
function CommitSlider({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const commit = () => {
    if (local != null) {
      onCommit(local);
      setLocal(null);
    }
  };
  return (
    <div className="camera-control camera-control--slider">
      {label && <span className="camera-control__label">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        value={shown}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="camera-control__value">{shown}</span>
    </div>
  );
}
