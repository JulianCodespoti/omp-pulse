// No "desktop" shape: every command the daemon reports is runnable from the
// phone. `buildAvailableSlashCommands` skips builtins without a text-mode
// `handle`, so a listed command always has one, and rpc-mode's `prompt`
// executes it. A shape meaning "go use your laptop" described a restriction
// that did not exist.
export type CommandShape = "pick" | "rpc" | "compose" | "drill" | "prompt";

export interface RpcAvailableSlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  subcommands?: { name: string; description?: string; usage?: string }[];
  source: string;
}

export interface OmpCommand {
  name: string;
  aliases?: string[];
  description?: string;
  hint?: string;
  subcommands?: { name: string; description?: string; usage?: string }[];
  source: string;
  shape: CommandShape;
  rpc?: string;
  picker?: "model" | "agents" | "files" | "timeline" | "settings" | "todo" | "btw" | "goal" | "plan" | "export" | "new-session" | "recent";
  /**
   * A row the phone adds because omp's command is TUI-only (no RPC-mode text
   * handler). Typed with or without arguments it runs the phone's own action;
   * sent as text, omp would hand it to the model as a chat message.
   */
  native?: boolean;
}

const PICK_MAP: Record<string, OmpCommand["picker"]> = {
  model: "model",
  models: "model",
  thinking: "model",
  agents: "agents",
  tree: "timeline",
  settings: "settings",
  // The phone has a real board; the builtin would only print "No todos" text.
  todo: "todo",
  // Should omp ever advertise `/plan`, it still toggles rather than reaching
  // the model as text.
  plan: "plan",
  // The builtin writes a file on the omp host and prints its path; the phone
  // downloads the export instead.
  export: "export",
};

// `/context` is deliberately absent: mapped to get_state it showed one
// percentage, while omp's own command prints the per-category breakdown
// (system prompt, tools, messages, compaction reserve, free). It now runs as
// a printing command like `/session`; the sheet redraws its table.
const RPC_BY_NAME: Record<string, string> = {
  compact: "compact",
  usage: "get_session_stats",
  stats: "get_session_stats",
  fast: "set_fast_mode",
  // omp's `/fork` copies the whole session; `/branch` (alias `/rewind`)
  // rewinds to before a message.
  fork: "fork",
  branch: "branch",
};

// Subcommands the phone's typed RPC path actually expresses. Every other
// subcommand of an RPC-mapped command used to resolve to the bare RPC, which
// cannot carry it: `/compact snapcompact` ran a default LLM compaction and
// `/fast ultra` toggled fast mode. Those go through the prompt path instead,
// where omp's own text handler parses the whole line.
const RPC_SUBCOMMANDS: Record<string, readonly string[]> = {
  // Native /fast status distinguishes priority from ultrafast; the RPC
  // get_state boolean intentionally cannot. Route status through OMP.
  set_fast_mode: ["on", "off"],
  // `/usage show` is the default action, which is what the bare RPC runs.
  get_session_stats: ["show"],
};

// PARITY-05: most-used builtins pinned to top of palette so they are not
// buried under rarely-used security/advisor. Exported for CommandPalette.
export const FREQUENT_BUILTINS: readonly string[] = ["model", "compact", "rename", "todo", "usage", "context"] as const;

// `/btw` is TUI-only in omp, so the RPC catalogue never lists it and a typed
// `/btw …` would reach the model as an ordinary message. omp has a real `btw`
// RPC, though, so the phone adds the row itself and opens its own sheet.
export const SIDE_QUESTION_COMMAND: OmpCommand = {
  name: "btw",
  description: "Ask a side question without interrupting the agent",
  source: "builtin",
  shape: "pick",
  picker: "btw",
  native: true,
};

// Same for `/goal`: TUI-only as text, but omp's `goal` RPC (get/create/
// pause/resume/drop) is real, so the row opens the phone's goal sheet.
export const GOAL_COMMAND: OmpCommand = {
  name: "goal",
  description: "Give the agent a goal to keep working toward",
  source: "builtin",
  shape: "pick",
  picker: "goal",
  native: true,
};

// `/plan` is TUI-only in omp as well. The daemon's helper turns plan mode on
// and off over its own RPC, so the row toggles it rather than sending the
// literal text to the model. ChatScreen swaps the description for the live
// state (PLAN_COMMAND_LEAVE_DESCRIPTION while it is on).
export const PLAN_COMMAND: OmpCommand = {
  name: "plan",
  description: "Plan first; nothing changes until you approve",
  source: "builtin",
  shape: "pick",
  picker: "plan",
  native: true,
};
export const PLAN_COMMAND_LEAVE_DESCRIPTION = "Leave plan mode";

