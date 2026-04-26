import { useState } from "react";
import type { ConflictPolicy, Job } from "@shared/types";
import { Button } from "../components/Button";
import { Field, NumberInput, TextArea, TextInput } from "../components/Field";

const POLICIES: { value: ConflictPolicy; label: string; help: string }[] = [
  {
    value: "newer-wins",
    label: "Newer wins (recommended)",
    help: "Whichever side has the more recent mtime wins. Loser is sent to .filesync-trash/.",
  },
  {
    value: "rename-both",
    label: "Rename both",
    help: "Both versions are kept side-by-side with .A.<timestamp> / .B.<timestamp> suffixes.",
  },
  {
    value: "ask",
    label: "Ask each time",
    help: "Conflicts are surfaced in the run view and you decide per file.",
  },
];

function defaultDraft(initial?: Job): Job {
  if (initial) return initial;
  return {
    id: "",
    name: "",
    sideA: "",
    sideB: "",
    filters: { include: [], exclude: [".filesync-trash/", "node_modules/", ".git/"] },
    onConflict: "newer-wins",
    trash: { enabled: true, retainDays: 30 },
    followSymlinks: false,
    preserveTimestamps: true,
  };
}

export function JobBuilder({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Job;
  onSaved(job: Job): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<Job>(defaultDraft(initial));
  const [includeText, setIncludeText] = useState(draft.filters.include.join("\n"));
  const [excludeText, setExcludeText] = useState(draft.filters.exclude.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patch<K extends keyof Job>(key: K, val: Job[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  async function pickFolder(side: "sideA" | "sideB") {
    const picked = await window.api.dialog.openDirectory();
    if (picked) patch(side, picked);
  }

  async function handleSave() {
    setError(null);
    setBusy(true);
    try {
      const include = includeText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const exclude = excludeText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const payload: Partial<Job> = {
        ...draft,
        // Don't send empty id for new jobs — let the store assign one.
        id: draft.id || undefined,
        filters: { include, exclude },
      };
      const saved = await window.api.jobs.upsert(payload);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {initial ? "Edit job" : "New job"}
        </h1>
      </header>

      <div className="space-y-5">
        <Field label="Name">
          <TextInput
            value={draft.name}
            onChange={(e) => patch("name", e.target.value)}
            placeholder="e.g. Photos backup"
          />
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Side A folder">
            <div className="flex gap-2">
              <TextInput
                value={draft.sideA}
                onChange={(e) => patch("sideA", e.target.value)}
                placeholder="C:\path\to\folder"
              />
              <Button onClick={() => pickFolder("sideA")}>Browse</Button>
            </div>
          </Field>
          <Field label="Side B folder">
            <div className="flex gap-2">
              <TextInput
                value={draft.sideB}
                onChange={(e) => patch("sideB", e.target.value)}
                placeholder="D:\path\to\folder"
              />
              <Button onClick={() => pickFolder("sideB")}>Browse</Button>
            </div>
          </Field>
        </div>

        <Field
          label="Conflict policy"
          hint="What to do when both sides changed the same file since the last run."
        >
          <div className="space-y-2">
            {POLICIES.map((p) => (
              <label key={p.value} className="flex gap-3 items-start cursor-pointer">
                <input
                  type="radio"
                  name="policy"
                  value={p.value}
                  checked={draft.onConflict === p.value}
                  onChange={() => patch("onConflict", p.value)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm text-slate-200">{p.label}</span>
                  <span className="block text-xs text-slate-500">{p.help}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Trash retention (days)" hint="Files trashed during sync are kept for this long.">
            <div className="flex gap-2 items-center">
              <input
                type="checkbox"
                checked={draft.trash.enabled}
                onChange={(e) =>
                  patch("trash", { ...draft.trash, enabled: e.target.checked })
                }
              />
              <NumberInput
                disabled={!draft.trash.enabled}
                min={0}
                max={3650}
                value={draft.trash.retainDays}
                onChange={(e) =>
                  patch("trash", {
                    ...draft.trash,
                    retainDays: Number(e.target.value) || 0,
                  })
                }
              />
            </div>
          </Field>
          <Field label="Other options">
            <label className="flex gap-2 items-center text-sm">
              <input
                type="checkbox"
                checked={draft.followSymlinks}
                onChange={(e) => patch("followSymlinks", e.target.checked)}
              />
              <span>Follow symbolic links</span>
            </label>
            <label className="flex gap-2 items-center text-sm mt-1">
              <input
                type="checkbox"
                checked={draft.preserveTimestamps}
                onChange={(e) => patch("preserveTimestamps", e.target.checked)}
              />
              <span>Preserve timestamps on copy</span>
            </label>
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Include patterns"
            hint="One gitignore-style glob per line. Empty = include everything."
          >
            <TextArea
              value={includeText}
              onChange={(e) => setIncludeText(e.target.value)}
              placeholder="**/*.md"
            />
          </Field>
          <Field
            label="Exclude patterns"
            hint="Always-applied. Defaults skip trash, node_modules, .git."
          >
            <TextArea
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
            />
          </Field>
        </div>

        {error && (
          <div className="rounded-md border border-red-700/60 bg-red-900/30 p-3 text-sm text-red-200 whitespace-pre-wrap">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
