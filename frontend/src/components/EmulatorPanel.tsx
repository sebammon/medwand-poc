/**
 * Floating dev panel for the browser emulator. It drives the emulated device by its
 * *physical* inputs (the cable, what the thermometer is aimed at, the finger on the
 * pulse oximeter), so the app can be exercised as if real hardware were attached,
 * and reads back what the emulator is putting on the wire.
 *
 * Renders nothing unless the emulator is installed, so it is inert in the Android
 * shell and absent from production builds. Toggle with Ctrl/Cmd+Shift+9.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { getMedWandEmulator } from "../bridge/emulator";
import type {
  EmulatorHandle,
  FingerState,
  FrameTransport,
  ThermometerTarget,
} from "../bridge/emulator";
import type { Capture } from "../bridge/protocol";

const PANEL_ROOT_ID = "medwand-emulator-panel";

interface Option<T extends string> {
  value: T;
  label: string;
}

const TARGETS: Option<ThermometerTarget>[] = [
  { value: "off", label: "Nothing" },
  { value: "on", label: "Forehead" },
  { value: "high", label: "Hot surface" },
];

const FINGERS: Option<FingerState>[] = [
  { value: "out", label: "None" },
  { value: "in", label: "Steady" },
  { value: "moving", label: "Moving" },
];

const TRANSPORTS: Option<FrameTransport>[] = [
  { value: "base64", label: "base64" },
  { value: "binary", label: "binary" },
];

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="emu__row">
      {options.map((option) => (
        <button
          key={option.value}
          className={`emu__choice${option.value === value ? " emu__choice--active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="emu__group">
      <span className="emu__label">{label}</span>
      {children}
    </div>
  );
}

function usbPermissionLabel(granted: boolean | null): string {
  if (granted === null) return "not asked yet";

  return granted ? "granted" : "denied";
}

/** Base64 inflates by a third, so this is the artifact's own size, roughly. */
function captureLabel(capture: Capture): string {
  const bytes = (capture.dataUri.length - capture.dataUri.indexOf(",") - 1) * 0.75;
  const mode = capture.mode ? ` · ${capture.mode}` : "";

  return `${capture.sensor}${mode} · ~${Math.round(bytes / 1024)} KB`;
}

// Split out so the store subscription only mounts once an emulator is running.
function Controls({ emulator }: { emulator: EmulatorHandle }) {
  const view = useSyncExternalStore(emulator.subscribe, emulator.getSnapshot);
  const { physical } = view;

  return (
    <section className="emu">
      <header className="emu__header">
        <strong>MedWand emulator</strong>
        <span className="emu__hint">⌘⇧9</span>
      </header>

      <Group label="Device">
        <Choice
          value={physical.attached ? "attached" : "detached"}
          options={[
            { value: "attached", label: "Plugged in" },
            { value: "detached", label: "Unplugged" },
          ]}
          onChange={(next) =>
            emulator.input({ type: next === "attached" ? "attach" : "detach" })
          }
        />
      </Group>

      <Group label="Thermometer aimed at">
        <Choice
          value={physical.target}
          options={TARGETS}
          onChange={(value) => emulator.input({ type: "target", value })}
        />
      </Group>

      <Group label="Pulse ox finger">
        <Choice
          value={physical.finger}
          options={FINGERS}
          onChange={(value) => emulator.input({ type: "finger", value })}
        />
      </Group>

      <Group label="Camera frame transport">
        <Choice
          value={view.transport}
          options={TRANSPORTS}
          onChange={(value) => emulator.input({ type: "transport", value })}
        />
      </Group>

      <div className="emu__readout">
        <span>{`device: ${view.device}`}</span>
        <span>{`reading: ${view.reading}`}</span>
        <span>{`active sensor: ${view.activeSensor ?? "none"}`}</span>
        <span>{`usb permission: ${usbPermissionLabel(view.usbPermission)}`}</span>
        {view.pulseOxStatus !== null && (
          <span>{`pulse ox: ${view.pulseOxStatus || "(streaming)"}`}</span>
        )}
        {view.lastCapture && <span>{`last capture: ${captureLabel(view.lastCapture)}`}</span>}
      </div>

      {view.lastReading && (
        <div className="emu__readout">
          <span className="emu__label">{`last ${view.lastReading.sensor} reading`}</span>
          {Object.entries(view.lastReading.reading)
            .filter(([, value]) => value !== null)
            .map(([field, value]) => (
              <span key={field}>{`${field}: ${String(value).slice(0, 60)}`}</span>
            ))}
        </div>
      )}
    </section>
  );
}

function EmulatorPanel() {
  const emulator = getMedWandEmulator();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.code !== "Digit9") return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!emulator) return null;

  if (!open) {
    return (
      <button className="emu-toggle" onClick={() => setOpen(true)}>
        MedWand ⌘⇧9
      </button>
    );
  }

  return <Controls emulator={emulator} />;
}

/**
 * Mounts the panel into its own React root, outside the app tree, so it cannot
 * affect app rendering. Call after `installMedWandEmulator`.
 */
export function mountEmulatorPanel(): void {
  if (document.getElementById(PANEL_ROOT_ID)) return;

  const host = document.createElement("div");
  host.id = PANEL_ROOT_ID;
  document.body.appendChild(host);
  createRoot(host).render(<EmulatorPanel />);
}
