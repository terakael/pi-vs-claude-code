/**
 * coms — Peer-to-peer messaging between Pi agents on the same machine
 *
 * Each agent listens on a single endpoint (unix socket on POSIX, named pipe on
 * Windows) and discovers peers through per-project registry files under
 * ~/.pi/coms/projects/<project>/agents/<name>.json.
 *
 * Phase A (foundation): identity resolution, registry I/O, transport bind/send,
 * connection handlers.
 *
 * Usage: pi -e extensions/coms.ts
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { CustomEditor, DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Key,
  Text,
  Container,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { pickLevelOneName } from "./naming.ts";

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_DIR =
  process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LINE_CAP_BYTES = 64 * 1024;

const FALLBACK_PALETTE = [
  "#72F1B8",
  "#36F9F6",
  "#FF7EDB",
  "#FEDE5D",
  "#C792EA",
  "#FF8B39",
  "#4D9DE0",
  "#FFAA8B",
];

// ━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "ping";

interface Envelope {
  type: EnvelopeType;
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  hops: number;
  timestamp: string;
}

interface PromptEnvelope extends Envelope {
  type: "prompt";
  prompt: string;
  sender_name: string;
  sender_cwd: string;
  conversation_id?: string | null;
}

interface PingEnvelope extends Envelope {
  type: "ping";
}

interface AgentCard {
  name: string;
  purpose: string;
  model: string;
  color: string;
  context_used_pct: number;
  is_running?: boolean;
  is_blocked?: boolean;
}

interface Pong {
  type: "pong";
  msg_id: string;
  agent_card: AgentCard;
}

interface StatusMessage {
  type: "status";
  is_running: boolean;
  is_blocked?: boolean;
  closing?: boolean;
}

interface RegistryEntry {
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  color: string;
  pid: number;
  endpoint: string;
  cwd: string;
  started_at: string;
  explicit: boolean;
  version: number;
  // Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
  // Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
  context_used_pct?: number;
  queue_depth?: number;
  is_running?: boolean;
  heartbeat_at?: string;
  tmux_session?: string;
  tmux_window?: string;
  tmux_pane?: string;
}

// Minimal context for the currently-running coms-initiated turn — used only
// for hop-count inheritance so outbound sends from within that turn increment
// the counter correctly.
interface InboundContext {
  msg_id: string;
  hops: number;
}

// Find the entry that initiated the most recent turn: the last branch entry
// that is a real user message or an injected custom_message (e.g. coms-inbound).
// Assistant and toolResult entries are turn *output*, never initiators, so they
// are skipped. Returns null if no initiator is found.
//
// This is the linchpin of correct auto-reply: a turn should only reply to coms
// when it was actually triggered by an inbound coms message — not merely because
// an inbound happens to be sitting in the queue while some other turn (e.g. a
// proactive self-investigation) completes.
function findTurnInitiator(branch: any[]): any | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "custom_message") return e;
    if (e.type === "message" && e.message?.role === "user") return e;
    // assistant / toolResult are turn output — keep walking back
  }
  return null;
}

// ━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  const time = Date.now();
  const rand = crypto.randomBytes(10);
  let timeStr = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timeStr = CROCKFORD[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = "";
  let bits = 0;
  let value = 0;
  for (const byte of rand) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randStr += CROCKFORD[(value >> bits) & 31];
    }
  }
  return (timeStr + randStr).slice(0, 26);
}

function hexFg(hex: string, s: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function fallbackColor(sessionId: string): string {
  const h = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  color?: string;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // strip surrounding quotes for values like color: "#36F9F6"
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    color: frontmatter.color,
    body: match[2],
  };
}

function makeEndpoint(sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-coms-${sessionId}`;
  }
  return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function abbreviateModel(model: string, maxLen = 16): string {
  let m = model || "";
  // Strip vendor prefixes that add noise (us., eu., ap. routing prefixes + anthropic/openai/meta etc.)
  m = m.replace(/^(us|eu|ap)\./, "");
  m = m.replace(
    /^(anthropic|openai|meta|google|mistral|amazon|bedrock)\./i,
    "",
  );
  // Strip claude- prefix since it's implied
  if (m.startsWith("claude-")) m = m.slice("claude-".length);
  // If still too long, take the tail — the end carries version/variant info
  if (m.length > maxLen) m = m.slice(m.length - maxLen);
  return m;
}

// ━━ CLI flag shape (read via pi.registerFlag/pi.getFlag) ━━━━━━━━━━━━━━━━━━━

interface CliFlags {
  name?: string;
  purpose?: string;
  project?: string;
  color?: string;
  explicit?: boolean;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
  // Identity flags are declared via pi.registerFlag at extension load time so
  // pi's CLI parser accepts them; here we just read them back.
  const name = pi.getFlag("cname") as string | undefined;
  const purpose = pi.getFlag("purpose") as string | undefined;
  const project = pi.getFlag("project") as string | undefined;
  const color = pi.getFlag("color") as string | undefined;
  const explicit = pi.getFlag("explicit") as boolean | undefined;
  return {
    name: name && name.length > 0 ? name : undefined,
    purpose: purpose && purpose.length > 0 ? purpose : undefined,
    project: project && project.length > 0 ? project : undefined,
    color: color && color.length > 0 ? color : undefined,
    explicit: explicit === true,
  };
}

// ━━ Registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function projectAgentsDir(project: string): string {
  return path.join(COMS_DIR, "projects", project, "agents");
}

function registryFilePath(project: string, name: string): string {
  return path.join(projectAgentsDir(project), `${name}.json`);
}

function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
  const dir = projectAgentsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const final = registryFilePath(project, entry.name);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, final);
  return final;
}

function readAllRegistryEntries(project: string): RegistryEntry[] {
  const dir = projectAgentsDir(project);
  if (!fs.existsSync(dir)) return [];
  const out: RegistryEntry[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as RegistryEntry;
      if (parsed && typeof parsed.session_id === "string") {
        out.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

function readAllRegistryEntriesAcrossProjects(): RegistryEntry[] {
  const root = path.join(COMS_DIR, "projects");
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const p of projects) {
    try {
      if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...readAllRegistryEntries(p));
  }
  return out;
}

function removeRegistryEntry(project: string, name: string): void {
  try {
    fs.unlinkSync(registryFilePath(project, name));
  } catch {
    // best-effort
  }
}

function pruneDeadEntries(project: string): RegistryEntry[] {
  const entries = readAllRegistryEntries(project);
  const live: RegistryEntry[] = [];
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 0);
      live.push(entry);
    } catch (e: any) {
      if (e && e.code === "ESRCH") {
        removeRegistryEntry(project, entry.name);
      } else {
        // EPERM means the process exists but we can't signal it — treat as live.
        live.push(entry);
      }
    }
  }
  return live;
}

function resolveUniqueName(project: string, desiredName: string): string {
  // Returns a name that doesn't collide with any LIVE registered agent.
  // pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
  const liveEntries = pruneDeadEntries(project);
  const liveNames = new Set(liveEntries.map((e) => e.name));
  if (!liveNames.has(desiredName)) return desiredName;
  let n = 2;
  while (liveNames.has(`${desiredName}${n}`)) n++;
  return `${desiredName}${n}`;
}

function pruneDeadEntriesAllProjects(): RegistryEntry[] {
  const root = path.join(COMS_DIR, "projects");
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const p of projects) {
    try {
      if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...pruneDeadEntries(p));
  }
  return out;
}

function keepaliveTouch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // best-effort
  }
}

// ━━ Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: endpoint });
    let settled = false;
    const finish = (verdict: "in_use" | "stale") => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish("stale"), 250);
    sock.once("connect", () => {
      clearTimeout(timer);
      finish("in_use");
    });
    sock.once("error", (err: any) => {
      clearTimeout(timer);
      if (err && err.code === "ECONNREFUSED") {
        finish("stale");
      } else {
        // ENOENT or other — treat as stale (file may be gone or unusable)
        finish("stale");
      }
    });
  });
}

async function bindEndpoint(
  endpoint: string,
  connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    const verdict = await probeStaleSocket(endpoint);
    if (verdict === "in_use") {
      throw new Error(`coms: endpoint already in use (${endpoint})`);
    }
    try {
      fs.unlinkSync(endpoint);
    } catch {
      // best-effort
    }
  }
  return await new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer(connHandler);
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function readOneLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (buf.length > LINE_CAP_BYTES) {
        if (settled) return;
        settled = true;
        socket.removeListener("data", onData);
        reject(new Error("line too large"));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        if (settled) return;
        settled = true;
        socket.removeListener("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("connection closed before line received"));
    });
  });
}

function sendEnvelope(
  endpoint: string,
  envelope:
    | Envelope
    | Pong
    | { type: string; msg_id?: string; [k: string]: any },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: endpoint });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    sock.once("error", fail);
    sock.once("connect", async () => {
      try {
        sock.write(JSON.stringify(envelope) + "\n");
        const line = await readOneLine(sock);
        const parsed = JSON.parse(line);
        try {
          sock.end();
        } catch {
          /* ignore */
        }
        if (settled) return;
        settled = true;
        if (parsed && parsed.type === "nack") {
          reject(new Error(parsed.error || "nack"));
        } else {
          resolve(parsed);
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

// ━━ System-prompt frontmatter scan ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findSystemPromptPath(argv: string[]): string | null {
  // Prefer --system-prompt (overwrite). Fall back to --append-system-prompt.
  // These flags are pi-builtin (not extension-registered) so we still scan
  // argv directly. First match wins per preference order.
  const scan = (flag: string): string | null => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) {
        const candidate = argv[i + 1];
        if (candidate.endsWith(".md")) {
          try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return candidate;
            }
          } catch {
            // fall through
          }
        }
      }
    }
    return null;
  };
  return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): {
  name?: string;
  description?: string;
  color?: string;
} {
  const p = findSystemPromptPath(argv);
  if (!p) return {};
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const { name, description, color } = parseFrontmatter(raw);
    return { name, description, color };
  } catch {
    return {};
  }
}

