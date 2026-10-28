import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzeProgressEvent, DryRunRequest } from "@shared/api";

/** Own the subscription before invoking IPC, and ignore other/older scans. */
export function useAnalysis() {
  const [progress, setProgress] = useState<AnalyzeProgressEvent | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const unsubscribe = useRef<(() => void) | null>(null);
  const active = useRef<string | null>(null);

  useEffect(() => () => {
    active.current = null;
    unsubscribe.current?.();
  }, []);

  const analyze = useCallback(async (req: DryRunRequest) => {
    unsubscribe.current?.();
    const requestId = crypto.randomUUID();
    active.current = requestId;
    setStartedAt(Date.now());
    setProgress(null);
    const stop = window.api.engine.onAnalyzeProgress(update => {
      if (active.current === requestId && update.requestId === requestId) setProgress(update);
    });
    unsubscribe.current = stop;
    try {
      return await window.api.engine.dryRun({ ...req, requestId });
    } finally {
      stop();
      if (active.current === requestId) {
        active.current = null;
        unsubscribe.current = null;
      }
    }
  }, []);

  return { analyze, progress, startedAt };
}
