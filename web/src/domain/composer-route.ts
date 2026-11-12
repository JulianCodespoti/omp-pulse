/**
 * Where a composer submission goes. The omp TUI treats three leading shapes
 * specially and RPC `prompt` treats none of them, so the phone
 * has to decide before the text leaves the device:
 *
 * - `!cmd` / `!!cmd`: a user shell command (RPC `bash`). As prose the model
 *   spent a whole turn re-running it. `!!` keeps the output out of the
 *   conversation's context.
 * - `/builtin args`: omp's text handler prints `command_output`, which only the
 *   printing `/api/command` path collects. Through `/api/prompt` the output
 *   had nowhere to go.
 * - `/btw …` and `/goal …`: TUI-only as text, but each has a real RPC and a
 *   phone sheet. Other phone-added rows for TUI-only commands (`native`,
 *   e.g. `/tree`, `/new`) run their phone action instead of reaching omp.
 *
 * Skills, prompt templates and extension commands stay on the prompt path:
 * omp expands them into a message for the agent. The catalogue passed in is
 * the live `get_available_commands` list, never a hard-coded set, so a builtin
 * omp adds tomorrow routes correctly without a client release.
 */

export type CatalogueCommand = {
  name: string;
  aliases?: readonly string[];
  source?: string;
  native?: boolean;
};

export type ComposerRoute =
  | { kind: "prompt" }
  | { kind: "command"; name: string }
  | { kind: "native"; name: string }
  | { kind: "side-question"; question: string }
  | { kind: "goal"; objective: string }
  | { kind: "shell"; command: string; excludeFromContext: boolean };

const bare = (name: string): string => name.replace(/^\/+/, "").toLowerCase();

/**
 * `/name args` -> `name` (lowercased). `:` also ends the name, as in omp's
 * parser. `/tmp/notes.md` is a path, not a command.
 */
export function slashCommandName(text: string): string | null {
  const match = /^\/([^\s:]+)/.exec(text.trimStart());
  const name = match?.[1];
  return name && !name.includes("/") ? name.toLowerCase() : null;
}

/** The catalogue entry a typed name or alias refers to. */
export function findCatalogueCommand<T extends CatalogueCommand>(
  commands: readonly T[] | undefined,
  name: string,
): T | undefined {
  const wanted = bare(name);
  // Templates expand only after command dispatch. A discovery merge must
  // never let a same-name template mask a command or its alias.
  const matches = (command: T) => bare(command.name) === wanted
    || (command.aliases ?? []).some(alias => bare(alias) === wanted);
  return commands?.find(command => command.source !== "prompt" && matches(command))
    ?? commands?.find(matches);
}

/**
 * A draft whose leading shape executes something (`/cmd`, `!cmd`). Appending
 * an agent reference to one would change the command, and `!` would run the
 * reference line in the shell, so the composer refuses to combine the two.
 */
export function leadsWithCommand(text: string): boolean {
  return /^[/!]/.test(text.trimStart());
}

/**
 * Images always travel with a message: neither a shell command nor a printing
 * builtin can carry them, and silently dropping a photo is worse than sending
 * the text as prose. A draft carrying an agent reference is prose too: its
 * reference text comes from the transcript and must never reach the shell or
 * a command's arguments.
 */