// The rest of omp 18.8.6's TUI-only session commands. None is in the RPC
// catalogue, so without these rows a typed `/tree` fuzzy-matched `/wt`
// through its alias "worktree" and Enter opened that sheet, and `/fork` and
// `/settings` were refused as unknown. Each runs the phone's own surface.
export const TUI_ONLY_COMMANDS: readonly OmpCommand[] = [
  { name: "tree", description: "Browse this conversation's timeline and branches", source: "builtin", shape: "pick", picker: "timeline", native: true },
  { name: "agents", description: "See the agents working in this conversation", source: "builtin", shape: "pick", picker: "agents", native: true },
  { name: "settings", description: "This conversation's settings: thinking, plan mode, queueing, compaction", source: "builtin", shape: "pick", picker: "settings", native: true },
  // omp's `/fork` copies the whole conversation and continues in the copy;
  // rewinding to an earlier message is `/branch` and each message's actions.
  { name: "fork", description: "Fork this conversation into a new one and continue there", source: "builtin", shape: "rpc", rpc: "fork", native: true },
  { name: "new", description: "Start a new conversation in this project's folder", source: "builtin", shape: "pick", picker: "new-session", native: true },
  { name: "resume", description: "Switch to a recent conversation", source: "builtin", shape: "pick", picker: "recent", native: true },
];
/**
 * Phone surfaces represent TUI-owned command names. Reserve them before
 * templates, just as the native autocomplete does. Backend order remains
 * authoritative for every other command and alias.
 */
export function buildComposerCommands(raw: readonly RpcAvailableSlashCommand[], planOn: boolean): OmpCommand[] {
  const native = [SIDE_QUESTION_COMMAND, GOAL_COMMAND, PLAN_COMMAND, ...TUI_ONLY_COMMANDS];
  const reserved = new Set([...native, ...raw.filter(command => command.source !== "prompt")]
    .flatMap(command => [command.name, ...(command.aliases ?? [])].map(token => token.replace(/^\/+/, "").toLowerCase())));
  const advertised = raw
    .filter(command => command.source !== "prompt" || !reserved.has(command.name.replace(/^\/+/, "").toLowerCase()))
    .map(classifyCommand)
    .filter(command => command.picker !== "plan");
  const has = (name: string) => advertised.some(command =>
    command.name.toLowerCase() === name || command.aliases?.some(alias => alias.toLowerCase() === name));
  return [
    ...advertised,
    ...(has("btw") ? [] : [SIDE_QUESTION_COMMAND]),
    ...(has("goal") ? [] : [GOAL_COMMAND]),
    planOn ? { ...PLAN_COMMAND, description: PLAN_COMMAND_LEAVE_DESCRIPTION } : PLAN_COMMAND,
    ...TUI_ONLY_COMMANDS.filter(command => !has(command.name)),
  ];
}


/**
 * The daemon's helper registers its own commands (`pulse-plan`, `pulse-goto`,
 * …) so omp routes the phone's requests to it, and omp then lists them in
 * the catalogue like any other. They are plumbing, not something to tap.
 */
export function isInternalCommandName(name: string): boolean {
  return name.replace(/^\/+/, "").toLowerCase().startsWith("pulse-");
}

export function classifyCommand(raw: RpcAvailableSlashCommand): OmpCommand {
  const name = raw.name.replace(/^\/+/, "");
  const lower = name.toLowerCase();
  const aliases = raw.aliases?.map((alias) => alias.replace(/^\/+/, ""));
  const hint = raw.input?.hint;
  const subcommands = raw.subcommands;
  const source = raw.source ?? "builtin";
  const description = raw.description;

  const isSkill = source === "skill" || source === "file" || source === "mcp" || source === "skills" || source === "prompt";
  if (isSkill) {
    if (subcommands && subcommands.length > 0) {
      return {
        name,
        aliases,
        description,
        hint,
        subcommands,
        source,
        shape: "drill",
      };
    }
    if (hint) {
      return {
        name,
        aliases,
        description,
        hint,
        subcommands,
        source,
        shape: "compose",
      };
    }
    return {
      name,
      aliases,
      description,
      hint,
      subcommands,
      source,
      shape: "prompt",
    };
  }

  const picker = PICK_MAP[lower];
  if (picker) {
    return {
      name,
      aliases,
      description,
      hint,
      subcommands,
      source,
      shape: "pick",
      picker,
    };
  }

  // A command that has BOTH a default action and subcommands runs its default
  // when tapped, exactly like the laptop: `/usage` prints usage, it does not
  // make you pick `show` first. The subcommands stay reachable via the row's
  // drill affordance.
  const defaultRpc = RPC_BY_NAME[lower];
  if (subcommands && subcommands.length > 0) {
    return {
      name,
      aliases,
      description,
      hint,
      subcommands,
      source,
      shape: defaultRpc ? "rpc" : "drill",
      rpc: defaultRpc,
    };
  }

  if (lower === "rename") {
    return {
      name,
      aliases,
      description,
      hint,
      subcommands,
      source,
      shape: "compose",
      rpc: "set_session_name",
    };
  }

  const rpc = RPC_BY_NAME[lower];
  if (rpc) {
    return {
      name,
      aliases,
      description,
      hint,
      subcommands,
      source,
      shape: "rpc",
      rpc,
    };
  }

  // Everything left runs over the RPC prompt path rather than being refused.
  //
  // omp's rpc-mode `prompt` handler calls `executeAcpBuiltinSlashCommand`, and
  // `buildAvailableSlashCommands` skips any builtin without a `handle`
  // (`if (!command.handle) continue;`) — so every command the daemon reports
  // HAS a working text-mode handler. Marking these "desktop" sent the user to
  // their laptop for 19 commands that work fine from the phone, including
  // /review, /handoff, /export, /jobs and /share.
  //
  // A hint means the command takes free text, so collect it first; without one
  // there is nothing to ask for and the bare command is sent.
  return {
    name,
    aliases,
    description,
    hint,
    subcommands,
    source,
    shape: hint ? "compose" : "prompt",
  };
}

