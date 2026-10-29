import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shared, secret-free health for same-user processes on one machine.
 *
 * Scope keys follow the router's identities: `provider` (service-wide),
 * `provider#account` (account-wide) and `provider/model[#account]` (model).
 * Every write runs in a BEGIN IMMEDIATE transaction; a monotonically increasing
 * revision fences observations so an older result cannot clear newer health.
 */

const SCHEMA_VERSION = 1;
const LEASE_MS = 60_000;

/** Error-derived causes. Tracker quota is written only through `reconcileTrackerQuota`. */
export type ErrorCauseKind = "transient" | "rate" | "quota" | "auth";
/** Cause kinds this store records; `tracker-quota` is owned by the quota boundary alone. */
export type CauseKind = ErrorCauseKind | "tracker-quota";

export interface CauseRecord { key: string; kind: CauseKind; until: number; revision: number; reason: string }
export interface LeaseRecord { key: string; holder: string; expires: number; revision: number }
export interface ProbeLease { key: string; revision: number }
export interface ResumeRecord {
  id: string; session: string; branch: string; owner: string; generation: string;
  status: string; deadline: number; updated: number; body: string;
}

export class HealthStore {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly now: () => number = Date.now, private readonly leaseMs = LEASE_MS) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS causes (
        key TEXT NOT NULL, kind TEXT NOT NULL, until INTEGER NOT NULL,
        revision INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (key, kind));
      CREATE TABLE IF NOT EXISTS leases (
        key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        account TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, body TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS resume_intents (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, branch TEXT NOT NULL, owner TEXT NOT NULL,
        generation TEXT NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL,
        updated INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS resume_active_session ON resume_intents(session)
        WHERE status IN ('armed', 'waiting', 'waking', 'running');
      INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', ${SCHEMA_VERSION}), ('revision', 0);
    `);
    const version = this.db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: number };
    if (version.v !== SCHEMA_VERSION) throw new Error(`Unsupported native-router health schema ${version.v}`);
    if (existsSync(path)) chmodSync(path, 0o600);
  }

  close(): void { this.db.close(); }

  /** Lifecycle writes are atomic; replacing permission fences every previous owner of this session. */
  armResume(row: ResumeRecord): void {
    this.tx(() => {
      this.db.prepare("UPDATE resume_intents SET status = 'stopped', updated = ? WHERE session = ? AND status IN ('armed','waiting','waking','running')")
        .run(this.now(), row.session);
      this.db.prepare("INSERT INTO resume_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.session, row.branch, row.owner, row.generation, row.status, row.deadline, row.updated, row.body);
      this.pruneResumes();
    });
  }

  getResume(id: string): ResumeRecord | undefined {
    return this.db.prepare("SELECT * FROM resume_intents WHERE id = ?").get(id) as unknown as ResumeRecord | undefined;
  }

  /** Explicit off also revokes a restored pointer owned by an earlier process. */
  cancelResume(row: ResumeRecord): void {
    this.tx(() => {
      this.db.prepare("UPDATE resume_intents SET status = 'stopped', updated = ? WHERE id = ? AND session = ? AND generation = ?")
        .run(this.now(), row.id, row.session, row.generation);
      this.db.prepare("DELETE FROM leases WHERE key = ?").run(`resume:${row.id}`);
      this.pruneResumes();
    });
  }

  /** Compare owner, generation and prior phase under the same write lock as the claim/update. */
  updateResume(row: ResumeRecord, previous: string): boolean {
    return this.tx(() => {
      const result = this.db.prepare(`UPDATE resume_intents SET status = ?, updated = ?, body = ?
        WHERE id = ? AND owner = ? AND generation = ? AND status = ?`)
        .run(row.status, row.updated, row.body, row.id, row.owner, row.generation, previous);
      if (Number(result.changes) === 1) {
        if (row.status === "waking") this.db.prepare("INSERT INTO leases (key, holder, expires, revision) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires = excluded.expires, revision = excluded.revision")
          .run(`resume:${row.id}`, `${row.owner}:${row.generation}`, this.now() + this.leaseMs, this.revision());
        else if (row.status !== "running") this.db.prepare("DELETE FROM leases WHERE key = ?").run(`resume:${row.id}`);
      }
      this.pruneResumes();
      return Number(result.changes) === 1;
    });
  }

  resumeClaimValid(row: ResumeRecord): boolean {
    const lease = this.db.prepare("SELECT holder, expires FROM leases WHERE key = ?").get(`resume:${row.id}`) as { holder: string; expires: number } | undefined;
    return lease?.holder === `${row.owner}:${row.generation}` && lease.expires > this.now();
  }

  private pruneResumes(): void {
    // Closed processes never execute persisted permission. Running work is not expired mid-tool.
    this.db.prepare("UPDATE resume_intents SET status = 'stopped', updated = ? WHERE deadline <= ? AND status IN ('armed','waiting','waking')")
      .run(this.now(), this.now());
    this.db.prepare(`DELETE FROM resume_intents WHERE status NOT IN ('armed','waiting','waking','running')
      AND (updated < ? OR id NOT IN (SELECT id FROM resume_intents WHERE status NOT IN ('armed','waiting','waking','running') ORDER BY updated DESC, rowid DESC LIMIT 100))`)
      .run(this.now() - 7 * 86_400_000);
  }

  /** Current fence: admissions record this and only later causes can override them. */
  revision(): number {
    return (this.db.prepare("SELECT v FROM meta WHERE k = 'revision'").get() as { v: number }).v;
  }

  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private nextRevision(): number {
    this.db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'revision'").run();
    return this.revision();
  }

  /** Returns the first scope whose cause is still in force, if any. Reads never block writers in WAL mode. */
  blocked(keys: readonly string[]): CauseRecord | undefined {
    const at = this.now();
    for (const key of keys) {
      const row = this.db.prepare("SELECT key, kind, until, revision, reason FROM causes WHERE key = ? AND until > ?").get(key, at) as CauseRecord | undefined;
      if (row) return row;
    }
    return undefined;
  }

  /** Records an error-derived cause, keeping the strongest deadline. Each write takes a newer revision, fencing older results. */
  mark(key: string, kind: ErrorCauseKind, until: number, reason: string): void {
    this.writeCause(key, kind, until, reason);
  }

  private writeCause(key: string, kind: CauseKind, until: number, reason: string): void {
    this.tx(() => {
      const revision = this.nextRevision();
      this.db.prepare(`INSERT INTO causes (key, kind, until, revision, reason) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key, kind) DO UPDATE SET
          until = MAX(causes.until, excluded.until),
          revision = excluded.revision,
          reason = CASE WHEN causes.until > excluded.until THEN causes.reason ELSE excluded.reason END`)
        .run(key, kind, until, revision, reason);
    });
  }

  /**
   * Atomically admits one recovery probe for every expired scope on the chosen target,
   * or none. Returns undefined when any scope is still blocked or leased elsewhere.
   */
  admitProbe(keys: readonly string[], holder: string): ProbeLease[] | undefined {
    return this.admit(keys, holder, false);
  }

  /**
   * Admits an explicit user pin on a target whose causes may still be live. Another holder's live lease still
   * excludes it, so two processes never try the same target at once.
   */
  admitOverride(keys: readonly string[], holder: string): ProbeLease[] | undefined {
    return this.admit(keys, holder, true);
  }

  private admit(keys: readonly string[], holder: string, override: boolean): ProbeLease[] | undefined {
    return this.tx(() => {
      const at = this.now();
      const leases: ProbeLease[] = [];
      for (const key of keys) {
        const causes = this.db.prepare("SELECT until, revision FROM causes WHERE key = ?").all(key) as Array<{ until: number; revision: number }>;
        if (!override && causes.some(cause => cause.until > at)) return undefined;
        const lease = this.db.prepare("SELECT holder, expires FROM leases WHERE key = ?").get(key) as { holder: string; expires: number } | undefined;
        if (lease && lease.expires > at && lease.holder !== holder) return undefined;
        if (causes.length > 0) leases.push({ key, revision: Math.max(...causes.map(cause => cause.revision)) });
      }
      for (const lease of leases) {
        this.db.prepare("INSERT INTO leases (key, holder, expires, revision) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires = excluded.expires, revision = excluded.revision")
          .run(lease.key, holder, at + this.leaseMs, lease.revision);
      }
      return leases;
    });
  }

  /**
   * Ends a probe. Success clears only the causes the probe proved recovered, and only if
   * they are not newer than the lease; failure releases the lease and leaves the new cause in place.
   */
  settleProbe(holder: string, recovered: boolean): void {
    this.tx(() => {
      const at = this.now();
      const held = this.db.prepare("SELECT key, revision FROM leases WHERE holder = ? AND expires > ?").all(holder, at) as Array<{ key: string; revision: number }>;
      for (const lease of held) {
        if (recovered) this.db.prepare("DELETE FROM causes WHERE key = ? AND revision <= ? AND until <= ?").run(lease.key, lease.revision, at);
        this.db.prepare("DELETE FROM leases WHERE key = ? AND holder = ?").run(lease.key, holder);
      }
    });
  }

  /**
   * Clears the causes of every scope a request admitted at `admittedRevision` proved serves. A cause written
   * after admission has a newer revision and survives. Tracker quota is cleared too; the next authoritative
   * reading re-establishes it if the meter is still exhausted.
   */
  recordSuccess(keys: readonly string[], admittedRevision: number): void {
    this.tx(() => {
      for (const key of keys) this.db.prepare("DELETE FROM causes WHERE key = ? AND revision <= ?").run(key, admittedRevision);
    });
  }

  /** A complete authoritative meter can restore quota, never auth/rate/outage or newer failures. */
  restoreQuota(keys: readonly string[], observedRevision: number): void {
    this.tx(() => {
      for (const key of keys) this.db.prepare("DELETE FROM causes WHERE key = ? AND kind IN ('quota','tracker-quota') AND revision <= ?")
        .run(key, observedRevision);
    });
  }

  /**
   * Operator reset of one provider: clears every cause and lease under it, including model-scoped causes of a
   * single-key provider and account-scoped causes of a multi-account one.
   */
  resetProvider(provider: string): number {
    return this.tx(() => {
      const esc = provider.replace(/[%_\\]/g, "\\$&");
      const scoped = [provider, `${esc}/%`, `${esc}#%`];
      const causes = this.db.prepare("DELETE FROM causes WHERE key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'").run(...scoped);
      this.db.prepare("DELETE FROM leases WHERE key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'").run(...scoped);
      this.nextRevision();
      return Number(causes.changes);
    });
  }

  /** Operator reset of one account: fences its older results and leaves other accounts and provider-wide causes intact. */
  resetAccount(account: string): number {
    return this.tx(() => {
      const suffix = `#${account}`;
      const causes = this.db.prepare("DELETE FROM causes WHERE key LIKE ? ESCAPE '\\'").run(`%${suffix.replace(/[%_\\]/g, "\\$&")}`);
      this.db.prepare("DELETE FROM leases WHERE key LIKE ? ESCAPE '\\'").run(`%${suffix.replace(/[%_\\]/g, "\\$&")}`);
      this.nextRevision();
      return Number(causes.changes);
    });
  }

  /** Takes a refresh lease unless another live holder has it. */
  acquireLease(key: string, holder: string, ttlMs: number): boolean {
    return this.tx(() => {
      const at = this.now();
      const lease = this.db.prepare("SELECT holder, expires FROM leases WHERE key = ?").get(key) as { holder: string; expires: number } | undefined;
      if (lease && lease.expires > at && lease.holder !== holder) return false;
      this.db.prepare("INSERT INTO leases (key, holder, expires, revision) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires = excluded.expires")
        .run(key, holder, at + ttlMs, this.revision());
      return true;
    });
  }

  releaseLease(key: string, holder: string): void {
    this.tx(() => { this.db.prepare("DELETE FROM leases WHERE key = ? AND holder = ?").run(key, holder); });
  }

  /** Stores the latest observation for an account, or its refresh error. Bodies stay secret-free. */
  putSnapshot(account: string, observedAt: number, snapshot: unknown | null, error: string | null): void {
    this.tx(() => {
      this.db.prepare(`INSERT INTO quota_snapshots (account, observed_at, body, error) VALUES (?, ?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET observed_at = excluded.observed_at, body = excluded.body, error = excluded.error`)
        .run(account, observedAt, snapshot === null ? null : JSON.stringify(snapshot), error);
    });
  }

  getSnapshot(account: string): { observedAt: number; body: unknown | null; error: string | null } | undefined {
    const row = this.db.prepare("SELECT observed_at, body, error FROM quota_snapshots WHERE account = ?").get(account) as { observed_at: number; body: string | null; error: string | null } | undefined;
    return row && { observedAt: row.observed_at, body: row.body === null ? null : JSON.parse(row.body), error: row.error };
  }

  /**
   * The only write path for tracker-sourced quota. A future `until` records or extends a `tracker-quota`
   * cause; `undefined` clears one written before `startedRevision`. It never touches error-derived causes
   * (auth, rate, quota, transient) on the same scope, so recovered quota cannot clear them.
   */
  /** Operator refresh: drops the scope's tracker-quota block so the next reading alone decides it. */
  clearTrackerQuota(key: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM causes WHERE key = ? AND kind = 'tracker-quota'").run(key);
      this.nextRevision();
    });
  }

  /** A healthy authoritative reading clears quota causes recorded by dispatch errors, unless written after it started. */
  clearErrorQuota(key: string, startedRevision: number): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM causes WHERE key = ? AND kind = 'quota' AND revision <= ?").run(key, startedRevision);
    });
  }
  reconcileTrackerQuota(key: string, exhaustedUntil: number | undefined, startedRevision: number, reason: string): void {
    if (exhaustedUntil !== undefined) {
      this.writeCause(key, "tracker-quota", exhaustedUntil, reason);
      return;
    }
    this.tx(() => {
      this.db.prepare("DELETE FROM causes WHERE key = ? AND kind = 'tracker-quota' AND revision <= ?").run(key, startedRevision);
    });
  }

  inspect(): { causes: CauseRecord[]; leases: LeaseRecord[]; revision: number } {
    return {
      causes: this.db.prepare("SELECT key, kind, until, revision, reason FROM causes ORDER BY key").all() as unknown as CauseRecord[],
      leases: this.db.prepare("SELECT key, holder, expires, revision FROM leases ORDER BY key").all() as unknown as LeaseRecord[],
      revision: this.revision(),
    };
  }
}
