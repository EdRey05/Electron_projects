import { analyzeEntry } from "./search.mjs";

self.onmessage = ({ data }) => {
  const { requestId, entries, pasted, mode, threshold } = data;
  const started = performance.now(); let last = started; const results = [];
  try {
    self.postMessage({ type: "progress", requestId, done: 0, total: entries.length });
    for (let i = 0; i < entries.length; i++) {
      results.push(analyzeEntry(entries[i], pasted, mode, threshold, () => {
        const now = performance.now();
        if (now - last >= 100) { self.postMessage({ type: "progress", requestId, done: i, total: entries.length }); last = now; }
      }));
      const now = performance.now();
      if (now - last >= 100 || i === entries.length - 1) {
        self.postMessage({ type: "progress", requestId, done: i + 1, total: entries.length }); last = now;
      }
    }
    self.postMessage({ type: "complete", requestId, results, elapsedMs: performance.now() - started });
  } catch (error) { self.postMessage({ type: "error", requestId, message: error.message }); }
};
