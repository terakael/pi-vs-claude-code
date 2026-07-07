/**
 * Subagent Widget — tmux-based subagents with a navigator UI
 *
 * Each subagent is a full Pi TUI running in a detached tmux session.
 * Jump into any of them live from the navigator.
 *
 * Usage: pi -e extensions/subagent-widget.ts   (must be inside tmux)
 * Then:
 *   /sub <task>   — spawn a new subagent
 *   /sub          — open navigator to pick and enter a running subagent
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pickSubagentName } from "./naming.ts";

const { execFile } = require("child_process") as typeof import("child_process");

// ── Tmux helpers ──────────────────────────────────────────────────────────────

function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function currentTmuxSession(): Promise<string> {
  return tmux("display-message", "-p", "#S");
}

// Wait for the subagent's coms registry entry to appear — a reliable signal
// that Pi has fully initialised (coms session_start completed and the socket
// is bound). Much more deterministic than polling pane content.
async function waitForComsRegistry(
  comsName: string,
  project: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const comsDir =
    process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
  const registryFile = path.join(
    comsDir,
    "projects",
    project,
    "agents",
    `${comsName}.json`,
  );
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 150));
    if (fs.existsSync(registryFile)) return true;
  }
  return false;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Agent file discovery ──────────────────────────────────────────────────────

interface AgentDef {
  name: string;
  description: string;
  tools?: string;
  model?: string;
  filePath: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

function scanAgentDir(dir: string): AgentDef[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const filePath = path.join(dir, f);
        const content = fs.readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        return {
          name: fm.name ?? f.slice(0, -3),
          description: fm.description ?? "",
          tools: fm.tools,
          model: fm.model,
          filePath,
        };
      });
  } catch {
    return [];
  }
}

function buildAgentsTable(defs: AgentDef[]): string {
  if (defs.length === 0) return "";
  let out =
    `## Available Specialist Agents\n\n` +
    `You have permission to spawn any of these autonomously — no need to ask first. ` +
    `Spawned subagents are persistent: their context window stays intact between messages, so you can ` +
    `send follow-up questions or additional tasks to the same agent via coms_send rather than spawning a new one. ` +
    `Prefer delegation when a task is self-contained, would consume significant context, ` +
    `or fits a specialist's profile — and treat spawned agents as long-lived collaborators rather than single-use workers.` +
    ` Use \`subagent_create(task: "...", agent: "<name>")\` to spawn and \`coms_send\` to continue the conversation.\n\n`;
  for (const d of defs)
    out += `- **${d.name}**: ${d.description}${d.model ? ` _(model: ${d.model})_` : ""}\n`;
  return out;
}

function findProjectAgentDir(): string | undefined {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
}

function resolveAgentFile(name: string): string | undefined {
  const projectDir = findProjectAgentDir();
  if (projectDir) {
    const local = path.join(projectDir, `${name}.md`);
    if (fs.existsSync(local)) return local;
  }
  const global_ = path.join(os.homedir(), ".pi", "agent", "agents", `${name}.md`);
  if (fs.existsSync(global_)) return global_;
  return undefined;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface SubState {
  id: number;
  task: string;
  tmuxSession: string; // shared subs session, e.g. "main-subs"
  tmuxWindow: string; // per-subagent window name = comsName
  comsName: string; // coms identity, e.g. "amber-basin"
  sessionFile: string;
  startedAt: number;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agents: Map<number, SubState> = new Map();
  let nextId = 1;
  let agentDefs: AgentDef[] = [];
  let agentsTable = "";

  function makeSessionFile(id: number): string {
    const dir = path.join(
      os.homedir(),
      ".pi",
      "agent",
      "sessions",
      "subagents",
    );
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
  }

  async function isAlive(state: SubState): Promise<boolean> {
    try {
      const windows = await tmux(
        "list-windows",
        "-t",
        state.tmuxSession,
        "-F",
        "#{window_name}",
      );
      return windows.split("\n").includes(state.tmuxWindow);
    } catch {
      return false;
    }
  }

  async function spawnSubagent(
    task: string,
    purposeOverride: string | undefined,
    agentName: string | undefined,
    modelOverride: string | undefined,
    ctx: any,
  ): Promise<SubState> {
    const id = nextId++;
    const sessionFile = makeSessionFile(id);
    const parentName = process.env.PI_COMS_NAME ?? "agent";
    // Scan parent's pool to find live names for collision avoidance.
    const comsDir = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
    const poolDir = path.join(comsDir, "projects", parentName, "agents");
    const existingNames = new Set<string>();
    try {
      for (const f of fs.readdirSync(poolDir)) {
        if (f.endsWith(".json")) existingNames.add(f.slice(0, -5));
      }
    } catch { /* pool dir may not exist yet */ }
    const comsName = pickSubagentName(parentName, existingNames);
    // Subagents always join the parent's own-name pool, regardless of what
    // named pool the parent is in. This keeps subagents invisible to other
    // named-pool peers while still reachable by the parent.
    const comsProject = parentName;
    // Model precedence: explicit param > agent profile frontmatter > parent model.
    let profileModel: string | undefined;
    if (agentName) {
      const pf = resolveAgentFile(agentName);
      if (pf) profileModel = parseFrontmatter(fs.readFileSync(pf, "utf8")).model;
    }
    const model =
      modelOverride ??
      profileModel ??
      (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

    const extDir = path.dirname(new URL(import.meta.url).pathname);
    const comsExt = path.join(extDir, "coms.ts");
    const widgetExt = path.join(extDir, "subagent-widget.ts");

    const purpose = (purposeOverride ?? task)
      .slice(0, 80)
      .replace(/\s+/g, " ")
      .trim();

    const piCmd = [
      "pi",
      "-e",
      shellQuote(comsExt),
      "-e",
      shellQuote(widgetExt),
      "--cname",
      shellQuote(comsName),
      "--project",
      shellQuote(comsProject),
      "--session",
      shellQuote(sessionFile),
      "--purpose",
      shellQuote(purpose),

      ...(model ? ["--model", shellQuote(model)] : []),
    ].join(" ");

    const parentSession = await currentTmuxSession();
    const subsSession = `${process.env.PI_COMS_NAME ?? parentSession}-subs`;
    const tmuxWindow = comsName;
    const envArgs = [
      "-e",
      `PI_PARENT_SESSION=${parentSession}`,
      "-e",
      `PI_COMS_PROJECT=${comsProject}`,
      ...(agentName ? ["-e", `PI_AGENT_PROFILE=${agentName}`] : []),
    ];

    // Try to create the shared session; if it already exists (including the
    // race where a parallel spawn beat us to it), add a window instead.
    try {
      await tmux(
        "new-session",
        "-d",
        "-s",
        subsSession,
        "-n",
        tmuxWindow,
        ...envArgs,
        piCmd,
      );
    } catch {
      await tmux(
        "new-window",
        "-t",
        subsSession,
        "-n",
        tmuxWindow,
        ...envArgs,
        piCmd,
      );
    }

    await waitForComsRegistry(comsName, comsProject);
    const taskWithReporting =
      task +
      `\n\nIMPORTANT: When you have completed this task, you MUST send your result back to the parent agent using the coms_send tool with target="${parentName}". Do not skip this — it is required even for simple or short tasks. Do not just reply in chat.`;
    await tmux(
      "send-keys",
      "-t",
      `${subsSession}:${tmuxWindow}`,
      taskWithReporting,
      "Enter",
    );

    const state: SubState = {
      id,
      task,
      tmuxSession: subsSession,
      tmuxWindow,
      comsName,
      sessionFile,
      startedAt: Date.now(),
    };
    agents.set(id, state);
    return state;
  }

  // ── LLM tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_create",
    description:
      "Spawn a background subagent in its own tmux session running a full Pi TUI. The subagent is automatically instructed to report results back to you via coms_send — do not repeat this in the task. Write the task as a natural prompt; it is delivered as the subagent's first user message. Returns the subagent ID and tmux session name.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The complete task description for the subagent to perform",
      }),
      purpose: Type.Optional(
        Type.String({
          description:
            "Short label (≤80 chars) shown in the coms pool widget. Defaults to the first 80 chars of task.",
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            "Name of a specialist agent profile to apply (stem of a .md file in .pi/agents/ or ~/.pi/agent/agents/). The file's full contents are appended to the subagent's system prompt.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model to run the subagent on, as 'provider/id' (e.g. 'openrouter/google/gemini-3-flash-preview'). Overrides the agent profile's model and the parent's model. Use this to run cheaper workers on cheaper models.",
        }),
      ),
    }),
    execute: async (_callId, args, _signal, _onUpdate, ctx) => {
      if (!process.env.TMUX) {
        return {
          content: [
            {
              type: "text",
              text: "Error: not in a tmux session. subagent_create requires tmux.",
            },
          ],
        };
      }
        if (args.agent && !resolveAgentFile(args.agent)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent profile "${args.agent}" not found in .pi/agents/ or ~/.pi/agent/agents/.`,
            },
          ],
        };
      }
      const state = await spawnSubagent(args.task, args.purpose, args.agent, args.model, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Subagent #${state.id} spawned  ·  tmux: "${state.tmuxSession}"  ·  coms: "${state.comsName}"  ·  use coms_send target="${state.comsName}" to send it messages  ·  it has been instructed to report back to you at "${process.env.PI_COMS_NAME}"`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    description:
      "List all active subagents with their IDs and tmux session names.",
    parameters: Type.Object({}),
    execute: async () => {
      const alive: string[] = [];
      for (const s of agents.values()) {
        if (await isAlive(s)) {
          alive.push(`#${s.id}  ${s.tmuxSession}  "${s.task}"`);
        } else {
          agents.delete(s.id);
        }
      }
      if (alive.length === 0) {
        return { content: [{ type: "text", text: "No active subagents." }] };
      }
      return { content: [{ type: "text", text: alive.join("\n") }] };
    },
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    agents.clear();
    nextId = 1;

    // Scan agent profile dirs — project-local first, then global.
    // Deduplicate by name: project-local files shadow global ones.
    const cwd = process.cwd();
    const localDefs = scanAgentDir(findProjectAgentDir() ?? "");
    const globalDefs = scanAgentDir(
      path.join(os.homedir(), ".pi", "agent", "agents"),
    );
    const seen = new Set(localDefs.map((d) => d.name));
    agentDefs = [...localDefs, ...globalDefs.filter((d) => !seen.has(d.name))];
    agentsTable = buildAgentsTable(agentDefs);

    // If we were spawned as a subagent, inject a standing system-prompt
    // instruction to always report results back via coms_send.
    const ownComsName = process.env.PI_COMS_NAME;
    const isSubagent = !!process.env.PI_PARENT_SESSION;
    const projectArgIdx = process.argv.indexOf("--project");
    const projectArgVal =
      projectArgIdx >= 0 ? process.argv[projectArgIdx + 1] : undefined;
    const parentComsName =
      isSubagent && projectArgVal && projectArgVal !== "default"
        ? projectArgVal
        : undefined;

    // If spawned with a named agent profile, read + strip frontmatter once.
    const agentProfileName = process.env.PI_AGENT_PROFILE;
    let agentProfileBody: string | undefined;
    if (agentProfileName) {
      const profilePath = resolveAgentFile(agentProfileName);
      if (profilePath) {
        const raw = fs.readFileSync(profilePath, "utf8");
        // Strip YAML frontmatter (--- ... ---) and trim leading whitespace.
        agentProfileBody = raw.replace(/^---[\s\S]*?\n---\n?/, "").trimStart();
      }
    }

    pi.on("before_agent_start", async (event) => {
      let sp = event.systemPrompt;
      if (ownComsName) {
        sp += `\n\nYour coms name is "${ownComsName}".`;
      }
      if (isSubagent) {
        sp += ` You are a subagent. When you have completed your task, you MUST send your result back to your parent agent using the coms_send tool with target="${parentComsName}". Do not finish without doing this.`;
      }
      if (agentProfileBody) {
        sp += `\n\n## Agent Profile: ${agentProfileName}\n\n${agentProfileBody}`;
      }
      if (agentsTable) {
        sp += `\n\n${agentsTable}`;
      }
      return { systemPrompt: sp };
    });
  });
}