// ━━ Keyboard-navigable pool (CustomEditor subclass) ━━━━━━━━━━━━━━━━━━━━━━━━━

class ComsNavEditor extends CustomEditor {
  private leaderActive = false;

  constructor(
    private _tui: any,
    theme: any,
    keybindings: any,
    private getRows: () => string[],
    private getSelected: () => number,
    private setSelected: (n: number) => void,
    private onNavigate: (name: string) => void,
    private onClose: (name: string) => void,
    private leaderBindings: ReadonlyMap<string, () => void>,
    private onLeaderChange: (active: boolean) => void,
    private styleLeaderLine: (line: string) => string,
  ) {
    super(_tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    // Leader mode: consume next key and dispatch.
    if (this.leaderActive) {
      this.leaderActive = false;
      this.onLeaderChange(false);
      if (!matchesKey(data, Key.escape)) {
        this.leaderBindings.get(data)?.();
      }
      this._tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.ctrl("x"))) {
      this.leaderActive = true;
      this.onLeaderChange(true);
      this._tui.requestRender();
      return;
    }

    const rows = this.getRows();
    const sel = this.getSelected();

    if (matchesKey(data, Key.ctrl("n"))) {
      if (rows.length > 0) {
        this.setSelected(sel >= rows.length - 1 ? -1 : sel + 1);
        this._tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.ctrl("p"))) {
      if (rows.length > 0) {
        this.setSelected(sel === -1 ? rows.length - 1 : sel - 1);
        this._tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.enter) && sel >= 0) {
      const name = rows[sel];
      if (name) this.onNavigate(name);
      this.setSelected(-1);
      this._tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) && sel >= 0) {
      this.setSelected(-1);
      this._tui.requestRender();
      return;
    }

