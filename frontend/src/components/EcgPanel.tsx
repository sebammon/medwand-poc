import { useEffect, useRef } from "react";
import { parseEcgData } from "../bridge/protocol";
import type { MedWand } from "../hooks/useMedWand";
import { Panel, StartStopButton } from "./ui";

const MAX_SAMPLES = 1000;

export function EcgPanel({ mw }: { mw: MedWand }) {
  const running = mw.state?.activeSensor?.sensor === "ecg";
  const recording = mw.state?.reading === "recording";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<number[]>([]);
  const lastReadingRef = useRef<unknown>(null);
  const capture = mw.capture?.sensor === "ecg" ? mw.capture : null;

  // Clear the rolling waveform whenever monitoring (re)starts.
  useEffect(() => {
    if (running) bufferRef.current = [];
  }, [running]);

  // Append each reading's dimensionless samples and redraw the live trace.
  useEffect(() => {
    const event = mw.reading;
    if (!event || event === lastReadingRef.current) return;
    if (event.sensor !== "ecg") return;
    lastReadingRef.current = event;

    const samples = parseEcgData(event.reading.ecgData);
    if (samples.length === 0) return;

    const buffer = bufferRef.current;
    buffer.push(...samples);
    if (buffer.length > MAX_SAMPLES) buffer.splice(0, buffer.length - MAX_SAMPLES);
    drawTrace(canvasRef.current, buffer);
  }, [mw.reading]);

  return (
    <Panel title="ECG">
      {capture ? (
        <figure className="capture">
          <figcaption className="hint">Captured strip</figcaption>
          <img className="capture__img" src={capture.dataUri} alt="Captured ECG strip" />
        </figure>
      ) : (
        <canvas ref={canvasRef} className="ecg-canvas" width={900} height={260} />
      )}

      <div className="controls">
        <StartStopButton
          running={running}
          startLabel="Start monitoring"
          stopLabel="Stop monitoring"
          onStart={() => mw.startSensor("ecg")}
          onStop={mw.stopSensor}
        />
        <StartStopButton
          running={recording}
          startLabel="Start recording"
          stopLabel="Stop recording"
          disabled={!running}
          onStart={mw.startRecording}
          onStop={mw.stopRecording}
        />
      </div>
    </Panel>
  );
}

function drawTrace(canvas: HTMLCanvasElement | null, samples: number[]) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;

  ctx.fillStyle = "#fff7f7";
  ctx.fillRect(0, 0, width, height);

  // Light ECG-paper grid.
  ctx.strokeStyle = "#f3d6d6";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 30) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += 30) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  const shown = samples.slice(-width);
  if (shown.length < 2) return;

  // Autoscale the dimensionless values into the canvas with a little padding.
  let min = Infinity;
  let max = -Infinity;
  for (const value of shown) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min || 1;
  const pad = height * 0.1;

  ctx.strokeStyle = "#c0392b";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  shown.forEach((value, i) => {
    const x = (i / (shown.length - 1)) * width;
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
