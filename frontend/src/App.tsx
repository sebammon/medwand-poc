import { useState } from "react";
import type { SensorId } from "./bridge/protocol";
import { SensorPicker } from "./components/SensorPicker";
import { ThermometerPanel } from "./components/ThermometerPanel";
import { PulseOximeterPanel } from "./components/PulseOximeterPanel";
import { EcgPanel } from "./components/EcgPanel";
import { StethoscopePanel } from "./components/StethoscopePanel";
import { CameraPanel } from "./components/CameraPanel";
import { useMedWand } from "./hooks/useMedWand";

export function App() {
  const mw = useMedWand();
  const [selected, setSelected] = useState<SensorId | null>(null);
  const connected = mw.state?.device === "connected";

  const selectSensor = (sensor: SensorId) => {
    // Only one sensor runs at a time — stop the active one before switching.
    if (mw.state?.activeSensor && mw.state.activeSensor.sensor !== sensor) mw.stopSensor();
    setSelected(sensor);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1 className="header__title">MedWand POC</h1>
          <p className="header__subtitle">
            {mw.native ? "Android shell" : "Browser mock"} · WebMessageListener bridge
          </p>
        </div>
        <div className="header__status">
          <span className={`badge badge--${connected ? "on" : "off"}`}>
            {mw.state ? mw.state.device : "…"}
          </span>
          {connected ? (
            <button className="link" onClick={mw.disconnect}>
              Disconnect
            </button>
          ) : (
            <button className="action action--start header__connect" onClick={mw.connect}>
              Connect
            </button>
          )}
        </div>
      </header>

      {mw.error && (
        <div className="toast" role="alert">
          <span>
            <strong>{mw.error.code}</strong> — {mw.error.message}
          </span>
          <button className="toast__close" onClick={mw.clearError}>
            ✕
          </button>
        </div>
      )}

      {!connected ? (
        <main className="hero">
          <p>
            {mw.state?.device === "attached"
              ? "MedWand detected — tap Connect."
              : mw.state?.device === "connecting"
                ? "Connecting…"
                : "Plug in the MedWand to begin."}
          </p>
        </main>
      ) : (
        <main className="content">
          <SensorPicker state={mw.state!} selected={selected} onSelect={selectSensor} />
          <div className="stage">
            {selected === "thermometer" && <ThermometerPanel mw={mw} />}
            {selected === "pulseOximeter" && <PulseOximeterPanel mw={mw} />}
            {selected === "ecg" && <EcgPanel mw={mw} />}
            {selected === "stethoscope" && <StethoscopePanel mw={mw} />}
            {selected === "camera" && <CameraPanel mw={mw} />}
            {!selected && <p className="hint hint--center">Select a sensor to begin.</p>}
          </div>

          <details className="debug" open>
            <summary>Raw reading (debug)</summary>
            <pre className="debug__json">
              {mw.reading ? JSON.stringify(mw.reading, null, 2) : "No reading yet."}
            </pre>
          </details>

          {mw.state?.deviceInfo.udi && (
            <footer className="device-info">
              {mw.state.deviceInfo.generation} · FW {mw.state.deviceInfo.firmwareVersion} · {mw.state.deviceInfo.udi}
            </footer>
          )}
        </main>
      )}
    </div>
  );
}
