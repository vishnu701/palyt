// Append-only JSONL record store. One line per record; an update appends the record again
// (same record_id) and the last occurrence wins on replay. No database on purpose (SPEC §3).
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LogRecord } from "../../contracts/protocol";
import type { RecordStore } from "../../contracts/interfaces";

export class JsonlStore implements RecordStore {
  private readonly path: string;
  private ready: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, "records.jsonl");
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    return this.ready;
  }

  async append(r: LogRecord): Promise<void> {
    await this.ensureDir();
    await appendFile(this.path, JSON.stringify(r) + "\n");
  }

  async update(r: LogRecord): Promise<void> {
    await this.append(r);
  }

  async all(): Promise<LogRecord[]> {
    const f = Bun.file(this.path);
    if (!(await f.exists())) return [];
    const byId = new Map<string, LogRecord>();
    for (const line of (await f.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = LogRecord.parse(JSON.parse(line));
        byId.set(rec.record_id, rec);
      } catch (err) {
        console.warn("[store] skipping bad line:", (err as Error).message);
      }
    }
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

export class MemoryStore implements RecordStore {
  records = new Map<string, LogRecord>();
  async append(r: LogRecord) { this.records.set(r.record_id, r); }
  async update(r: LogRecord) { this.records.set(r.record_id, r); }
  async all() { return [...this.records.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)); }
}
