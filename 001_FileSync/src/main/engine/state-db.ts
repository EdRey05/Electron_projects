import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS state (
      path           TEXT PRIMARY KEY,
      side_a_size    INTEGER,
      side_a_mtime   INTEGER,
      side_a_hash    TEXT,
      side_b_size    INTEGER,
      side_b_mtime   INTEGER,
      side_b_hash    TEXT,
      last_synced_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS run_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      files_copied      INTEGER NOT NULL DEFAULT 0,
      files_deleted     INTEGER NOT NULL DEFAULT 0,
      conflicts         INTEGER NOT NULL DEFAULT 0,
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      status            TEXT,
      error             TEXT
    );

    CREATE TABLE IF NOT EXISTS run_action (
      run_id  INTEGER NOT NULL REFERENCES run_log(id) ON DELETE CASCADE,
      path    TEXT    NOT NULL,
      action  TEXT    NOT NULL,
      bytes   INTEGER NOT NULL DEFAULT 0,
      ok      INTEGER NOT NULL DEFAULT 1,
      message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_run_action_run_id ON run_action(run_id);
  `,
};

let sqlJsCache: SqlJsStatic | null = null;
async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsCache) return sqlJsCache;
  sqlJsCache = await initSqlJs();
  return sqlJsCache;
}

/**
 * StateDb wraps sql.js with the persistence model the rest of the engine
 * expects: an on-disk file that's atomically rewritten on `flush()`. sql.js
 * itself is in-memory, so we own the read-on-open and write-on-flush dance.
 */
export class StateDb {
  private constructor(
    private readonly path: string,
    private readonly db: SqlJsDatabase,
  ) {}

  static async open(path: string): Promise<StateDb> {
    const SQL = await loadSqlJs();
    mkdirSync(dirname(path), { recursive: true });
    const db = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
    db.exec("PRAGMA foreign_keys = ON;");
    const wrapper = new StateDb(path, db);
    wrapper.migrate();
    wrapper.flush();
    return wrapper;
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
    const res = this.db.exec("SELECT version FROM schema_meta LIMIT 1");
    let current = res[0]?.values[0]?.[0] as number | undefined;
    current = current ?? 0;
    const had = res[0]?.values.length === 1;

    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) throw new Error(`Missing migration for schema version ${v}`);
      this.db.exec(sql);
      current = v;
    }

    if (had) {
      const stmt = this.db.prepare("UPDATE schema_meta SET version = ?");
      stmt.run([current]);
      stmt.free();
    } else {
      const stmt = this.db.prepare("INSERT INTO schema_meta(version) VALUES (?)");
      stmt.run([current]);
      stmt.free();
    }
  }

  flush(): void {
    const data = this.db.export();
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, Buffer.from(data));
    renameSync(tmp, this.path);
  }

  close(): void {
    this.flush();
    this.db.close();
  }

  /** Internal handle for direct use by helper functions. Tests may need this too. */
  raw(): SqlJsDatabase {
    return this.db;
  }
}

export async function openStateDb(path: string): Promise<StateDb> {
  return StateDb.open(path);
}

function execRun(db: SqlJsDatabase, sql: string, params: unknown[]): void {
  const stmt = db.prepare(sql);
  stmt.run(params as never);
  stmt.free();
}

export function upsertSideA(s: StateDb, path: string, size: number, mtimeMs: number): void {
  execRun(
    s.raw(),
    `INSERT INTO state (path, side_a_size, side_a_mtime)
     VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       side_a_size  = excluded.side_a_size,
       side_a_mtime = excluded.side_a_mtime`,
    [path, size, mtimeMs],
  );
}

export function upsertSideB(s: StateDb, path: string, size: number, mtimeMs: number): void {
  execRun(
    s.raw(),
    `INSERT INTO state (path, side_b_size, side_b_mtime)
     VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       side_b_size  = excluded.side_b_size,
       side_b_mtime = excluded.side_b_mtime`,
    [path, size, mtimeMs],
  );
}

export interface StateRow {
  path: string;
  side_a_size: number | null;
  side_a_mtime: number | null;
  side_a_hash: string | null;
  side_b_size: number | null;
  side_b_mtime: number | null;
  side_b_hash: string | null;
  last_synced_at: number | null;
}

export function getState(s: StateDb, path: string): StateRow | undefined {
  const stmt = s.raw().prepare("SELECT * FROM state WHERE path = ?");
  stmt.bind([path]);
  let row: StateRow | undefined;
  if (stmt.step()) row = stmt.getAsObject() as unknown as StateRow;
  stmt.free();
  return row;
}

export function listStatePaths(s: StateDb): string[] {
  const out: string[] = [];
  const stmt = s.raw().prepare("SELECT path FROM state ORDER BY path");
  while (stmt.step()) out.push(stmt.getAsObject()["path"] as string);
  stmt.free();
  return out;
}

export function countState(s: StateDb): number {
  const stmt = s.raw().prepare("SELECT COUNT(*) AS n FROM state");
  stmt.step();
  const n = stmt.getAsObject()["n"] as number;
  stmt.free();
  return n;
}

export function transaction<T>(s: StateDb, fn: () => T): T {
  const db = s.raw();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
