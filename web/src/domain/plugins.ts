import { isJsonObject } from "./protocol";

// Wire and view types for client plugins, plus the validator that decides what a plugin
// script is allowed to put on screen. Framework-free: the daemon catalogue and the
// worker's return values both arrive here as `unknown` and leave as typed, bounded data.

export const PLUGIN_SLOTS = [
  "composer.status",
  "composer.actions",
  "drawer",
  "page",
  "session.row",
  "session.menu",
  "transcript.tool",
  "transcript.message",
] as const;
export type PluginSlotId = (typeof PLUGIN_SLOTS)[number];
/** Slots drawn once per thing on screen (a row, a menu, a card), keyed by that thing's id. */
export const KEYED_SLOTS = ["session.row", "session.menu", "transcript.tool", "transcript.message"] as const;
export type KeyedSlotId = (typeof KEYED_SLOTS)[number];
export type UnkeyedSlotId = Exclude<PluginSlotId, KeyedSlotId>;

export function isKeyedSlot(slot: PluginSlotId): slot is KeyedSlotId {
  return (KEYED_SLOTS as readonly string[]).includes(slot);
}

export const PLUGIN_PERMISSIONS = ["session.read", "session.compose", "session.prompt", "session.bash", "session.rpc"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export type PluginStatus = "enabled" | "disabled" | "needs_review" | "invalid";

export interface PluginSourceInfo {
  id: string;
  command: string[];
  intervalS: number;
  timeoutS: number;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  status: PluginStatus;
  hash: string;
  slots: string[];
  sources: PluginSourceInfo[];
  linked: boolean;
  /** True when `needs_review` is because an approved plugin's files changed. */
  changed: boolean;
  permissions: PluginPermission[];
  /** Claim patterns for `transcript.tool` (tool names). */
  tools: string[];
  /** Claim patterns for `transcript.message` (custom message types). */
  messages: string[];
  options: PluginOptionInfo[];
  optionValues: PluginOptionValues;
  actions: PluginActionInfo[];
  /** Files in the plugin folder its commands use that the approval hash does not cover, one sentence each. */
  warnings: string[];
  error?: string;
}

export interface PluginSourceReading {
  ok: boolean;
  text: string;
  exitCode: number | null;
  fetchedAtMs: number;
  truncated: boolean;
  error?: string;
}

export interface PluginOptionInfo {
  id: string;
  label: string;
  type: "bool" | "choice" | "text";
  choices: string[];
  default: boolean | string;
}

export type PluginOptionValues = Record<string, boolean | string>;

export interface PluginActionInfo {
  id: string;
  label: string;
  command: string[];
  argPattern?: string;
  timeoutS: number;
}

export type PluginActionResult = PluginSourceReading;

export interface PluginSessionInfo {
  id: string;
  title: string;
  cwd: string;
  model: string;
  status: "idle" | "working" | "needs-you";
  activeAt: number | null;
}

export interface PluginToolCallInfo {
  id: string;
  name: string;
  args: unknown;
  output: string;
  state: "running" | "done" | "error";
  truncated: boolean;
}

export interface PluginMessageInfo {
  id: string;
  customType: string;
  text: string;
  details: unknown;
  truncated: boolean;
}

export interface PluginRenderContext {
  session: PluginSessionInfo | null;
  call?: PluginToolCallInfo;
  message?: PluginMessageInfo;
}

export type PluginTone = "neutral" | "accent" | "success" | "warning" | "error" | "muted";
export type PluginNodeKind = "text" | "chip" | "row" | "col" | "card" | "kv" | "list" | "progress" | "button" | "empty";

/** Tern's node shape: kind, props, children. Always the NORMALISED form after validation. */
export interface PluginNode {
  k: PluginNodeKind;
  p: Record<string, unknown>;
  c: PluginNode[];
}

type PluginViewResult = { ok: true; view: PluginNode | null } | { ok: false; error: string };

const STATUSES: readonly string[] = ["enabled", "disabled", "needs_review", "invalid"];
const TONES: readonly string[] = ["neutral", "accent", "success", "warning", "error", "muted"];
const GAPS: readonly string[] = ["sm", "md"];
const VARIANTS: readonly string[] = ["default", "primary", "danger"];
const NODE_KINDS: readonly string[] = ["text", "chip", "row", "col", "card", "kv", "list", "progress", "button", "empty"];
const MAX_VIEW_BYTES = 65536;
const MAX_ACTION_CHARS = 64;
const MAX_KV_ITEMS = 50;
const MAX_LIST_ITEMS = 100;

interface SlotRule {
  kinds: readonly PluginNodeKind[];
  maxNodes: number;
  maxDepth: number;
  /** Rows may hold only chips. */
  chipsOnly?: boolean;
  /** The view is a menu: its list has at most this many items and must carry `actions.click`. */
  menuItems?: number;
}

const ALL_KINDS = NODE_KINDS as readonly PluginNodeKind[];

const SLOT_RULES: Record<PluginSlotId, SlotRule> = {
  "composer.status": { kinds: ["chip", "row"], maxNodes: 4, maxDepth: 2, chipsOnly: true },
  "composer.actions": { kinds: ["list"], maxNodes: 1, maxDepth: 1, menuItems: 8 },
  drawer: { kinds: ["chip", "text", "progress", "row", "col"], maxNodes: 12, maxDepth: 3 },
  page: { kinds: ALL_KINDS, maxNodes: 300, maxDepth: 8 },
  "session.row": { kinds: ["chip", "row"], maxNodes: 3, maxDepth: 2, chipsOnly: true },
  "session.menu": { kinds: ["list"], maxNodes: 1, maxDepth: 1, menuItems: 6 },
  "transcript.tool": { kinds: ALL_KINDS, maxNodes: 120, maxDepth: 6 },
  "transcript.message": { kinds: ALL_KINDS, maxNodes: 120, maxDepth: 6 },
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parsePluginInfo(raw: unknown): PluginInfo | null {
  if (!isJsonObject(raw)) return null;
  const { id, name, version, description, status, hash, slots, sources, linked, error } = raw;
  if (!isString(id) || !isString(name) || !isString(version) || !isString(description) || !isString(hash)) return null;
  if (!isString(status) || !STATUSES.includes(status)) return null;
  if (typeof linked !== "boolean") return null;
  if (!Array.isArray(slots) || !slots.every(isString)) return null;
  if (!Array.isArray(sources)) return null;
  const parsedSources: PluginSourceInfo[] = [];
  for (const source of sources) {
    const parsed = parseSourceInfo(source);
    if (!parsed) return null;
    parsedSources.push(parsed);
  }
  const permissions = optionalList(raw.permissions);
  const tools = optionalList(raw.tools);
  const messages = optionalList(raw.messages);
  const warnings = optionalList(raw.warnings);
  if (!permissions || !tools || !messages || !warnings) return null;
  const options = parseEach(raw.options, parseOptionInfo);
  const actions = parseEach(raw.actions, parseActionInfo);
  if (!options || !actions) return null;
  const optionValues = parseOptionValues(raw.optionValues);
  if (!optionValues) return null;
  const info: PluginInfo = {
    id,
    name,
    version,
    description,
    status: status as PluginStatus,
    hash,
    slots: [...slots],
    sources: parsedSources,
    linked,
    changed: raw.changed === true,
    permissions: permissions.filter((entry): entry is PluginPermission => (PLUGIN_PERMISSIONS as readonly string[]).includes(entry)),
    tools,
    messages,
    options,
    optionValues,
    actions,
    warnings,
  };
  if (isString(error)) info.error = error;
  return info;
}

/** A missing list is empty; a present one must hold only strings. */
function optionalList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every(isString)) return null;
  return [...raw];
}

