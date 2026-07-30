import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function mount(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Development only: stand in for the native bridge so the app runs in a plain
// browser, and mount the panel that drives it. Both are dynamic imports behind
// `import.meta.env.DEV`, so neither reaches the production bundle that ships inside
// the Android shell. The emulator has to be installed before the app renders, since
// useMedWand reads window.MedWand on its first render.
if (import.meta.env.DEV) {
  void (async () => {
    const [{ installMedWandEmulator }, { mountEmulatorPanel }] = await Promise.all([
      import("./bridge/emulator"),
      import("./components/EmulatorPanel"),
    ]);
    installMedWandEmulator();
    mount();
    mountEmulatorPanel();
  })();
} else {
  mount();
}