export function routeComposerText(
  text: string,
  commands: readonly CatalogueCommand[] | undefined,
  hasImages = false,
  hasAgentReference = false,
): ComposerRoute {
  if (hasImages || hasAgentReference) return { kind: "prompt" };
  const trimmed = text.trim();
  if (trimmed.startsWith("!")) {
    const excludeFromContext = trimmed.startsWith("!!");
    const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
    // A lone `!` is not a command; there is nothing to run.
    return command ? { kind: "shell", command, excludeFromContext } : { kind: "prompt" };
  }
  const name = slashCommandName(trimmed);
  if (!name) return { kind: "prompt" };
  const args = trimmed.replace(/^\/[^\s:]+:?\s*/, "");
  if (name === "btw") return { kind: "side-question", question: args };
  if (name === "goal") return { kind: "goal", objective: args };
  const command = findCatalogueCommand(commands, name);
  if (command?.native) return { kind: "native", name: bare(command.name) };
  if (command?.source === "builtin") return { kind: "command", name: bare(command.name) };
  return { kind: "prompt" };
}
/** The same routing decision drives the pre-submit affordance and dispatch. */
export function composerAction(
  text: string,
  commands: readonly CatalogueCommand[] | undefined,
  hasImages = false,
  hasAgentReference = false,
): { label: "Run" | "Send"; description: string | null } {
  const route = routeComposerText(text, commands, hasImages, hasAgentReference);
  if (route.kind === "shell") {
    return {
      label: "Run",
      description: `${route.excludeFromContext ? "Output stays out of model context." : "Output enters model context."} OMP configured user shell · piped output (no terminal PTY).`,
    };
  }
  const shellText = routeComposerText(text, commands).kind === "shell";
  return {
    label: "Send",
    description: shellText
      ? `Send as a prompt with ${hasImages && hasAgentReference ? "photos and agent references" : hasImages ? "photos" : "agent references"}. Nothing runs directly.`
      : null,
  };
}

/**
 * Where a plugin's `pulse.session.prompt` text is about to go: the conversation open
 * on screen (its composer's Send path, with the live catalogue) or one that is not
 * open (the durable send, where no catalogue is loaded).
 */
export type PluginPromptTarget =
  | { kind: "open"; commands: readonly CatalogueCommand[] | undefined }
  | { kind: "not-open" };

/**
 * Why a plugin's prompt is refused, or null when it may be sent. The one rule
 * for both send routes. A plugin sends messages: skills, prompt templates and
 * extension commands are messages too (omp expands them), but a shell command
 * (that is `session.bash`), a builtin (compaction is `session.rpc`), and
 * anything that opens a sheet or app screen on the person's phone (`/btw`,
 * `/goal`, `/plan`, native rows) are not. The text is judged trimmed, as the
 * composer judges it. Without a catalogue (`not-open`) a slash command cannot
 * be told from a builtin, so every one is refused.
 */
export function pluginPromptRefusal(text: string, target: PluginPromptTarget): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("!")) return "Run commands with session.bash";
  if (target.kind === "not-open") {
    return trimmed.startsWith("/") ? "Open the conversation to run a slash command" : null;
  }
  if (/^\/plan(?:\s|$)/i.test(trimmed)) return PLUGIN_SCREEN_REFUSAL;
  const route = routeComposerText(trimmed, target.commands);
  switch (route.kind) {
    case "prompt":
      return null;
    case "command":
      return "Plugins cannot run built-in commands; use session.rpc";
    case "native":
    case "side-question":
    case "goal":
      return PLUGIN_SCREEN_REFUSAL;
    case "shell":
      return "Run commands with session.bash";
  }
}

const PLUGIN_SCREEN_REFUSAL = "Plugins cannot run commands that open app screens";


/**
 * The focus text a typed `/compact …` hands omp's `compact` RPC, or null when
 * the line names a mode (`/compact snapcompact`), which only omp's text
 * handler can parse: the RPC carries `customInstructions` and nothing else.
 * Mirrors omp's parseCompactArgs: a first word that is not a mode makes the
 * whole argument the focus. Through the text path the result never showed,
 * because under RPC omp compacts in the background and prints after replying.
 * `modes` are the command's advertised subcommand names.
 */
export function compactFocus(text: string, modes: readonly string[]): string | null {
  const args = text.trim().replace(/^\/[^\s:]+:?\s*/, "");
  const first = args.split(/\s/, 1)[0]?.toLowerCase() ?? "";
  if (first && modes.some((mode) => mode.toLowerCase() === first)) return null;
  return args;
}
