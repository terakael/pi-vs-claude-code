import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Patterns are matched at a command boundary (start of string or after a shell separator: | & ; && || etc.)
  const restrictedPatterns = [
    /rm\s+(-rf?|--recursive)/,
    /sudo(\s|$)/,
    /env(\s|$)/,
    /security\s+find-/,
    /git\s+push(\s|$)/,
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    const needsPermission = restrictedPatterns.some((pattern) =>
      new RegExp(`(^|[|&;]\\s*)\\s*` + pattern.source).test(command),
    );

    if (needsPermission) {
      // If running in headless/RPC mode where there's no UI, default to blocking
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: "Command requires confirmation but no UI is available.",
        };
      }

      // Signal to co-loaded extensions (e.g. coms) that we're blocked.
      process.emit("pi:agent_blocked", true);
      let choice: string;
      try {
        // Prompt the user in the TUI
        choice = await ctx.ui.select(
          `⚠️ The agent wants to run a restricted command:\n\n  ${command}\n\nAllow execution?`,
          ["Yes", "No"],
        );
      } finally {
        process.emit("pi:agent_blocked", false);
      }

      // Block if the user selects anything other than "Yes"
      if (choice !== "Yes") {
        return { block: true, reason: "Blocked by user." };
      }
    }

    // Return undefined to let it execute
    return undefined;
  });
}
