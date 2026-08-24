#!/usr/bin/env node
/**
 * `npm start` — run the already-built React UI in Electron without needing
 * a Vite dev server. Sets NODE_ENV=production so `main.js` loads the
 * bundled `dist/index.html` instead of `http://localhost:5173`.
 *
 * Use `npm run dev` for hot-reload development. Use `npm run start:dev`
 * to run electron against the dist/ bundle without the dev server.
 */
const { spawn } = require("child_process");
const path = require("path");

const electronBin = require("electron"); // string path to the binary

const child = spawn(electronBin, ["."], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
child.on("exit", (code) => process.exit(code ?? 0));