    if (data === "x" && sel >= 0) {
      const name = rows[sel];
      if (name) this.onClose(name);
      this.setSelected(-1);
      this._tui.requestRender();
      return;
    }

    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.leaderActive) return lines;
    return lines.map((line) => this.styleLeaderLine(line));
  }
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
  // ━━ Register identity CLI flags so pi's parser accepts them. ━━━━━━━━━
  // Without these, pi 0.73+ rejects the invocation with "Unknown options:
  // --cname, --project, ..." before this extension's hooks ever fire.
  // Agent name flag is `--cname`: pi's harness owns `--name` and resumes it.
  pi.registerFlag("cname", {
    description:
      "Override coms agent name (otherwise from frontmatter or auto-generated). Distinct from pi's own --name, which the harness owns and resumes.",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("purpose", {
    description:
      "Override agent purpose (otherwise from frontmatter description)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("project", {
    description: "Project namespace for peer discovery",
    type: "string",
    default: "default",
  });
  pi.registerFlag("color", {
    description:
      "Hex color #RRGGBB (otherwise from frontmatter or palette fallback)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("explicit", {
    description:
      "Hide this agent from auto-discovery; only addressable by exact name",
    type: "boolean",
    default: false,
  });

  // State containers — shared across all hooks for this extension instance.
  let identity: {
    session_id: string;
    name: string;
    purpose: string;
    color: string;
    project: string;
    explicit: boolean;
    cwd: string;
    model: string;
    endpoint: string;
    registryFiles: string[];
    tmux_session?: string;
    tmux_window?: string;
    tmux_pane?: string;
  } | null = null;
  const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
  let server: net.Server | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let includeExplicit = false;
  let extraProjects: string[] = [];
  let currentCtx: ExtensionContext | null = null;
  let currentInbound: InboundContext | null = null;
  let selectedIndex = -1;
  let widgetVisible = true;
  let agentRunning = false;
  let agentBlocked = false;
  let spinnerFrame = 0;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let currentTui: any = null;

  // All pools this agent is registered in and reads from.
  // Always includes identity.project (own-name pool); extraProjects adds named pools.
  function allProjects(): string[] {
    if (!identity) return [];
    return [
      identity.project,
      ...extraProjects.filter((p) => p !== identity!.project),
    ];
  }

  // Read registry entries across all display pools, deduplicated by session_id.
  function readAllDisplayEntries(): RegistryEntry[] {
    const seen = new Set<string>();
    const out: RegistryEntry[] = [];
    for (const p of allProjects()) {
      for (const e of readAllRegistryEntries(p)) {
        if (!seen.has(e.session_id)) {
          seen.add(e.session_id);
          out.push(e);
        }
      }
    }
    return out;
  }

  // Phase A stub handlers — each just acks valid envelopes. Phase B replaces these.
  function ackOk(socket: net.Socket, msg_id: string): void {
    try {
      socket.write(JSON.stringify({ type: "ack", msg_id }) + "\n");
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  function nack(socket: net.Socket, msg_id: string, error: string): void {
    try {
      socket.write(JSON.stringify({ type: "nack", msg_id, error }) + "\n");
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
    // 1. Hop limit check
    if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
      nack(socket, env.msg_id, "hops exceeded");
      return;
    }

    // Steer the receiver immediately. hops is stored in details so agent_start
    // can arm currentInbound for hop-count inheritance.
    try {
      pi.sendMessage(
        {
          customType: "coms-inbound",
          content: `[coms · from ${env.sender_name} · reply via coms_send target="${env.sender_name}" if needed]\n\n${env.prompt}`,
          display: true,
          details: {
            msg_id: env.msg_id,
            hops: env.hops,
            sender_name: env.sender_name,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (err) {
      nack(socket, env.msg_id, "internal error");
      return;
    }

    ackOk(socket, env.msg_id);
    try {
      pi.appendEntry("coms-log", {
        event: "inbound_prompt",
        msg_id: env.msg_id,
        sender: env.sender_name,
        hops: env.hops,
      });
    } catch {
      // best-effort
    }
  }

  function handlePing(socket: net.Socket, env: PingEnvelope): void {
    const ctx = currentCtx;
    const ident = identity;
    const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
    const card: AgentCard = {
      name: ident?.name ?? "unknown",
      purpose: ident?.purpose ?? "",
      model: ctx?.model?.id ?? ident?.model ?? "unknown",
      color: ident?.color ?? "#36F9F6",
      context_used_pct: pct,
      is_running: agentRunning,
      is_blocked: agentBlocked || undefined,
    };
    const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
    try {
      socket.write(JSON.stringify(pong) + "\n");
    } catch {
      // ignore
    }
    try {
      socket.end();
    } catch {
      /* ignore */
    }
  }

  function handleStatus(_socket: net.Socket, msg: StatusMessage): void {
    // Status messages carry sender_session so we can match directly.
    // Fire-and-forget — no reply needed.
    const sid: string = (msg as any).sender_session;
    if (!sid) return;
    if (msg.closing) {
      peerCards.delete(sid);
      updateSpinnerTimer();
      currentTui?.requestRender?.();
      return;
    }
    const card = peerCards.get(sid);
    if (card) {
      card.is_running = msg.is_running;
      card.is_blocked = msg.is_blocked ?? false;
      updateSpinnerTimer();
      currentTui?.requestRender?.();
    }
  }

  function broadcastPeerClosed(deadSessionId: string): Promise<void> {
    if (!identity) return Promise.resolve();
    const entries = readAllDisplayEntries();
    const payload =
      JSON.stringify({
        type: "status",
        is_running: false,
        closing: true,
        sender_session: deadSessionId,
      }) + "\n";
    const sends = entries
      .filter(
        (e) =>
          e.session_id !== identity!.session_id &&
          e.session_id !== deadSessionId,
      )
      .map(
        (entry) =>
          new Promise<void>((resolve) => {
            try {
              const sock = net.createConnection(entry.endpoint);
              const done = () => resolve();
              sock.once("connect", () => {
                try {
                  sock.write(payload);
                  sock.end();
                } catch {
                  /* ignore */
                }
              });
              sock.once("close", done);
              sock.once("error", done);
              setTimeout(done, 500);
            } catch {
              resolve();
            }
          }),
      );
    return Promise.all(sends).then(() => undefined);
  }

  function broadcastStatus(
    is_running: boolean,
    closing = false,
  ): Promise<void> {
    if (!identity) return Promise.resolve();
    const entries = readAllDisplayEntries();
    const payload =
      JSON.stringify({
        type: "status",
        is_running,
        is_blocked: agentBlocked || undefined,
        closing: closing || undefined,
        sender_session: identity.session_id,
      }) + "\n";
    const sends = entries
      .filter((e) => e.session_id !== identity!.session_id)
      .map(
        (entry) =>
          new Promise<void>((resolve) => {
            try {
              const sock = net.createConnection(entry.endpoint);
              const done = () => resolve();
              sock.once("connect", () => {
                try {
                  sock.write(payload);
                  sock.end();
                } catch {
                  /* ignore */
                }
              });
              sock.once("close", done);
              sock.once("error", done);
              // Safety timeout so shutdown never hangs more than 500ms per peer.
              setTimeout(done, 500);
            } catch {
              resolve();
            }
          }),
      );
    return Promise.all(sends).then(() => undefined);
  }

  function updateSpinnerTimer(): void {
    const anyRunning = [...peerCards.values()].some((c) => c.is_running);
    if (anyRunning && !spinnerTimer) {
      spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        currentTui?.requestRender?.();
      }, 100);
      try {
        (spinnerTimer as any).unref?.();
      } catch {
        /* ignore */
      }
    } else if (!anyRunning && spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  function isValidEnvelope(obj: any): obj is Envelope {
    return (
      obj &&
      typeof obj === "object" &&
      typeof obj.type === "string" &&
      typeof obj.msg_id === "string" &&
      typeof obj.sender_session === "string" &&
      typeof obj.sender_endpoint === "string"
    );
  }

  function connHandler(socket: net.Socket): void {
    let buf = "";
    let handled = false;
    const onData = (chunk: Buffer) => {
      if (handled) return;
      buf += chunk.toString("utf-8");
      if (buf.length > LINE_CAP_BYTES) {
        handled = true;
        socket.removeListener("data", onData);
        nack(socket, "", "malformed envelope");
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      socket.removeListener("data", onData);
      const line = buf.slice(0, nl);
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        nack(socket, "", "malformed envelope");
        return;
      }
      if (!isValidEnvelope(parsed)) {
        // Status messages are lightweight pushes — they don't carry envelope fields.
        if (parsed && parsed.type === "status") {
          handleStatus(socket, parsed as StatusMessage);
          return;
        }
        const mid =
          parsed && typeof parsed.msg_id === "string" ? parsed.msg_id : "";
        nack(socket, mid, "malformed envelope");
        return;
      }
      try {
        if (parsed.type === "prompt") {
          handlePrompt(socket, parsed as PromptEnvelope);
        } else if (parsed.type === "ping") {
          handlePing(socket, parsed as PingEnvelope);
        } else if (parsed.type === "status") {
          handleStatus(socket, parsed as StatusMessage);
        } else {
          nack(socket, parsed.msg_id, "unknown type");
        }
      } catch {
        nack(socket, parsed.msg_id, "internal error");
      }
    };
    socket.on("data", onData);
    socket.once("error", () => {
      // connection failures during handshake — drop quietly
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  }

  // ━━ session_start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // 1. Resolve identity from CLI flags > frontmatter > defaults.
    const flags = readCliFlags(pi);
    const fm = readFrontmatterFromArgv(process.argv);
    const namedProject =
      flags.project && flags.project !== "default" ? flags.project : null;
    const explicit = flags.explicit === true;
    const session_id = ulid();

    const liveNames = new Set(pruneDeadEntriesAllProjects().map((e) => e.name));
    const defaultName =
      flags.name || fm.name
        ? resolveUniqueName(
            flags.name || fm.name || "",
            flags.name || fm.name || "",
          )
        : pickLevelOneName(liveNames);
    const name = defaultName;
    const purpose = flags.purpose || fm.description || "";

    // Color: validate at every level; fall through invalid hex to next.
    // Order: --color CLI flag > frontmatter color > deterministic fallback.
    let color = fallbackColor(session_id);
    if (fm.color && isValidHex(fm.color)) {
      color = fm.color;
    }
    if (flags.color && isValidHex(flags.color)) {
      color = flags.color;
    }

    const endpoint = makeEndpoint(session_id);
    const cwd = ctx.cwd || process.cwd();
    const model = ctx.model?.id ?? "unknown";

    // Detect tmux location — stored in registry so peers can navigate here.
    let tmuxSession: string | undefined;
    let tmuxWindow: string | undefined;
    const tmuxPane = process.env.TMUX_PANE || undefined;
    if (tmuxPane) {
      try {
        const rs = spawnSync(
          "tmux",
          ["display-message", "-p", "-t", tmuxPane, "#S"],
          { encoding: "utf-8" },
        );
        const rw = spawnSync(
          "tmux",
          ["display-message", "-p", "-t", tmuxPane, "#W"],
          { encoding: "utf-8" },
        );
        if (rs.status === 0) tmuxSession = rs.stdout.trim() || undefined;
        if (rw.status === 0) tmuxWindow = rw.stdout.trim() || undefined;
      } catch {
        /* tmux unavailable */
      }
    }

    // 2. Ensure storage dirs exist.
    try {
      const poolsToInit = namedProject ? [name, namedProject] : [name];
      for (const p of poolsToInit) {
        fs.mkdirSync(path.join(COMS_DIR, "projects", p, "agents"), {
          recursive: true,
        });
      }
      if (process.platform !== "win32") {
        fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
        try {
          fs.chmodSync(COMS_DIR, 0o700);
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      ctx.ui?.notify?.(
        `📡 coms: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    // 3. Bind the endpoint.
    try {
      server = await bindEndpoint(endpoint, connHandler);
    } catch (err) {
      ctx.ui?.notify?.(
        `📡 coms: bind failed — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    // 4. Build + write registry entry atomically.
    const entry: RegistryEntry = {
      session_id,
      name,
      purpose,
      model,
      color,
      pid: process.pid,
      endpoint,
      cwd,
      started_at: nowIso(),
      explicit,
      version: 1,
      tmux_session: tmuxSession,
      tmux_window: tmuxWindow,
      tmux_pane: tmuxPane,
    };
    let registryFiles: string[];
    try {
      // Always write to own-name pool. Also write to named project if specified.
      const poolsToWrite = namedProject ? [name, namedProject] : [name];
      registryFiles = poolsToWrite.map((p) => writeRegistryAtomic(entry, p));
    } catch (err) {
      ctx.ui?.notify?.(
        `📡 coms: registry write failed — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    identity = {
      session_id,
      name,
      purpose,
      color,
      project: name, // primary pool = own coms name
      explicit,
      cwd,
      model,
      endpoint,
      registryFiles,
      tmux_session: tmuxSession,
      tmux_window: tmuxWindow,
      tmux_pane: tmuxPane,
    };
    includeExplicit = false;
    extraProjects = namedProject ? [namedProject] : [];
    // Expose identity so co-loaded extensions (subagent-widget etc.) can read it.
    process.env.PI_COMS_PROJECT = name;
    process.env.PI_COMS_NAME = name;

    // 5. Audit log: boot.
    try {
      pi.appendEntry("coms-log", {
        event: "boot",
        session_id,
        name,
        project: name,
        extra_projects: extraProjects,
      });
    } catch {
      // best-effort
    }

    // 6. Surface presence in the UI + install the live pool widget.
    try {
      ctx.ui.setStatus(
        "coms",
        `📡 ${name}@${name}${namedProject ? `+${namedProject}` : ""}`,
      );
      installPoolWidget(ctx);
      ctx.ui.setEditorComponent((tui, theme, kb) => {
        currentTui = tui;
        return new ComsNavEditor(
          tui,
          theme,
          kb,
          () => buildPoolRows().map((r) => r.name),
          () => selectedIndex,
          (n) => {
            selectedIndex = n;
          },
          navigateToAgent,
          closeAgent,
          new Map([["h", toggleWidget]]),
          (active) => {
            if (!identity || !currentCtx?.hasUI) return;
            const base = `📡 ${identity.name}`;
            try {
              currentCtx.ui.setStatus("coms", active ? `${base} [C-x]` : base);
            } catch {
              /* ignore */
            }
          },
          (line) => ctx.ui.theme.bg("toolPendingBg", line),
        );
      });
      ctx.ui.notify(
        `📡 coms ready · ${name} · pools: ${allProjects().join(", ")}`,
        "info",
      );
    } catch {
      // hasUI may be false in some contexts — non-fatal.
    }

    // 7. Start ping + keepalive cycles.
    pingTimer = setInterval(() => {
      refreshPool().catch(() => {});
    }, PING_INTERVAL_MS);
    try {
      (pingTimer as any).unref?.();
    } catch {
      /* ignore */
    }
    keepaliveTimer = setInterval(() => {
      if (!identity) return;
      try {
        const ctx = currentCtx;
        // Detect missing-registry BEFORE writing so the self_heal audit only
        // fires when something actually went wrong (file unlinked under us).
        const missingBeforeWrite = identity.registryFiles.some(
          (f) => !fs.existsSync(f),
        );
        const live: RegistryEntry = {
          session_id: identity.session_id,
          name: identity.name,
          purpose: identity.purpose,
          model: ctx?.model?.id ?? identity.model,
          color: identity.color,
          pid: process.pid,
          endpoint: identity.endpoint,
          cwd: identity.cwd,
          started_at: nowIso(),
          explicit: identity.explicit,
          version: 1,
          context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
          heartbeat_at: nowIso(),
          tmux_session: identity.tmux_session,
          tmux_window: identity.tmux_window,
          tmux_pane: identity.tmux_pane,
        };
        // Write to all pools on every keepalive tick.
        for (const p of allProjects()) writeRegistryAtomic(live, p);
        if (missingBeforeWrite) {
          pi.appendEntry("coms-log", {
            event: "self_heal",
            session_id: identity.session_id,
            reason: "registry file missing",
          });
          if (identity.registryFiles.some((f) => !fs.existsSync(f))) {
            for (const p of allProjects()) writeRegistryAtomic(live, p);
          }
        }
      } catch {
        /* best-effort */
      }
    }, KEEPALIVE_INTERVAL_MS);
    try {
      (keepaliveTimer as any).unref?.();
    } catch {
      /* ignore */
    }

    // Kick one ping cycle immediately so the widget populates fast.
    refreshPool().catch(() => {});
  });

  // ━━ Helpers used by tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function pingPeer(endpoint: string): Promise<AgentCard | null> {
    if (!identity) return null;
    const env: PingEnvelope = {
      type: "ping",
      msg_id: ulid(),
      sender_session: identity.session_id,
      sender_endpoint: identity.endpoint,
      hops: 0,
      timestamp: nowIso(),
    };
    try {
      const resp = await sendEnvelope(endpoint, env);
      if (resp && resp.type === "pong" && resp.agent_card) {
        return resp.agent_card as AgentCard;
      }
    } catch {
      // ignore — peer unreachable
    }
    return null;
  }

  function toggleWidget(): void {
    widgetVisible = !widgetVisible;
    if (widgetVisible) {
      if (currentCtx) installPoolWidget(currentCtx);
    } else if (currentCtx?.hasUI) {
      try {
        currentCtx.ui.setWidget("coms-pool", undefined);
      } catch {
        /* ignore */
      }
    }
  }

  // ━━ Pool rows (shared between renderPool and the nav editor) ━━━━━━━━━━━━
  function agentRelationship(
    myName: string,
    peerName: string,
  ): "parent" | "child" | "sibling" | "peer" {
    // Hierarchy is now encoded by prefix nesting (Docker-style levels)
    // e.g. parent="amber", child="amber-basin", sibling1="amber-basin", sibling2="amber-grove"
    if (peerName.startsWith(myName + "-")) return "child";
    if (myName.startsWith(peerName + "-")) return "parent";
    const myParent = myName.split("-").slice(0, -1).join("-");
    const peerParent = peerName.split("-").slice(0, -1).join("-");
    if (myParent && peerParent && myParent === peerParent) return "sibling";
    return "peer";
  }

  interface PoolRow {
    name: string;
    model: string;
    color: string;
    purpose: string;
    pct: number | null;
    pending: boolean;
    stale: boolean;
    running: boolean;
    blocked: boolean;
    relationship: "parent" | "child" | "sibling" | "peer";
  }

  function buildPoolRows(): PoolRow[] {
    const registryEntries = includeExplicit
      ? readAllRegistryEntriesAcrossProjects()
      : readAllDisplayEntries();

    const rows: PoolRow[] = [];
    const seenSessions = new Set<string>();

    for (const [sid, card] of peerCards.entries()) {
      if (identity && sid === identity.session_id) continue;
      seenSessions.add(sid);
      rows.push({
        name: card.name,
        model: card.model,
        color: card.color,
        purpose: card.purpose,
        pct: card.context_used_pct,
        pending: false,
        stale: (card.staleCount ?? 0) >= 3,
        running: card.is_running ?? false,
        blocked: card.is_blocked ?? false,
        relationship: identity
          ? agentRelationship(identity.name, card.name)
          : "peer",
      });
    }

    const seenNames = new Set(rows.map((r) => r.name));
    for (const entry of registryEntries) {
      if (identity && entry.session_id === identity.session_id) continue;
      if (!includeExplicit && entry.explicit) continue;
      if (seenSessions.has(entry.session_id)) continue;
      if (seenNames.has(entry.name)) continue;
      rows.push({
        name: entry.name,
        model: entry.model,
        color: entry.color,
        purpose: entry.purpose,
        pct: null,
        pending: true,
        stale: false,
        running: false,
        blocked: false,
        relationship: identity
          ? agentRelationship(identity.name, entry.name)
          : "peer",
      });
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  function navigateToAgent(name: string): void {
    if (!identity) return;
    const target = resolveTarget(name);

    const pane = target?.tmux_pane;

    if (pane) {
      // pane_id is globally unique — select-pane handles same-window,
      // same-session-different-window, and (with switch-client) cross-session.
      try {
        // Cross-session: switch to the session containing the pane first.
        const info = spawnSync(
          "tmux",
          [
            "display-message",
            "-p",
            "-t",
            pane,
            "#{session_name}:#{window_index}",
          ],
          { encoding: "utf-8" },
        );
        if (info.status === 0 && info.stdout.trim()) {
          spawnSync("tmux", ["switch-client", "-t", info.stdout.trim()], {
            encoding: "utf-8",
          });
        }
        // Select the specific pane (works for same-window and cross-window).
        const r = spawnSync("tmux", ["select-pane", "-t", pane], {
          encoding: "utf-8",
        });
        if (r.status !== 0) {
          currentCtx?.ui?.notify?.(
            `coms: can't select pane for ${name}`,
            "error",
          );
        }
      } catch {
        currentCtx?.ui?.notify?.("coms: tmux not available", "error");
      }
      return;
    }

    // No pane ID — fall back to session:window or window-name scan.
    let tmuxTarget: string | undefined;

    if (target?.tmux_session) {
      tmuxTarget = `${target.tmux_session}:${target.tmux_window ?? name}`;
    } else {
      try {
        const list = spawnSync(
          "tmux",
          ["list-windows", "-a", "-F", "#{session_name}:#{window_name}"],
          { encoding: "utf-8" },
        );
        if (list.status === 0) {
          tmuxTarget = list.stdout
            .trim()
            .split("\n")
            .find((l) => l.endsWith(`:${name}`));
        }
      } catch {
        /* tmux not available */
      }
    }

    if (!tmuxTarget) {
      currentCtx?.ui?.notify?.(
        `coms: no tmux location found for ${name}`,
        "error",
      );
      return;
    }

    try {
      const result = spawnSync("tmux", ["switch-client", "-t", tmuxTarget], {
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        currentCtx?.ui?.notify?.(`coms: can't navigate to ${name}`, "error");
      }
    } catch {
      currentCtx?.ui?.notify?.("coms: tmux not available", "error");
    }
  }

  function closeAgent(name: string): void {
    const target = resolveTarget(name);
    const pane = target?.tmux_pane;
    if (!pane) {
      currentCtx?.ui?.notify?.(`coms: no tmux pane known for ${name}`, "error");
      return;
    }
    try {
      const r = spawnSync("tmux", ["kill-pane", "-t", pane], {
        encoding: "utf-8",
      });
      if (r.status !== 0) {
        currentCtx?.ui?.notify?.(`coms: couldn't close ${name}`, "error");
        return;
      }
      // Broadcast the goodbye on behalf of the dead peer — we're still alive
      // so there's no shutdown timing issue. All peers drop the card immediately.
      if (target?.session_id) {
        void broadcastPeerClosed(target.session_id);
      }
      // Drop from our own pool immediately too.
      peerCards.delete(target?.session_id ?? "");
      updateSpinnerTimer();
      currentTui?.requestRender?.();
    } catch {
      currentCtx?.ui?.notify?.("coms: tmux not available", "error");
    }
  }

  // ━━ Pool widget rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function renderPool(width: number, theme: Theme): string[] {
    const rows = buildPoolRows();

    if (rows.length === 0) {
      return [];
    }

    const effectiveSel = selectedIndex < rows.length ? selectedIndex : -1;
    const out: string[] = [
      truncateToWidth(
        theme.fg("dim", "coms for ") +
          hexFg(identity?.color ?? "#36F9F6", identity?.name ?? ""),
        width,
      ),
    ];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const isSelected = i === effectiveSel;
      const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;

      const relIcon = { parent: "↑", child: "↓", sibling: "~", peer: " " }[
        r.relationship
      ];

      if (r.stale) {
        const dimRow = `✗ ${relIcon}${r.name.padEnd(11)} ${abbreviateModel(r.model).padEnd(16)}  ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
        const truncated = truncateToWidth(" " + theme.fg("dim", dimRow), width);
        out.push(isSelected ? theme.bg("selectedBg", truncated) : truncated);
        continue;
      }

      const swatch = r.blocked
        ? theme.fg("warning", "⊘")
        : r.running
          ? hexFg(
              r.color,
              SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!,
            )
          : r.pending
            ? theme.fg("dim", "●")
            : hexFg(r.color, "●");
      const namePart = theme.fg("accent", r.name.padEnd(11));
      const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(16));
      const pctPart = theme.fg(
        r.pending ? "dim" : "accent",
        pctLabel.padStart(4),
      );
      const sep = theme.fg("dim", "  —  ");
      const purposePart = theme.fg("muted", r.purpose || "");

      const iconPart = theme.fg("dim", relIcon);
      const rawLine =
        " " +
        swatch +
        " " +
        iconPart +
        namePart +
        " " +
        modelPart +
        " " +
        pctPart +
        sep +
        purposePart;
      const truncated = truncateToWidth(rawLine, width);
      out.push(isSelected ? theme.bg("selectedBg", truncated) : truncated);
    }

    return out;
  }

  function installPoolWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(
        "coms-pool",
        (_tui, theme) => ({
          invalidate() {},
          render(width: number): string[] {
            return renderPool(width, theme);
          },
        }),
        { placement: "belowEditor" },
      );
    } catch {
      // non-fatal
    }
  }

  // ━━ Ping cycle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async function refreshPool(): Promise<void> {
    if (!identity) return;
    // Prune dead entries across all display pools, deduped by session_id.
    const seen = new Set<string>();
    const live: RegistryEntry[] = [];
    for (const p of allProjects()) {
      for (const e of pruneDeadEntries(p)) {
        if (!seen.has(e.session_id)) {
          seen.add(e.session_id);
          live.push(e);
        }
      }
    }

    const peers = live.filter(
      (e) =>
        e.session_id !== identity!.session_id &&
        (includeExplicit || !e.explicit),
    );

    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const pingEnv: PingEnvelope = {
          type: "ping",
          msg_id: ulid(),
          sender_session: identity!.session_id,
          sender_endpoint: identity!.endpoint,
          hops: 0,
          timestamp: nowIso(),
        };
        const reply = await sendEnvelope(peer.endpoint, pingEnv);
        return { peer, pong: reply as Pong };
      }),
    );

    const seenSessions = new Set<string>();
    let changed = false;

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.pong && r.value.pong.agent_card) {
        const { peer, pong } = r.value;
        seenSessions.add(peer.session_id);
        const prev = peerCards.get(peer.session_id);
        const next = { ...pong.agent_card, staleCount: 0 };
        if (
          !prev ||
          JSON.stringify({ ...prev, staleCount: 0 }) !== JSON.stringify(next)
        ) {
          peerCards.set(peer.session_id, next);
          updateSpinnerTimer();
          changed = true;
        }
      }
    }

    for (const [sid, card] of peerCards.entries()) {
      if (identity && sid === identity.session_id) continue;
      if (!seenSessions.has(sid)) {
        card.staleCount = (card.staleCount ?? 0) + 1;
        if (card.staleCount > 6) {
          peerCards.delete(sid);
        }
        changed = true;
      }
    }

    if (changed && currentCtx?.hasUI) {
      installPoolWidget(currentCtx);
    }
  }

  function listProjects(): string[] {
    const root = path.join(COMS_DIR, "projects");
    try {
      return fs.readdirSync(root).filter((d) => {
        try {
          return fs.statSync(path.join(root, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  function resolveTarget(target: string): RegistryEntry | null {
    // Search display pools first (own-name + extra).
    const displayEntries = readAllDisplayEntries();
    const byName = displayEntries.find((e) => e.name === target);
    if (byName) return byName;
    const bySession = displayEntries.find((e) => e.session_id === target);
    if (bySession) return bySession;
    // Fall back to scanning all projects.
    for (const proj of listProjects()) {
      const entries = pruneDeadEntries(proj);
      const e = entries.find(
        (e) => e.session_id === target || e.name === target,
      );
      if (e) return e;
    }
    return null;
  }

  // ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  pi.registerTool({
    name: "coms_list",
    label: "Coms List",
    description:
      "List peer agents discoverable via coms. Returns names, models, and live context-window usage. " +
      'Use project="*" if you must scan all projects. include_explicit=true reveals agents marked --explicit.',
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({
          description:
            'Project name, or "*" for all projects. Defaults to caller\'s project.',
        }),
      ),
      include_explicit: Type.Optional(
        Type.Boolean({
          description:
            "Include agents launched with --explicit. Default false.",
        }),
      ),
    }),
    async execute(_callId, params) {
      const includeExp = params.include_explicit === true;
      const projects =
        params.project === "*"
          ? listProjects()
          : params.project
            ? [params.project]
            : allProjects();

      const seen = new Set<string>();
      const collected: { entry: RegistryEntry; project: string }[] = [];
      for (const proj of projects) {
        for (const entry of readAllRegistryEntries(proj)) {
          if (entry.explicit && !includeExp) continue;
          if (identity && entry.session_id === identity.session_id) continue;
          if (seen.has(entry.session_id)) continue;
          seen.add(entry.session_id);
          collected.push({ entry, project: proj });
        }
      }

      // Ping each candidate in parallel; include ALL entries, annotate with alive status.
      // Never filter by ping — a slow or starting peer shouldn't be hidden from the LLM.
      const pongs = await Promise.allSettled(
        collected.map((c) => pingPeer(c.entry.endpoint)),
      );

      const agents = collected.map((c, i) => {
        const r = pongs[i];
        const pong = r.status === "fulfilled" ? r.value : null;
        return {
          name: c.entry.name,
          session_id: c.entry.session_id,
          purpose: c.entry.purpose,
          model: c.entry.model,
          cwd: c.entry.cwd,
          project: c.project,
          alive: pong != null,
          context_used_pct: pong ? pong.context_used_pct : null,
          color: c.entry.color,
        };
      });

      const lines =
        agents.length === 0
          ? "No peer agents found."
          : agents
              .map((a) => {
                const ctxStr =
                  a.context_used_pct != null
                    ? ` ${a.context_used_pct}%`
                    : " ?%";
                const live = a.alive ? "●" : "✗";
                return `${live} ${a.name} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
              })
              .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `${agents.length} peer(s):\n${lines}`,
          },
        ],
        details: { agents, project: params.project ?? null },
      };
    },
    renderCall(args, theme) {
      const proj = (args as any).project;
      const filter = proj ? ` ${proj}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_list")) +
          theme.fg("dim", filter),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const agents: any[] = details?.agents ?? [];
      const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
      if (!options.expanded || agents.length === 0) {
        return new Text(header, 0, 0);
      }
      const rows = agents
        .map((a) => {
          const dot = a.alive
            ? theme.fg("success", "●")
            : theme.fg("error", "✗");
          const pct =
            a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
          return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}`;
        })
        .join("\n");
      return new Text(header + "\n" + rows, 0, 0);
    },
  });

  pi.registerTool({
    name: "coms_send",
    label: "Coms Send",
    description:
      "Send a message to a peer agent. Fire-and-forget: returns once the receiver acks delivery. " +
      "The receiver is steered immediately and decides whether to reply via their own coms_send. " +
      "Throws if the receiver is unreachable.",
    parameters: Type.Object({
      target: Type.String({
        description:
          "Peer name (preferred, scoped to your project) or session_id (global).",
      }),
      prompt: Type.String({ description: "The message to send." }),
      conversation_id: Type.Optional(
        Type.String({
          description:
            "Optional thread id to help the receiver correlate this message to a prior exchange.",
        }),
      ),
    }),
    async execute(_callId, params) {
      if (!identity) {
        throw new Error("coms not initialised");
      }
      const target = resolveTarget(params.target);
      if (!target) {
        throw new Error(`coms: no live agent matching "${params.target}"`);
      }
      const hops = currentInbound ? currentInbound.hops + 1 : 0;
      if (hops >= MAX_HOPS) {
        throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
      }
      const msg_id = ulid();
      const env: PromptEnvelope = {
        type: "prompt",
        msg_id,
        sender_session: identity.session_id,
        sender_endpoint: identity.endpoint,
        sender_name: identity.name,
        sender_cwd: identity.cwd,
        hops,
        timestamp: nowIso(),
        prompt: params.prompt,
        conversation_id: params.conversation_id ?? null,
      };

      await sendEnvelope(target.endpoint, env);
      try {
        pi.appendEntry("coms-log", {
          event: "outbound_prompt",
          msg_id,
          target: target.name,
          hops,
        });
      } catch {
        /* best-effort */
      }

      return {
        content: [
          { type: "text" as const, text: `coms_send → ${target.name}` },
        ],
        details: {
          msg_id,
          target: target.name,
          target_session: target.session_id,
          hops,
        },
      };
    },
    renderCall(args, theme) {
      const tgt = (args as any).target ?? "?";
      const prompt = (args as any).prompt ?? "";
      const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("coms_send ")) +
          theme.fg("accent", tgt) +
          theme.fg("dim", " — ") +
          theme.fg("muted", preview),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      return new Text(
        theme.fg("success", "→ ") +
          theme.fg("accent", d.target) +
          theme.fg("dim", `  msg_id `) +
          theme.fg("warning", d.msg_id),
        0,
        0,
      );
    },
  });

  // ━━ agent_start: arm currentInbound for hop-count inheritance ━━━━━━━━━━━━━━
  // Reads hops directly from the coms-inbound message details.
  // Proactive (non-coms) turns set currentInbound = null so outbound
  // sends correctly originate at hops = 0.

  pi.on("agent_start", async (_event, ctx) => {
    if (!identity) return;
    agentRunning = true;
    broadcastStatus(true);
    selectedIndex = -1;
    const initiator = findTurnInitiator(ctx.sessionManager.getBranch());
    if (
      initiator?.type === "custom_message" &&
      initiator.customType === "coms-inbound"
    ) {
      currentInbound = {
        msg_id: initiator.details?.msg_id ?? "",
        hops: initiator.details?.hops ?? 0,
      };
    } else {
      currentInbound = null;
    }
  });

  // (agent_end auto-reply removed — agents decide whether to reply via coms_send)

  pi.on("agent_end", async () => {
    if (!identity) return;
    agentRunning = false;
    broadcastStatus(false);
  });

  // ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.registerCommand("coms", {
    description:
      "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (trimmed.includes("--all")) {
        includeExplicit = !includeExplicit;
        try {
          ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info");
        } catch {
          /* ignore */
        }
      }
      const projectMatch = trimmed.match(/--project\s+(\S+)/);
      if (projectMatch) {
        const p = projectMatch[1]!;
        if (!extraProjects.includes(p)) {
          extraProjects.push(p);
          // Also write our registry entry into the new pool so peers there can find us.
          if (identity) {
            const live: RegistryEntry = {
              session_id: identity.session_id,
              name: identity.name,
              purpose: identity.purpose,
              model: identity.model,
              color: identity.color,
              pid: process.pid,
              endpoint: identity.endpoint,
              cwd: identity.cwd,
              started_at: nowIso(),
              explicit: identity.explicit,
              version: 1,
            };
            try {
              writeRegistryAtomic(live, p);
            } catch {
              /* ignore */
            }
          }
        }
        try {
          ctx.ui.notify(
            `coms: joined project ${p} · pools: ${allProjects().join(", ")}`,
            "info",
          );
        } catch {
          /* ignore */
        }
      }
      await refreshPool();
    },
  });

  // ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let shuttingDown = false;
  async function cleanShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await broadcastStatus(false, true);
    if (pingTimer) {
      try {
        clearInterval(pingTimer);
      } catch {
        /* ignore */
      }
      pingTimer = null;
    }
    if (keepaliveTimer) {
      try {
        clearInterval(keepaliveTimer);
      } catch {
        /* ignore */
      }
      keepaliveTimer = null;
    }
    if (spinnerTimer) {
      try {
        clearInterval(spinnerTimer);
      } catch {
        /* ignore */
      }
      spinnerTimer = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      server = null;
    }
    if (identity) {
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(identity.endpoint);
        } catch {
          /* ignore */
        }
      }
      try {
        for (const p of allProjects()) {
          try {
            removeRegistryEntry(p, identity.name);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      try {
        pi.appendEntry("coms-log", {
          event: "shutdown",
          session_id: identity.session_id,
        });
      } catch {
        /* best-effort */
      }
    }
    if (currentCtx?.hasUI) {
      try {
        currentCtx.ui.setWidget("coms-pool", undefined);
      } catch {
        /* ignore */
      }
      try {
        currentCtx.ui.setEditorComponent(undefined);
      } catch {
        /* ignore */
      }
      currentTui = null;
    }
    selectedIndex = -1;
  }

  pi.on("session_shutdown", async () => {
    await cleanShutdown();
  });
  (process as any).on("pi:agent_blocked", (blocked: boolean) => {
    agentBlocked = blocked;
    void broadcastStatus(agentRunning);
  });
  process.on("SIGINT", () => {
    void cleanShutdown();
  });
  process.on("SIGTERM", () => {
    void cleanShutdown();
  });
  process.on("SIGHUP", () => {
    void cleanShutdown();
  });
}