/**
 * An argv as typed into a shell, quoting only what needs it, so the review shows
 * the exact arguments: `["sh","-c","a b"]` and `["sh","-c","a","b"]` must not read
 * alike. The CLI prints the same (src/bin/omp-pulse/plugin.rs `argv_line`).
 */
export function argvLine(command: readonly string[]): string {
  return command.map((arg) => (/^[A-Za-z0-9\-_./:=@%+,{}]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

/** A missing list is empty; one malformed entry makes the whole list null. */
function parseEach<T>(raw: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

function parseOptionInfo(raw: unknown): PluginOptionInfo | null {
  if (!isJsonObject(raw)) return null;
  const { id, label, type, choices } = raw;
  if (!isString(id) || !isString(label)) return null;
  if (type !== "bool" && type !== "choice" && type !== "text") return null;
  const parsedChoices = optionalList(choices);
  if (!parsedChoices) return null;
  const fallback = raw.default;
  if (typeof fallback !== "boolean" && !isString(fallback)) return null;
  return { id, label, type, choices: parsedChoices, default: fallback };
}

function parseActionInfo(raw: unknown): PluginActionInfo | null {
  if (!isJsonObject(raw)) return null;
  const { id, label, command, argPattern, timeoutS } = raw;
  if (!isString(id) || !isString(label) || !Array.isArray(command) || !command.every(isString)) return null;
  if (!isFiniteNumber(timeoutS)) return null;
  if (argPattern !== undefined && argPattern !== null && !isString(argPattern)) return null;
  const info: PluginActionInfo = { id, label, command: [...command], timeoutS };
  if (isString(argPattern)) info.argPattern = argPattern;
  return info;
}

/** Keeps only boolean and string values; anything else a daemon sent is ignored. */
function parseOptionValues(raw: unknown): PluginOptionValues | null {
  if (raw === undefined || raw === null) return {};
  if (!isJsonObject(raw)) return null;
  const out: PluginOptionValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean" || isString(value)) out[key] = value;
  }
  return out;
}

function parseSourceInfo(raw: unknown): PluginSourceInfo | null {
  if (!isJsonObject(raw)) return null;
  const { id, command, intervalS, timeoutS } = raw;
  if (!isString(id) || !Array.isArray(command) || !command.every(isString)) return null;
  if (!isFiniteNumber(intervalS) || !isFiniteNumber(timeoutS)) return null;
  return { id, command: [...command], intervalS, timeoutS };
}

export function parsePluginSourceReading(raw: unknown): PluginSourceReading | null {
  if (!isJsonObject(raw)) return null;
  const { ok, text, exitCode, fetchedAtMs, truncated, error } = raw;
  if (typeof ok !== "boolean" || !isString(text) || typeof truncated !== "boolean") return null;
  if (!isFiniteNumber(fetchedAtMs)) return null;
  if (exitCode !== null && exitCode !== undefined && !isFiniteNumber(exitCode)) return null;
  const reading: PluginSourceReading = {
    ok,
    text,
    exitCode: exitCode === undefined ? null : exitCode,
    fetchedAtMs,
    truncated,
  };
  if (isString(error)) reading.error = error;
  return reading;
}

/** Validate and normalise what a plugin returned for a slot. Never throws. `view: null` = show nothing. */
export function validatePluginView(slot: PluginSlotId, raw: unknown): PluginViewResult {
  if (raw === null || raw === undefined) return { ok: true, view: null };
  const rule = Object.hasOwn(SLOT_RULES, slot) ? SLOT_RULES[slot] : undefined;
  if (!rule) return { ok: false, error: "unknown plugin slot" };
  try {
    const walk = new ViewWalk(slot, rule);
    const view = walk.node(raw, 1);
    const bytes = new TextEncoder().encode(JSON.stringify(view)).length;
    if (bytes > MAX_VIEW_BYTES) {
      return { ok: false, error: `${slot} view is ${bytes} bytes as JSON; the limit is ${MAX_VIEW_BYTES}` };
    }
    return { ok: true, view };
  } catch (failure) {
    if (failure instanceof ViewRejection) return { ok: false, error: failure.message };
    return { ok: false, error: `${slot} view could not be read` };
  }
}

class ViewRejection extends Error {}

function reject(message: string): never {
  throw new ViewRejection(message);
}

/** One pass over the tree; throws ViewRejection at the first violation so cost stays bounded. */
class ViewWalk {
  private count = 0;
  private readonly slot: PluginSlotId;
  private readonly rule: SlotRule;

  constructor(slot: PluginSlotId, rule: SlotRule) {
    this.slot = slot;
    this.rule = rule;
  }

  node(raw: unknown, depth: number): PluginNode {
    if (!isJsonObject(raw)) return reject("a view node must be an object");
    const kind = raw.k;
    if (!isString(kind) || !NODE_KINDS.includes(kind)) return reject("a view node has an unknown kind");
    const k = kind as PluginNodeKind;
    if (!this.rule.kinds.includes(k)) return reject(`${k} is not allowed in the ${this.slot} slot`);
    this.count += 1;
    if (this.count > this.rule.maxNodes) {
      return reject(`${this.slot} view has at least ${this.count} nodes; the limit is ${this.rule.maxNodes}`);
    }
    if (depth > this.rule.maxDepth) {
      return reject(`${this.slot} view is at least ${depth} levels deep; the limit is ${this.rule.maxDepth}`);
    }
    const props = raw.p === undefined || raw.p === null ? {} : raw.p;
    if (!isJsonObject(props)) return reject(`${k}.p must be an object`);
    const p = normaliseProps(k, props, this.rule.menuItems);
    if (k === "list" && this.rule.menuItems !== undefined && !("actions" in p)) {
      return reject(`list.actions.click must be a string of 1 to ${MAX_ACTION_CHARS} characters in the ${this.slot} slot`);
    }
    return { k, p, c: this.children(k, raw.c, depth) };
  }

  private children(k: PluginNodeKind, raw: unknown, depth: number): PluginNode[] {
    if (k !== "row" && k !== "col" && k !== "card") return [];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return reject(`${k}.c must be an array`);
    const out: PluginNode[] = [];
    for (const child of raw) {
      if (this.rule.chipsOnly && !(isJsonObject(child) && child.k === "chip")) {
        return reject(`${this.slot} may hold only chips`);
      }
      out.push(this.node(child, depth + 1));
    }
    return out;
  }
}

function truncate(value: string, cap: number): string {
  if (value.length <= cap) return value;
  let end = cap - 1;
  // Do not leave half of a surrogate pair in front of the ellipsis.
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function requiredString(owner: string, name: string, value: unknown, cap: number): string {
  if (!isString(value)) return reject(`${owner}.${name} must be a string`);
  return truncate(value, cap);
}

function setOptionalString(out: Record<string, unknown>, name: string, value: unknown, cap: number): void {
  if (isString(value)) out[name] = truncate(value, cap);
}

function setTone(out: Record<string, unknown>, value: unknown): void {
  if (isString(value) && TONES.includes(value)) out.tone = value;
}

function setFlag(out: Record<string, unknown>, name: string, value: unknown): void {
  if (typeof value === "boolean") out[name] = value;
}

function setChoice(out: Record<string, unknown>, name: string, value: unknown, choices: readonly string[]): void {
  if (isString(value) && choices.includes(value)) out[name] = value;
}

function actionOf(value: unknown): { click: string } | null {
  if (!isJsonObject(value)) return null;
  const click = value.click;
  if (!isString(click) || click.length < 1 || click.length > MAX_ACTION_CHARS) return null;
  return { click };
}

function setActions(out: Record<string, unknown>, value: unknown): void {
  const actions = actionOf(value);
  if (actions) out.actions = actions;
}

function itemsOf(owner: string, value: unknown, cap: number): unknown[] {
  if (!Array.isArray(value)) return reject(`${owner}.items must be an array`);
  if (value.length > cap) return reject(`${owner}.items has ${value.length} items; the limit is ${cap}`);
  return value;
}

function normaliseProps(k: PluginNodeKind, props: Record<string, unknown>, listCap = MAX_LIST_ITEMS): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (k) {
    case "text":
      out.text = requiredString(k, "text", props.text, 2000);
      setTone(out, props.tone);
      setFlag(out, "strong", props.strong);
      setFlag(out, "mono", props.mono);
      break;
    case "chip":
      out.text = requiredString(k, "text", props.text, 48);
      setTone(out, props.tone);
      setActions(out, props.actions);
      break;
    case "row":
    case "col":
      setChoice(out, "gap", props.gap, GAPS);
      break;
    case "card":
      setOptionalString(out, "title", props.title, 80);
      setTone(out, props.tone);
      break;
    case "kv":
      out.items = itemsOf(k, props.items, MAX_KV_ITEMS).map((item, index) => {
        const owner = `kv.items[${index}]`;
        if (!isJsonObject(item)) return reject(`${owner} must be an object`);
        const entry: Record<string, unknown> = {
          key: requiredString(owner, "key", item.key, 80),
          value: requiredString(owner, "value", item.value, 400),
        };
        setTone(entry, item.tone);
        return entry;
      });
      break;
    case "list":
      out.items = itemsOf(k, props.items, listCap).map((item, index) => {
        const owner = `list.items[${index}]`;
        if (!isJsonObject(item)) return reject(`${owner} must be an object`);
        const entry: Record<string, unknown> = {};
        setOptionalString(entry, "id", item.id, 64);
        entry.label = requiredString(owner, "label", item.label, 200);
        setOptionalString(entry, "detail", item.detail, 400);
        setOptionalString(entry, "value", item.value, 400);
        setTone(entry, item.tone);
        return entry;
      });
      setActions(out, props.actions);
      break;
    case "progress":
      if (!isFiniteNumber(props.value)) return reject("progress.value must be a finite number");
      out.value = Math.min(1, Math.max(0, props.value));
      setOptionalString(out, "label", props.label, 80);
      setTone(out, props.tone);
      break;
    case "button": {
      out.text = requiredString(k, "text", props.text, 32);
      setChoice(out, "variant", props.variant, VARIANTS);
      const actions = actionOf(props.actions);
      if (!actions) return reject(`button.actions.click must be a string of 1 to ${MAX_ACTION_CHARS} characters`);
      out.actions = actions;
      break;
    }
    case "empty":
      out.title = requiredString(k, "title", props.title, 80);
      setOptionalString(out, "description", props.description, 300);
      break;
  }
  return out;
}

const MAX_CONTEXT_BYTES = 32768;
const MAX_CONTEXT_CHARS = 32768;
const SESSION_STATUSES: readonly string[] = ["idle", "working", "needs-you"];
const CALL_STATES: readonly string[] = ["running", "done", "error"];

/** Caps what a plugin is handed: `args`/`details` over 32768 bytes of JSON become null, `output`/`text` over 32768 characters are cut; either sets `truncated`. Never throws; strips anything not JSON. */
export function boundContext(ctx: PluginRenderContext): PluginRenderContext {
  const raw: unknown = ctx;
  if (!isJsonObject(raw)) return { session: null };
  const out: PluginRenderContext = { session: boundSession(raw.session) };
  if (isJsonObject(raw.call)) {
    const call = raw.call;
    const args = boundJson(call.args);
    const output = cutText(call.output);
    out.call = {
      id: stringOr(call.id),
      name: stringOr(call.name),
      args: args.value,
      output: output.text,
      state: oneOf(call.state, CALL_STATES, "done") as PluginToolCallInfo["state"],
      truncated: call.truncated === true || args.truncated || output.truncated,
    };
  }
  if (isJsonObject(raw.message)) {
    const message = raw.message;
    const details = boundJson(message.details);
    const text = cutText(message.text);
    out.message = {
      id: stringOr(message.id),
      customType: stringOr(message.customType),
      text: text.text,
      details: details.value,
      truncated: message.truncated === true || details.truncated || text.truncated,
    };
  }
  return out;
}

function boundSession(raw: unknown): PluginSessionInfo | null {
  if (!isJsonObject(raw)) return null;
  return {
    id: stringOr(raw.id),
    title: stringOr(raw.title),
    cwd: stringOr(raw.cwd),
    model: stringOr(raw.model),
    status: oneOf(raw.status, SESSION_STATUSES, "idle") as PluginSessionInfo["status"],
    activeAt: isFiniteNumber(raw.activeAt) ? raw.activeAt : null,
  };
}

function stringOr(value: unknown): string {
  return isString(value) ? value : "";
}

function oneOf(value: unknown, allowed: readonly string[], fallback: string): string {
  return isString(value) && allowed.includes(value) ? value : fallback;
}

/** A JSON copy of `value` when it fits, else null with `truncated` set. Nothing here throws. */
function boundJson(value: unknown): { value: unknown; truncated: boolean } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: null, truncated: true };
  }
  // undefined, functions and symbols have no JSON form: nothing was lost, there was nothing to send.
  if (json === undefined) return { value: null, truncated: false };
  // Each UTF-16 unit is at least one byte and at most three, so only the middle band needs encoding.
  const tooBig = json.length > MAX_CONTEXT_BYTES
    || (json.length * 3 > MAX_CONTEXT_BYTES && new TextEncoder().encode(json).length > MAX_CONTEXT_BYTES);
  if (tooBig) return { value: null, truncated: true };
  try {
    return { value: JSON.parse(json), truncated: false };
  } catch {
    return { value: null, truncated: true };
  }
}

function cutText(value: unknown): { text: string; truncated: boolean } {
  const text = stringOr(value);
  if (text.length <= MAX_CONTEXT_CHARS) return { text, truncated: false };
  let end = MAX_CONTEXT_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** Claim pattern match: `*` is any run of characters (including none), everything else is literal, whole string, case-sensitive. */
export function claimMatches(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => globMatches(pattern, value));
}

// Linear-backtracking wildcard walk: no RegExp is built from the pattern, so a hostile
// pattern cannot inject regex syntax or cause catastrophic backtracking.
function globMatches(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = v;
      p += 1;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      v = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}
