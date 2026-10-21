// End-to-end test driver.
//
// Loaded only when the app is started with KM_E2E_TEST=1. It drives the real
// IPC handlers (the same code path the renderer uses) and writes a JSON
// report to KM_E2E_REPORT, so the whole stack — main process, job protocol,
// bundled Python, Excel export, file writing — is exercised for real.
//
//   set KM_E2E_TEST=1
//   set KM_E2E_REPORT=C:\path\to\report.json
//   set KM_E2E_PICK_FILES=["C:\data\clinical.txt"]
//   set KM_E2E_SAVE_PATH=C:\path\to\out.xlsx
//   npm start

const fs = require("fs");
const path = require("path");

const report = { checks: [], ok: null, error: null };

function check(name, cond, detail = "") {
  report.checks.push({ name, pass: !!cond, detail: String(detail) });
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name} ${detail}`);
}

function writeReport() {
  report.ok = report.checks.length > 0 && report.checks.every((c) => c.pass);
  try {
    if (process.env.KM_E2E_REPORT) {
      fs.writeFileSync(process.env.KM_E2E_REPORT, JSON.stringify(report, null, 2), "utf8");
    }
  } catch (e) {
    console.error("Could not write the E2E report:", e.message);
  }
}

// Call an IPC handler the same way the renderer does.
function invoke(channel, payload) {
  const { ipcMain } = require("electron");
  const handlers = ipcMain._invokeHandlers || ipcMain._handlers;
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({ sender: null }, payload);
}

async function runE2E() {
  const clinicalPath =
    "C:\\Users\\Administrator\\Desktop\\Github_EdRey05\\Streamlit_projects\\Test_units\\Project 003\\clinical_synthetic.txt";

  try {
    // 1. Pick + inspect the clinical file (the real picker path).
    const picked = await invoke("dialog:pickFile", {
      title: "clinical",
      filters: [{ name: "Text/TSV", extensions: ["txt"] }],
    });
    check("picker returns a file", !!picked && !!picked.path, picked && picked.name);
    const path_ = picked ? picked.path : clinicalPath;

    const ins = await invoke("km:run", { command: "inspect", clinicalPath: path_ });
    check("inspect ok", ins.ok, ins.error || "");
    check("rows loaded", ins.clinical && ins.clinical.nRows === 1000, ins.clinical && ins.clinical.nRows);
    check("OS_MONTHS offered", ins.options.timeToEventOptions.includes("OS_MONTHS"));
    check("OS_STATUS offered", ins.options.eventObservationOptions.includes("OS_STATUS"));

    // 2. Column inspection (drives the 0/1 mapping table).
    const col = await invoke("km:run", { command: "column", path: path_, column: "OS_STATUS" });
    check("column ok", col.ok, col.error || "");
    check("two distinct event values", col.values && col.values.length === 2,
      col.values ? col.values.map((v) => `${v.label}(${v.count})`).join(",") : "none");

    // 3. Analyze, no subgroups.
    const an = await invoke("km:run", {
      command: "analyze",
      clinicalPath: path_,
      timeColumn: "OS_MONTHS",
      eventColumn: "OS_STATUS",
      noEventValues: ["Alive"],
      eventValues: ["Dead"],
      variables: [],
      alpha: 0.05,
    });
    check("analyze ok", an.ok, an.error || "");
    if (an.ok) {
      const c = an.result.curves[0];
      check("one curve", an.result.nCurves === 1);
      check("n=1000", c.n === 1000, c.n);
      check("events=429", c.nEvents === 429, c.nEvents);
      check("median = 40.68605213188546", c.median === 40.68605213188546, c.median);
      check("timeline has points", c.timeline.length === 864, c.timeline.length);
      check("CI bounds present", c.lower.length === c.timeline.length && c.upper.length === c.timeline.length);
      check("at-risk table", c.atRisk.length === 6, c.atRisk.length);
      check("survival starts at 1", c.survival[0] === 1, c.survival[0]);
      check("survival is non-increasing",
        c.survival.every((v, i) => i === 0 || v <= c.survival[i - 1] + 1e-12));
      check("lower <= survival <= upper",
        c.survival.every((v, i) => v >= c.lower[i] - 1e-9 && v <= c.upper[i] + 1e-9));
    }

    // 4. Analyze with tag subgroups.
    const sub = await invoke("km:run", {
      command: "analyze",
      clinicalPath: path_,
      timeColumn: "OS_MONTHS",
      eventColumn: "OS_STATUS",
      noEventValues: ["Alive"],
      eventValues: ["Dead"],
      variables: [
        {
          source: "clinical",
          column: "S1",
          mode: "tags",
          groups: [
            { values: ["Treatment_A"], name: "A" },
            { values: ["Treatment_B"], name: "B" },
            { values: ["Treatment_C"], name: "C" },
          ],
        },
      ],
      alpha: 0.05,
    });
    check("subgroup analyze ok", sub.ok, sub.error || "");
    if (sub.ok) {
      check("3 curves", sub.result.nCurves === 3, sub.result.nCurves);
      const b = sub.result.curves.find((x) => x.label === "B");
      check("B median matches lifelines", b && b.median === 38.00176122148873, b && b.median);
      check("curves are labelled", sub.result.curves.map((c) => c.label).join(",") === "A,B,C");
    }

    // 5. Excel export + write to disk.
    const savePath = process.env.KM_E2E_SAVE_PATH;
    if (savePath) {
      const exp = await invoke("km:run", {
        command: "export",
        clinicalPath: path_,
        timeColumn: "OS_MONTHS",
        eventColumn: "OS_STATUS",
        noEventValues: ["Alive"],
        eventValues: ["Dead"],
        variables: [],
        alpha: 0.05,
        filename: "KM_results.xlsx",
      });
      check("export ok", exp.ok, exp.error || "");
      if (exp.ok) {
        const target = await invoke("dialog:saveFile", { title: "xlsx", defaultName: "KM_results.xlsx" });
        check("save path returned", !!target, target);
        const wrote = await invoke("file:writeBytes", { filePath: target, base64: exp.base64 });
        check("file written", wrote === true);
        check("file exists", fs.existsSync(target), fs.existsSync(target) ? fs.statSync(target).size + " bytes" : "missing");
        if (fs.existsSync(target)) {
          const head = fs.readFileSync(target).slice(0, 2).toString();
          check("xlsx magic bytes", head === "PK", head);
        }
      }
    }

    // 6. Error path.
    const bad = await invoke("km:run", {
      command: "analyze",
      clinicalPath: path_,
      timeColumn: "OS_MONTHS",
      eventColumn: "OS_STATUS",
      noEventValues: [],
      eventValues: [],
      variables: [],
      alpha: 0.05,
    });
    check("empty mapping is rejected", bad.ok === false, bad.error || "");
  } catch (e) {
    report.error = e.stack || e.message;
    console.error("E2E driver crashed:", e);
  } finally {
    writeReport();
    setTimeout(() => {
      require("electron").app.quit();
    }, 300);
  }
}

module.exports = { runE2E };
