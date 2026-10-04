// Fingerprints and divergence classification for pi-reqcap.
//
// Pure: no IO, no Pi import, so the classifier runs in a unit test without a
// session. A re-bill on a prefix-cached provider is one of:
//
//   tools               the tools array changed (membership, order, schemas)
//   params              a request parameter changed (model, max_tokens, thinking, ...)
//   system[i]           a system block changed, and \`sections\` names which inner
//                       section (<skills>, <addendum>, <tools>, <mcp_servers>, ...)
//                       grew, shrank, appeared or disappeared
//   mutate messages[i]  a message already sent was rewritten
//   truncate            the prompt got shorter (compaction, branch, rewind)
//   append              new messages only — the healthy case, and free
//
// Marker movement is not a change: content is hashed with cache_control
// stripped, because the breakpoint moves on every request by design.

import { createHash } from "node:crypto";

export const SECTION_NAMES = [
  "user-profile",
  "project-docs",
  "project-memory",
  "session-history",
  "session-history-since",
  "new-compartments",
  "memory-updates",
  "project_context",
  "project_instructions",
  "rules",
  "addendum",
  "tools",
  "skills",
  "cwd",
  "advertised_subagents",
  "mcp_servers",
  "docs",
  "notes",
];

export type Section = { name: string; chars: number; hash: string };

export type SystemBlock = {
  i: number;
  chars: number;
  hash: string;
  cacheControl: unknown;
  sections: Section[];
  preview: string;
};

export type MessageBlock = {
  i: number;
  role: string;
  hash: string;
  chars: number;
  breakpoints: unknown[];
  preview: string;
};

export type Fingerprint = {
  pid: number;
  session: string;
  at: string;
  model?: string;
  bodyHash: string;
  bodyChars: number;
  params: Record<string, unknown>;
  tools: { n: number; hash: string; lastCacheControl: unknown };
  system: SystemBlock[];
  messages: MessageBlock[];
  breakpoints: { at: string; ttl: unknown }[];
};

export type Divergence = {
  kind: string;
  at?: string;
  detail?: string;
  role?: string;
  was?: string;
  now?: string;
};

export type Usage = {
  input: number;
  read: number;
  write: number;
  write1h: number;
  output: number;
  promptTokens: number;
  cold: boolean;
  reBilled: boolean;
  seen: boolean;
};

export function sha(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

export function blockText(b: unknown): string {
  if (typeof b === "string") return b;
  if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    return JSON.stringify(b);
  }
  return "";
}

export function stripMarkers(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((c) => {
    if (c && typeof c === "object" && "cache_control" in (c as Record<string, unknown>)) {
      const { cache_control: _drop, ...rest } = c as Record<string, unknown>;
      return rest;
    }
    return c;
  });
}

export function preview(s: string, n = 160): string {
  return s.replace(/\s+/g, " ").slice(0, n);
}

