const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const NAMES = new Set(['UniVec', 'UniVec_Core']);
const TTL = 7 * 24 * 60 * 60 * 1000;
const digest = data => createHash('sha256').update(data).digest('hex');

function download({ which, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://ftp.ncbi.nlm.nih.gov/pub/UniVec/${which}`, { headers: { 'User-Agent': 'SequenceBindingFinder/1.2.0', Accept: 'text/plain' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error(`NCBI returned HTTP ${response.statusCode}.`)); return; }
      const parts = []; let bytes = 0, last = 0;
      response.on('data', part => {
        bytes += part.length;
        if (bytes > 64 * 1024 * 1024) { response.destroy(Error('NCBI response exceeds 64 MB.')); return; }
        parts.push(part);
        if (Date.now() - last > 100) { onProgress({ bytes, total: Number(response.headers['content-length']) || null }); last = Date.now(); }
      });
      response.on('error', reject);
      response.on('end', () => { onProgress({ bytes, total: bytes }); resolve(Buffer.concat(parts).toString('utf8')); });
    });
    request.setTimeout(30000, () => request.destroy(Error('NCBI download timed out.')));
    request.on('error', reject);
  });
}

function createUnivecService(cacheDirectory, { fetchText = download, now = Date.now } = {}) {
  const pending = new Map();
  async function cached(which) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(cacheDirectory, `${which}.json`), 'utf8'));
      const fasta = await fs.readFile(path.join(cacheDirectory, which), 'utf8');
      if (metadata.source !== which || metadata.sha256 !== digest(fasta) || !Number.isFinite(metadata.fetchedAt) || metadata.fetchedAt > now() || !fasta.startsWith('>')) return null;
      return { ...metadata, fasta, cached: true };
    } catch { return null; }
  }
  async function fetch({ which, force = false, onProgress = () => {} }) {
    if (!NAMES.has(which)) throw Error('Choose UniVec or UniVec_Core.');
    const old = await cached(which);
    if (!force && old && now() - old.fetchedAt < TTL) return old;
    if (pending.has(which)) return pending.get(which);
    const task = (async () => {
      try {
        const fasta = await fetchText({ which, onProgress });
        const entryCount = (fasta.match(/^>/gm) || []).length;
        if (!fasta.startsWith('>') || !entryCount || fasta.includes('\uFFFD')) throw Error('NCBI returned invalid FASTA data.');
        const metadata = { source: which, entryCount, bytes: Buffer.byteLength(fasta, 'utf8'), fetchedAt: now(), sha256: digest(fasta) };
        await fs.mkdir(cacheDirectory, { recursive: true });
        for (const [name, text] of [[which, fasta], [`${which}.json`, JSON.stringify(metadata)]]) {
          const target = path.join(cacheDirectory, name), temporary = `${target}.${randomUUID()}.tmp`;
          try { await fs.writeFile(temporary, text, 'utf8'); await fs.rename(temporary, target); }
          finally { await fs.rm(temporary, { force: true }); }
        }
        return { ...metadata, fasta, cached: false };
      } catch (error) {
        if (old) return { ...old, warning: `Refresh failed: ${error.message} Using the cached snapshot.` };
        throw error;
      }
    })();
    pending.set(which, task);
    try { return await task; } finally { pending.delete(which); }
  }
  return { fetch };
}
module.exports = { createUnivecService, TTL };
