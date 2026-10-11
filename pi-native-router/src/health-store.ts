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

export interface CauseRecord { key: string; kind: string; until: number; revision: number; reason: string }
export interface LeaseRecord { key: string; holder: string; expires: number; revision: number }
export interface ProbeLease { key: string; revision: number }

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
      INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', ${SCHEMA_VERSION}), ('revision', 0);
    `);
    const version = this.db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: number };
    if (version.v !== SCHEMA_VERSION) throw new Error(`Unsupported native-router health schema ${version.v}`);
    if (existsSync(path)) chmodSync(path, 0o600);
  }

  close(): void { this.db.close(); }

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

  /** Records a cause, keeping the strongest deadline. Each write takes a newer revision, fencing older results. */
  mark(key: string, kind: string, until: number, reason: string): void {
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
    return this.tx(() => {
      const at = this.now();
      const leases: ProbeLease[] = [];
      for (const key of keys) {
        const causes = this.db.prepare("SELECT until, revision FROM causes WHERE key = ?").all(key) as Array<{ until: number; revision: number }>;
        if (causes.some(cause => cause.until > at)) return undefined;
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

  /** Clears expired causes proven by a successful request admitted at `admittedRevision`. */
  recordSuccess(keys: readonly string[], admittedRevision: number): void {
    this.tx(() => {
      const at = this.now();
      for (const key of keys) this.db.prepare("DELETE FROM causes WHERE key = ? AND revision <= ? AND until <= ?").run(key, admittedRevision, at);
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
   * Clears a tracker-sourced quota cause, but only one written before `startedRevision`.
   * Error-derived causes (auth, rate, outage, error quota) carry a different kind and are never touched.
   */
  clearTrackerQuota(key: string, startedRevision: number): void {
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