/** Top-level sections inside a rendered system block, with their sizes. */
export function sectionsOf(text: string): Section[] {
  const found: { pos: number; name: string }[] = [];
  for (const name of SECTION_NAMES) {
    const re = new RegExp(`(^|\\n)<${name}>\\n`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.push({ pos: m.index + m[1].length, name });
  }
  found.sort((a, b) => a.pos - b.pos);
  return found.map((f, i) => {
    const end = i + 1 < found.length ? found[i + 1].pos : text.length;
    const body = text.slice(f.pos, end);
    return { name: f.name, chars: body.length, hash: sha(body) };
  });
}

export function fingerprint(body: any, meta: { pid: number; session: string; at: string }): Fingerprint {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = Array.isArray(body?.system)
    ? body.system
    : typeof body?.system === "string"
      ? [{ type: "text", text: body.system }]
      : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const breakpoints: { at: string; ttl: unknown }[] = [];

  const systemFp = system.map((b: any, i: number) => {
    const t = blockText(b);
    const cc = b && typeof b === "object" ? b.cache_control : undefined;
    if (cc) breakpoints.push({ at: `system[${i}]`, ttl: cc.ttl });
    return { i, chars: t.length, hash: sha(t), cacheControl: cc ?? null, sections: sectionsOf(t), preview: preview(t) };
  });

  const messageFp = messages.map((m: any, i: number) => {
    const content = Array.isArray(m?.content) ? m.content : [{ type: "text", text: String(m?.content ?? "") }];
    const bps: unknown[] = [];
    content.forEach((c: any, j: number) => {
      if (c && typeof c === "object" && c.cache_control) {
        bps.push({ block: j, ttl: c.cache_control.ttl });
        breakpoints.push({ at: `messages[${i}].content[${j}]`, ttl: c.cache_control.ttl });
      }
    });
    const t = content.map(blockText).join("\u0000");
    return {
      i,
      role: String(m?.role ?? "?"),
      hash: sha(`${m?.role ?? "?"}\u0001${JSON.stringify(stripMarkers(content))}`),
      chars: t.length,
      breakpoints: bps,
      preview: preview(t),
    };
  });

  const serialized = JSON.stringify(body) ?? "";
  return {
    pid: meta.pid,
    session: meta.session,
    at: meta.at,
    model: typeof body?.model === "string" ? body.model : undefined,
    bodyHash: sha(serialized),
    bodyChars: serialized.length,
    params: {
      model: body?.model,
      max_tokens: body?.max_tokens,
      temperature: body?.temperature,
      thinking: body?.thinking,
      tool_choice: body?.tool_choice,
      stream: body?.stream,
    },
    tools: {
      n: tools.length,
      hash: sha(JSON.stringify(stripMarkers(tools))),
      lastCacheControl: tools.length ? ((tools[tools.length - 1] as any)?.cache_control ?? null) : null,
    },
    system: systemFp,
    messages: messageFp,
    breakpoints,
  };
}

export function sectionDiff(was: SystemBlock | undefined, now: SystemBlock | undefined): string {
  if (!was || !now) return "block missing on one side";
  const a = new Map(was.sections.map((s) => [s.name, s]));
  const b = new Map(now.sections.map((s) => [s.name, s]));
  const parts: string[] = [];
  for (const [name, cur] of b) {
    const prev = a.get(name);
    if (!prev) parts.push(`${name} absent->${cur.chars}ch`);
    else if (prev.hash !== cur.hash) {
      const delta = cur.chars - prev.chars;
      parts.push(`${name} ${prev.chars}->${cur.chars}ch (${delta >= 0 ? "+" : ""}${delta})`);
    }
  }
  for (const [name, prev] of a) if (!b.has(name)) parts.push(`${name} ${prev.chars}ch->absent`);
  return parts.length ? parts.join("; ") : `${was.chars}->${now.chars}ch outside known sections`;
}

export function diff(prevFp: Fingerprint | null, cur: Fingerprint): Divergence {
  if (!prevFp) return { kind: "first" };
  if (JSON.stringify(prevFp.tools) !== JSON.stringify(cur.tools)) {
    return { kind: "tools", detail: `tools ${prevFp.tools.n}->${cur.tools.n} hash ${prevFp.tools.hash}->${cur.tools.hash}` };
  }
  if (JSON.stringify(prevFp.params) !== JSON.stringify(cur.params)) {
    return {
      kind: "params",
      detail: Object.keys({ ...prevFp.params, ...cur.params })
        .filter((k) => JSON.stringify(prevFp.params[k]) !== JSON.stringify(cur.params[k]))
        .join(","),
    };
  }
  for (let i = 0; i < Math.max(prevFp.system.length, cur.system.length); i++) {
    const a = prevFp.system[i];
    const b = cur.system[i];
    if (!a || !b || a.hash !== b.hash) {
      return {
        kind: "system",
        at: `system[${i}]`,
        detail: sectionDiff(a, b),
        was: preview(a?.preview ?? ""),
        now: preview(b?.preview ?? ""),
      };
    }
  }
  for (let i = 0; i < Math.min(prevFp.messages.length, cur.messages.length); i++) {
    if (prevFp.messages[i].hash !== cur.messages[i].hash) {
      const was = prevFp.messages[i];
      const now = cur.messages[i];
      return {
        kind: "mutate",
        at: `messages[${i}]`,
        role: now.role,
        detail: `${was.role} ${was.chars}ch (${was.hash}) -> ${now.role} ${now.chars}ch (${now.hash})`,
        was: was.preview,
        now: now.preview,
      };
    }
  }
  if (cur.messages.length < prevFp.messages.length) {
    return { kind: "truncate", detail: `${prevFp.messages.length} -> ${cur.messages.length} messages` };
  }
  return { kind: "append", detail: `+${cur.messages.length - prevFp.messages.length} messages` };
}

/**
 * What the provider billed this request, and whether it lost the prefix.
 * `cold` is read=0 on a prompt worth caching; `reBilled` is a prompt much larger
 * than what the provider could read back, at a write volume no append produces.
 */
export function usageFlags(usage: Record<string, any> | undefined, prevPromptTokens: number): Usage {
  const seen = usage != null;
  const read = Number(usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const write = Number(usage?.cache_creation_input_tokens ?? 0);
  const write1h = Number(usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const promptTokens = input + read + write;
  return {
    input,
    read,
    write,
    write1h,
    output,
    promptTokens,
    cold: read === 0 && promptTokens > 5_000,
    reBilled: write > 60_000 || (promptTokens > 10_000 && read < 0.8 * prevPromptTokens),
    seen,
  };
}
