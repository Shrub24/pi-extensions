// Overview and trace rendering for pi-reqcap's commands. Reads only what
// requests.jsonl already holds, so a report never needs the session to be live.

import { prefixTrace, type TraceSubject } from "./diff.js";

export type ReqRecord = TraceSubject & { kind: "request"; session?: string; utility?: boolean; divergence?: Record<string, any> };
export type ResRecord = {
  kind: "response";
  session?: string;
  seq?: number;
  at?: string;
  api?: string;
  provider?: string;
  usageSource?: string;
  usage?: { input?: number; read?: number; write?: number; write1h?: number; output?: number; promptTokens?: number };
  cold?: boolean;
  reBilled?: boolean;
  divergence?: Record<string, any>;
  headers?: Record<string, string>;
  status?: number;
};
export type CauseRecord = { kind: "cause"; event?: string; session?: string; at?: string; detail?: unknown };
export type AnyRecord = ReqRecord | ResRecord | CauseRecord | Record<string, any>;

const fmt = (n: unknown): string => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "0");

export function short(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** The divergence of a record: the current field, or the name the first cut used. */
function divOf(rec: any): Record<string, any> {
  return (rec?.divergence ?? rec?.diff ?? {}) as Record<string, any>;
}

/** Prompt size, falling back to the parts when a record predates the field. */
function promptOf(res: ResRecord): number {
  const u = res.usage ?? {};
  return u.promptTokens ?? (u.input ?? 0) + (u.read ?? 0) + (u.write ?? 0);
}

function clock(at?: string): string {
  return typeof at === "string" && at.length >= 19 ? at.slice(11, 19) : "--:--:--";
}

/** One line for a cost-bearing event: what it cost and what the divergence was. */
export function bustLine(res: ResRecord, req?: ReqRecord): string {
  const u = res.usage ?? {};
  const d = divOf(res);
  const kind = res.cold ? "COLD   " : "RE-BILL";
  const what = [d.kind, d.at].filter(Boolean).join(" ") || "?";
  return `#${res.seq} ${clock(res.at)} ${kind} read=${fmt(u.read)} write=${fmt(u.write)} prompt=${fmt(u.promptTokens)}  ${what}${d.detail ? ` — ${String(d.detail).slice(0, 90)}` : ""}`;
}

export function classify(res: ResRecord): "healthy" | "partial" | "cold" | "unknown" {
  if (res.cold) return "cold";
  if (res.reBilled) return "partial";
  if (res.headers && Object.keys(res.headers).length === 0 && res.status == null) return "unknown";
  return "healthy";
}

/** The compact session report. */
export function overview(records: AnyRecord[], opts: { scope: string }): string[] {
  const requests = records.filter((r) => (r as ReqRecord).kind === "request" && !(r as ReqRecord).utility) as ReqRecord[];
  const responses = records.filter((r) => (r as ResRecord).kind === "response") as ResRecord[];
  const causes = records.filter((r) => (r as CauseRecord).kind === "cause") as CauseRecord[];
  const sum = (pick: (r: ResRecord) => number | undefined) => responses.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
  const read = sum((r) => r.usage?.read);
  const write = sum((r) => r.usage?.write);
  const input = sum((r) => r.usage?.input);
  const output = sum((r) => r.usage?.output);
  const cold = responses.filter((r) => r.cold);
  const partial = responses.filter((r) => r.reBilled && !r.cold);
  const busts = [...cold, ...partial].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const rebilled = busts.reduce((acc, r) => acc + Math.max(0, promptOf(r) - (r.usage?.read ?? 0)), 0);
  const last = requests[requests.length - 1];
  const out: string[] = [];
  out.push(`pi-reqcap  ${opts.scope}`);
  out.push(`  requests ${requests.length}   responses ${responses.length}   usage seen ${responses.filter((r) => r.usageSource === "stream_event").length}/${responses.length}`);
  out.push(`  tokens   read ${short(read)}   write ${short(write)}   input ${short(input)}   output ${short(output)}`);
  out.push(`  cache    healthy ${responses.length - busts.length}   partial ${partial.length}   cold ${cold.length}   re-billed ${short(rebilled)}`);
  if (busts.length) {
    out.push("  last re-bills");
    for (const r of busts.slice(0, 5)) out.push(`    ${bustLine(r, requests.find((q) => q.seq === r.seq))}`);
  }
  if (causes.length) {
    const byEvent = new Map<string, number>();
    for (const c of causes) byEvent.set(String(c.event), (byEvent.get(String(c.event)) ?? 0) + 1);
    out.push(`  causes   ${[...byEvent].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (last) {
    out.push(`  last req #${last.seq} ${last.model ?? "?"} ${short(last.bodyChars ?? 0)}B  breakpoints ${(last.breakpoints ?? []).map((b) => `${b.at}${b.ttl ? `(${b.ttl})` : ""}`).join(", ") || "none"}`);
  }
  out.push("  commands  /reqcap trace [n] · /reqcap diff [seq] · /reqcap all · /reqcap where");
  return out;
}

/** One line per request: how the prompt moved and what the provider charged. */
export function traceLines(records: AnyRecord[], limit: number): string[] {
  const requests = records.filter((r) => (r as ReqRecord).kind === "request" && !(r as ReqRecord).utility) as ReqRecord[];
  const responses = new Map<number, ResRecord>();
  for (const r of records) if ((r as ResRecord).kind === "response") responses.set(Number((r as ResRecord).seq), r as ResRecord);
  const out: string[] = [];
  for (const req of requests.slice(-limit)) {
    const res = responses.get(Number(req.seq));
    const d = divOf(req);
    const verdict = !res ? "live" : classify(res);
    const cost = res ? `read=${short(res.usage?.read ?? 0)} write=${short(res.usage?.write ?? 0)}` : "";
    const what = `${d.kind ?? "?"}${d.at ? ` ${d.at}` : ""}${d.detail ? ` — ${String(d.detail).slice(0, 70)}` : ""}`;
    out.push(`#${req.seq} ${clock(req.at)} ${String(req.model ?? "?").padEnd(22)} ${verdict.padEnd(8)} ${cost.padEnd(28)} ${what}`);
  }
  return out.length ? out : ["no requests recorded yet"];
}

/** The full prefix comparison for one request against its predecessor. */
export function diffReport(records: AnyRecord[], seq?: number): string[] {
  const requests = records.filter((r) => (r as ReqRecord).kind === "request" && !(r as ReqRecord).utility) as ReqRecord[];
  if (!requests.length) return ["no requests recorded yet"];
  let index = requests.length - 1;
  if (seq !== undefined) {
    const found = requests.findIndex((r) => Number(r.seq) === seq);
    if (found >= 0) index = found;
    else return [`no request with seq ${seq} in this scan; try /reqcap trace`];
  }
  const cur = requests[index];
  let prev: ReqRecord | null = null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (requests[i].model === cur.model) {
      prev = requests[i];
      break;
    }
  }
  return prefixTrace(prev, cur);
}
