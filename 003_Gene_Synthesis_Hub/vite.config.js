import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",                 // MANDATORY: built bundle must work under file://
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
