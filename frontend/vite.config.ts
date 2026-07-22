import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build is served from inside the WebView by WebViewAssetLoader, so assets
// must be referenced relatively (`base: "./"`). Output goes straight into the
// Android app's assets so a `vite build` refreshes the shell's bundled web app.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../android/app/src/main/assets",
    emptyOutDir: true,
  },
});
