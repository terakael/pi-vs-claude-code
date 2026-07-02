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
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

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
async function waitForComsRegistry(comsName: string, project: string, timeoutMs = 10_000): Promise<boolean> {
	const comsDir = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
	const registryFile = path.join(comsDir, "projects", project, "agents", `${comsName}.json`);
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await new Promise<void>(r => setTimeout(r, 150));
		if (fs.existsSync(registryFile)) return true;
	}
	return false;
}

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── State ─────────────────────────────────────────────────────────────────────

interface SubState {
	id: number;
	task: string;
	tmuxSession: string;   // shared subs session, e.g. "main-subs"
	tmuxWindow: string;    // per-subagent window name = comsName
	comsName: string;      // coms identity, e.g. "agent-X7K2M9-sub-1"
	sessionFile: string;
	startedAt: number;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agents: Map<number, SubState> = new Map();
	let nextId = 1;

	function makeSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
	}

	async function isAlive(state: SubState): Promise<boolean> {
		try {
			const windows = await tmux("list-windows", "-t", state.tmuxSession, "-F", "#{window_name}");
			return windows.split("\n").includes(state.tmuxWindow);
		} catch {
			return false;
		}
	}

	async function spawnSubagent(task: string, purposeOverride: string | undefined, ctx: any): Promise<SubState> {
		const id = nextId++;
		const sessionFile = makeSessionFile(id);
		const comsName = `${process.env.PI_COMS_NAME ?? "agent"}-sub-${id}`;
		const comsProject = process.env.PI_COMS_PROJECT ?? "default";
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

		const extDir = path.dirname(new URL(import.meta.url).pathname);
		const comsExt = path.join(extDir, "coms.ts");
		const widgetExt = path.join(extDir, "subagent-widget.ts");

		const purpose = (purposeOverride ?? task).slice(0, 80).replace(/\s+/g, " ").trim();

		const piCmd = [
			"pi",
			"-e", shellQuote(comsExt),
			"-e", shellQuote(widgetExt),
			"--cname", shellQuote(comsName),
			"--project", shellQuote(comsProject),
			"--session", shellQuote(sessionFile),
			"--purpose", shellQuote(purpose),
			...(model ? ["--model", shellQuote(model)] : []),
		].join(" ");

		const parentSession = await currentTmuxSession();
		const subsSession = `${process.env.PI_COMS_NAME ?? parentSession}-subs`;
		const tmuxWindow = comsName;
		const envArgs = ["-e", `PI_PARENT_SESSION=${parentSession}`, "-e", `PI_COMS_PROJECT=${comsProject}`];

		// Try to create the shared session; if it already exists (including the
		// race where a parallel spawn beat us to it), add a window instead.
		try {
			await tmux("new-session", "-d", "-s", subsSession, "-n", tmuxWindow, ...envArgs, piCmd);
		} catch {
			await tmux("new-window", "-t", subsSession, "-n", tmuxWindow, ...envArgs, piCmd);
		}

		await waitForComsRegistry(comsName, comsProject);
		await tmux("send-keys", "-t", `${subsSession}:${tmuxWindow}`, task, "Enter");

		const state: SubState = { id, task, tmuxSession: subsSession, tmuxWindow, comsName, sessionFile, startedAt: Date.now() };
		agents.set(id, state);
		return state;
	}

	// ── Navigator UI ──────────────────────────────────────────────────────────

	async function openNavigator(ctx: any): Promise<void> {
		// Prune dead sessions
		for (const state of Array.from(agents.values())) {
			if (!(await isAlive(state))) agents.delete(state.id);
		}

		if (agents.size === 0) {
			ctx.ui.notify("No active subagents. Use /sub <task> to start one.", "info");
			return;
		}

		const items: SelectItem[] = Array.from(agents.values()).map(s => ({
			value: String(s.id),
			label: s.task.length > 52 ? s.task.slice(0, 49) + "…" : s.task,
			description: `#${s.id}  ·  ${s.comsName}  ·  ${Math.round((Date.now() - s.startedAt) / 1000)}s  ·  ${s.tmuxSession}`,
		}));

		const chosen = await ctx.ui.custom<string | null>(
			(tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", " Subagents"), 1, 0));

				const list = new SelectList(items, Math.min(items.length + 2, 12), {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText:   (t: string) => theme.fg("accent", t),
					description:    (t: string) => theme.fg("muted", t),
					scrollInfo:     (t: string) => theme.fg("dim", t),
					noMatch:        (t: string) => theme.fg("warning", t),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(null);
				container.addChild(list);

				container.addChild(new Text(theme.fg("dim", " ↑↓ navigate  ·  enter open  ·  esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render:      (w: number) => container.render(w),
					invalidate:  ()          => container.invalidate(),
					handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
				};
			},
			{ overlay: true },
		);

		if (chosen !== null) {
			const state = agents.get(parseInt(chosen));
			if (state) {
				// Switch the current terminal client into the subagent's tmux session.
				// Use ctrl+b L (last session) or ctrl+b s (session picker) to return.
				await tmux("switch-client", "-t", `${state.tmuxSession}:${state.tmuxWindow}`);
			}
		}
	}

	// ── /sub ──────────────────────────────────────────────────────────────────

	pi.registerCommand("sub", {
		description: "Spawn a subagent (/sub <task>) or navigate running ones (/sub)",
		handler: async (args, ctx) => {
			if (!process.env.TMUX) {
				ctx.ui.notify("Not in a tmux session — start pi inside tmux to use /sub.", "warning");
				return;
			}

			const task = args?.trim();

			if (task) {
				const state = await spawnSubagent(task, ctx);
				ctx.ui.notify(`Subagent #${state.id}  ·  ${state.tmuxSession}:${state.tmuxWindow}  ·  coms: ${state.comsName}`, "success");
				return;
			}

			await openNavigator(ctx);
		},
	});

	// ── LLM tools ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_create",
		description: "Spawn a background subagent in its own tmux session running a full Pi TUI. Returns the subagent ID and tmux session name.",
		parameters: Type.Object({
			task: Type.String({ description: "The complete task description for the subagent to perform" }),
			purpose: Type.Optional(Type.String({ description: "Short label (≤80 chars) shown in the coms pool widget. Defaults to the first 80 chars of task." })),
		}),
		execute: async (_callId, args, _signal, _onUpdate, ctx) => {
			if (!process.env.TMUX) {
				return { content: [{ type: "text", text: "Error: not in a tmux session. subagent_create requires tmux." }] };
			}
			const state = await spawnSubagent(args.task, args.purpose, ctx);
			return {
				content: [{ type: "text", text: `Subagent #${state.id} spawned  ·  tmux: "${state.tmuxSession}"  ·  coms: "${state.comsName}"  ·  use coms_send target="${state.comsName}" to send it messages` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		description: "List all active subagents with their IDs and tmux session names.",
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

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		agents.clear();
		nextId = 1;

		// If we were spawned as a subagent, register a shortcut to jump back
		// to the parent tmux session and inject a standing system-prompt
		// instruction to always report results back via coms_send.
		const parent = process.env.PI_PARENT_SESSION;
		const parentComsName = process.env.PI_COMS_NAME?.replace(/-sub-\d+$/, "");
		const isSubagent = parentComsName && parentComsName !== process.env.PI_COMS_NAME;
		// Standing instruction: subagents always report back when done.
		if (isSubagent) {
			pi.on("before_agent_start", async (event) => {
				return {
					systemPrompt: event.systemPrompt +
						`\n\nYou are a subagent. When you have completed your task, you MUST send your result back to your parent agent using the coms_send tool with target="${parentComsName}". Do not finish without doing this.`,
				};
			});
		}
	});
}
