import type { ReactNode } from "react";

/** Green "Start" / red "Stop" action button shared by the sensor panels. */
export function StartStopButton({
  running,
  startLabel = "Start",
  stopLabel = "Stop",
  disabled,
  onStart,
  onStop,
}: {
  running: boolean;
  startLabel?: string;
  stopLabel?: string;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <button
      className={`action ${running ? "action--stop" : "action--start"}`}
      disabled={disabled}
      onClick={running ? onStop : onStart}
    >
      {running ? stopLabel : startLabel}
    </button>
  );
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel__title">{title}</h2>
      {children}
    </section>
  );
}

export function BigReading({ value, unit, label }: { value: string; unit?: string; label?: string }) {
  return (
    <div className="reading">
      {label && <span className="reading__label">{label}</span>}
      <span className="reading__value">{value}</span>
      {unit && <span className="reading__unit">{unit}</span>}
    </div>
  );
}