/**
 * Does this usage string declare an argument the command cannot run without?
 *
 * omp writes usage in the standard notation: `<x>` is required, `[x]` is
 * optional. `/todo start <task>` is useless bare; `/advisor dump [raw]` is
 * perfectly valid bare. Strip the optional groups — including nested ones like
 * `[--url <url>]` — and see whether a required placeholder survives.
 */
export function requiresArgument(usage?: string): boolean {
  if (!usage) return false;
  let rest = usage;
  let previous: string;
  do {
    previous = rest;
    rest = rest.replace(/\[[^[\]]*\]/g, "");
  } while (rest !== previous);
  return /<[^>]+>/.test(rest);
}

export function resolveDrill(cmd: OmpCommand, subName: string): OmpCommand | null {
  const lower = cmd.name.toLowerCase();
  const source = cmd.source ?? "builtin";
  const sub = cmd.subcommands?.find((s) => s.name === subName);
  const usage = sub?.usage;
  const hasUsage = typeof usage === "string" && usage.trim().length > 0;
  const isSkill = source === "skill" || source === "file" || source === "mcp" || source === "skills";

  if (isSkill) {
    if (hasUsage) {
      // PARITY-07: only force a sheet when the argument is required.
      const needsArg = requiresArgument(usage);
      return {
        name: `${cmd.name} ${subName}`,
        aliases: undefined,
        description: sub?.description ?? cmd.description,
        hint: usage,
        subcommands: undefined,
        source,
        shape: needsArg ? "compose" : "prompt",
      };
    }
    return {
      name: `${cmd.name} ${subName}`,
      aliases: undefined,
      description: sub?.description ?? cmd.description,
      hint: undefined,
      subcommands: undefined,
      source,
      shape: "prompt",
    };
  }

  const rpc = RPC_BY_NAME[lower] ?? (lower === "rename" ? "set_session_name" : undefined);
  if (rpc) {
    if (lower === "rename" || hasUsage) {
      if (hasUsage) {
        const needsArg = requiresArgument(usage);
        if (!needsArg) {
          return {
            name: `${cmd.name} ${subName}`,
            aliases: undefined,
            description: sub?.description ?? cmd.description,
            hint: usage,
            subcommands: undefined,
            source,
            shape: "prompt",
          };
        }
        return {
          name: `${cmd.name} ${subName}`,
          aliases: undefined,
          description: sub?.description ?? cmd.description,
          hint: usage,
          subcommands: undefined,
          source,
          shape: "compose",
          rpc,
        };
      }
      return {
        name: `${cmd.name} ${subName}`,
        aliases: undefined,
        description: sub?.description ?? cmd.description,
        hint: usage ?? undefined,
        subcommands: undefined,
        source,
        shape: "compose",
        rpc,
      };
    }
    // A subcommand the RPC cannot express runs as typed text, like the
    // terminal, rather than silently becoming the bare command.
    const expressible = RPC_SUBCOMMANDS[rpc]?.includes(subName.toLowerCase()) ?? false;
    return {
      name: `${cmd.name} ${subName}`,
      aliases: undefined,
      description: sub?.description ?? cmd.description,
      hint: undefined,
      subcommands: undefined,
      source,
      shape: expressible ? "rpc" : "prompt",
      rpc: expressible ? rpc : undefined,
    };
  }

  // A subcommand that declares a `usage` takes an argument, so collect it
  // before sending — exactly as the terminal makes you type the objective after
  // /goal rather than firing a bare command. For optional hints the bare form
  // is valid, so do not force a sheet.
  if (hasUsage) {
    const needsArg = requiresArgument(usage);
    return {
      name: `${cmd.name} ${subName}`,
      aliases: undefined,
      description: sub?.description ?? cmd.description,
      hint: usage,
      subcommands: undefined,
      source,
      shape: needsArg ? "compose" : "prompt",
    };
  }

  // `/name sub` goes through the same RPC prompt path as a bare command —
  // executeAcpBuiltinSlashCommand parses the whole line, subcommand included.
  return {
    name: `${cmd.name} ${subName}`,
    aliases: undefined,
    description: sub?.description ?? cmd.description,
    hint: undefined,
    subcommands: undefined,
    source,
    shape: "prompt",
  };
}

export function liveStateFor(
  name: string,
  ctx: { model?: string; contextPercent?: number; agentWorking: boolean },
): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "model" || lower === "models") {
    return ctx.model ?? undefined;
  }
  if (lower === "context") {
    if (typeof ctx.contextPercent === "number" && Number.isFinite(ctx.contextPercent)) {
      return `${Math.round(ctx.contextPercent)}%`;
    }
    return undefined;
  }
  return undefined;
}
