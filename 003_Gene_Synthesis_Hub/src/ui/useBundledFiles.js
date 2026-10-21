import { useEffect, useState } from "react";

/**
 * Resolve the bundled template / database files a subapp needs.
 *
 * The hub passes patterns down from `app_information.txt`
 * (e.g. `Sequencing_order_form_v*.xlsx`). The main process globs the newest
 * match inside `python-app/Templates` / `python-app/Databases` — the exact
 * same file the Python launch path would pick, so both routes stay in sync.
 *
 * Returns `{ templatePath, dbPath, resolved }`:
 *   - `templatePath` — the first resolved template (by kwarg name order)
 *   - `dbPath`      — the first resolved database
 *   - `resolved`    — the full { kwarg: absolutePath } map
 */
export function useBundledFiles(templatePatterns, dbPatterns) {
  const [state, setState] = useState({
    templatePath: "",
    dbPath: "",
    resolved: { templates: {}, databases: {} },
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    const hasTemplates = templatePatterns && Object.keys(templatePatterns).length > 0;
    const hasDbs = dbPatterns && Object.keys(dbPatterns).length > 0;
    if (!hasTemplates && !hasDbs) {
      setState({ templatePath: "", dbPath: "", resolved: { templates: {}, databases: {} }, loading: false });
      return;
    }

    const resolve = async () => {
      try {
        const pairs = (m) =>
          Object.entries(m || {}).map(([kwarg, pattern]) => `${kwarg}:${pattern}`);
        const out = await window.api.resolveBundledFiles({
          templates: pairs(templatePatterns),
          databases: pairs(dbPatterns),
        });
        if (cancelled) return;
        const tplEntries = Object.entries(out?.templates || {});
        const dbEntries = Object.entries(out?.databases || {});
        setState({
          templatePath: tplEntries.length ? tplEntries[0][1] : "",
          dbPath: dbEntries.length ? dbEntries[0][1] : "",
          resolved: out || { templates: {}, databases: {} },
          loading: false,
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            templatePath: "",
            dbPath: "",
            resolved: { templates: {}, databases: {} },
            loading: false,
            error: err?.message,
          });
        }
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [templatePatterns, dbPatterns]);

  return state;
}
