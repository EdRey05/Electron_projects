// The renderer and main process share these defaults. Python validates the final argv.
const advancedDefaults = require('./advanced-defaults.json');

const booleanFlags = {
  resolvePeaks: ['--resolve-peaks', '--no-resolve-peaks'],
  recallLowQuality: ['--recall-low-quality', '--no-recall-low-quality'],
  baselineSmooth: ['--baseline-smooth', '--no-baseline-smooth'],
  leadDropEnabled: ['--lead-drop-enabled', '--no-lead-drop'],
  setAbiLimits: ['--set-abi-limits', '--no-set-abi-limits'],
  stripWellId: ['--strip-well-id', '--no-strip-well-id'],
  doSmooth: ['--do-smooth', '--no-do-smooth'],
  writeSidecarTrace: ['--write-sidecar-trace', '--no-write-sidecar-trace'],
};
const numberFlags = {
  resolutionStrength: '--resolution-strength', resolutionIterations: '--resolution-iterations',
  leadDropQv: '--lead-drop-qv', skipShorterThan: '--skip-shorter-than',
  smoothWindow: '--smooth-window', qvToNThreshold: '--qv-to-n-threshold',
};

function advancedArgs(values = {}) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (key in booleanFlags) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
      args.push(booleanFlags[key][value ? 0 : 1]);
    } else if (key in numberFlags) {
      if (value === '' || !Number.isFinite(Number(value))) throw new Error(`${key} must be numeric`);
      args.push(numberFlags[key], String(value));
    } else throw new Error(`Unknown advanced setting: ${key}`);
  }
  return args;
}

module.exports = { advancedDefaults, advancedArgs };
