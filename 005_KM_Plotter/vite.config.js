import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain Vite + React. Electron loads dist/index.html (production) or
// http://localhost:5173 (dev) — see electron/main.js.
export default defineConfig({
  plugins: [react()],
  base: "./", // important so the built bundle works under file:// in Electron
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
