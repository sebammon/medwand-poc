import { useState } from "react";
import type { StethMode } from "../bridge/protocol";
import type { MedWand } from "../hooks/useMedWand";
import { Panel, StartStopButton } from "./ui";

const MODES: { id: StethMode; label: string }[] = [
  { id: "heart", label: "Heart" },
  { id: "lungs", label: "Lungs" },
  { id: "bowel", label: "Bowel" },
];

export function StethoscopePanel({ mw }: { mw: MedWand }) {
  const running = mw.state?.activeSensor?.sensor === "stethoscope";
  const recording = mw.state?.reading === "recording";
  // The stethoscope pushes no readings, so track the chosen mode locally.
  const [mode, setMode] = useState<StethMode | null>(null);
  const capture = mw.capture?.sensor === "stethoscope" ? mw.capture : null;

  const pickMode = (next: StethMode) => {
    setMode(next);
    mw.startSensor("stethoscope", { stethMode: next }); // starts live auscultation on the device
  };

  return (
    <Panel title="Stethoscope">
      <p className="hint">
        Pick a mode to start live auscultation (audio plays on the device speaker), then record a clip.
      </p>

      <div className="modes">
        {MODES.map((option) => (
          <button
            key={option.id}
            className={`mode${mode === option.id && running ? " mode--active" : ""}`}
            disabled={recording}
            onClick={() => pickMode(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="controls">
        <StartStopButton
          running={recording}
          startLabel="Start recording"
          stopLabel="Stop recording"
          disabled={!running}
          onStart={mw.startRecording}
          onStop={mw.stopRecording}
        />
        <button
          className="action action--neutral"
          disabled={!running || recording}
          onClick={() => {
            setMode(null);
            mw.stopSensor();
          }}
        >
          Stop
        </button>
      </div>

      {capture && (
        <figure className="capture">
          <figcaption className="hint">
            Recorded clip{capture.mode ? ` · ${capture.mode}` : ""}
          </figcaption>
          <audio className="capture__audio" src={capture.dataUri} controls />
        </figure>
      )}
    </Panel>
  );
}
