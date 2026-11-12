import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Row, RowGroup } from "../ui/Row";
import { displayDescription } from "../commands/CommandRow";
import { useBackLayer } from "../back-layer";
import { groupCommands, orderCommands, sourceLabel } from "../commands/command-order";
import { rankSlashMatches, type SlashMatches } from "../../domain/slash-match";

type PaletteCommand = { name: string; description?: string; aliases?: string[]; source?: string };

export interface SlashPaletteProps {
  text: string;
  commands?: PaletteCommand[];
  onPick: (command: string) => void;
  onClose: () => void;
}

// A bare `/word` opens the list. Once you type a space you are writing
// arguments and the list gets out of the way, matching the terminal.
function shouldShow(text: string): boolean {
  if (!text.startsWith("/")) return false;
  if (text.includes(" ") || text.includes("\n")) return false;
  return true;
}

/**
 * The leading `/word`, when the text opens with something that could be a
 * command. `/tmp/notes.md` is a path, not a command, so a token with a
 * second slash does not qualify.
 */
function commandToken(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const first = text.split(/[\s\n]/, 1)[0] ?? "";
  return /^\/[a-zA-Z][\w-]*$/.test(first) ? first : null;
}

function filterCommands(commands: PaletteCommand[] | undefined, query: string): SlashMatches<PaletteCommand> {
  if (!commands || commands.length === 0) return { items: [], autoPick: false };
  // Unfiltered, the list reads exactly like the Commands sheet. Nothing is
  // typed, so nothing is picked by Enter alone.
  if (!query) return { items: orderCommands(commands).slice(0, 40), autoPick: false };
  return rankSlashMatches(commands, query);
}

/**
 * A token absent from this discovery snapshot, not proof of an invalid
 * command. Older OMP catalogues and cached snapshots can omit templates.
 */
export function uncataloguedCommandToken(text: string, commands: PaletteCommand[] | undefined): string | null {
  if (!commands || commands.length === 0 || text.trim() === "/") return null;
  const token = commandToken(text);
  if (!token) return null;
  const lower = token.slice(1).toLowerCase();
  const exact = commands.some(
    (c) =>
      c.name.replace(/^\/+/, "").toLowerCase() === lower ||
      c.aliases?.some((a) => a.replace(/^\/+/, "").toLowerCase() === lower),
  );
  if (exact) return null;
  const committed = /[\s\n]/.test(text);
  if (!committed && filterCommands(commands, lower).items.length > 0) return null;
  return token;
}

export function SlashPalette({ text, commands, onPick, onClose }: SlashPaletteProps) {
  const visible = isSlashListVisible(text, commands);
  const rawQuery = shouldShow(text) ? text.slice(1).toLowerCase() : "";
  // Keep the input responsive while the list filters.
  const query = useDeferredValue(rawQuery);

  const { items: filtered, autoPick } = useMemo(() => filterCommands(commands, query), [commands, query]);
  // Grouped like the Commands sheet while browsing; a typed query ranks by
  // match quality instead, so the best hit is first.
  const groups = useMemo(
    () => (query ? [["", filtered] as [string, PaletteCommand[]]] : groupCommands(filtered)),
    [filtered, query],
  );

  const uncatalogued = useMemo(() => uncataloguedCommandToken(text, commands), [commands, text]);

  // The row Enter picks; -1 is none. Only a name/alias prefix match starts
  // highlighted (see SlashMatches.autoPick). A bare `/` or a fuzzy-only match
  // waits for an arrow key or a tap: `/` + Enter used to open `/model`.
  const initialSelection = query && autoPick ? 0 : -1;
  const [selected, setSelected] = useState(initialSelection);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelected(initialSelection);
  }, [query, filtered.length, initialSelection]);

  // Arrow keys can walk past the visible window; keep the pick in view.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (!visible) return;
    const flat = groups.flatMap(([, list]) => list);
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && (e.repeat || e.shiftKey)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        const pick = selected >= 0 ? flat[selected] : undefined;
        if (pick) {
          e.preventDefault();
          onPick(pick.name);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, groups, selected, onPick, onClose]);

  // Back dismisses the palette and keeps the draft, like Escape.
  useBackLayer(visible, { onBack: onClose });

  if (uncatalogued) {
    return (
      <div data-testid="uncatalogued-command" role="status" className={`${PANEL} px-4 py-3`}>
        <p className="text-meta text-muted-foreground">
          <span className="text-foreground">{uncatalogued}</span> is not in this command list. OMP will resolve it when sent.
        </p>
      </div>
    );
  }

  if (!visible) return null;
  if (filtered.length === 0) return null;

  // The highlight is exactly what Enter picks: a name/alias prefix match
  // starts on the first row; anything else waits for the arrow keys.
  let rowIndex = 0;
  return (
    <div data-testid="slash-palette" className={PANEL}>
      <div ref={listRef} className="max-h-[45dvh] overflow-y-auto overscroll-contain py-1">
        {groups.map(([source, list]) => (
          <RowGroup
            key={source || "matches"}
            inset
            title={source && groups.length > 1 ? sourceLabel(source) : undefined}
            className={source && groups.length > 1 ? "pt-2" : undefined}
          >
            {list.map((cmd) => {
              const idx = rowIndex++;
              const description = displayDescription(cmd.description);
              return (
                <Row
                  key={cmd.name}
                  testId="command-row"
                  // One text column: no per-row icon. Matches ranked across
                  // sources say where a non-built-in command comes from.
                  trailing={query && cmd.source && cmd.source.toLowerCase() !== "builtin" ? sourceLabel(cmd.source) : undefined}
                  title={<span data-testid="command-name">{`/${cmd.name.replace(/^\/+/, "")}`}</span>}
                  subtitle={description ? <span data-testid="command-description" className="block truncate">{description}</span> : undefined}
                  selected={idx === selected}
                  onClick={() => onPick(cmd.name)}
                />
              );
            })}
          </RowGroup>
        ))}
      </div>
    </div>
  );
}

// A sheet-like panel anchored on the composer: it rises from the card and
// caps at under half the screen so the conversation stays in view.
const PANEL = "mb-2 overflow-hidden rounded-xl border border-hairline bg-surface-1 shadow-[var(--shadow-float)] motion-safe:animate-[slide-up_var(--dur-base)_var(--ease-spring)] motion-reduce:animate-none";

/**
 * Only a nonempty list captures Enter. An uncatalogued template can still
 * be submitted without inventing a match or blocking on stale discovery.
 */
export function isSlashListVisible(text: string, commands: PaletteCommand[] | undefined): boolean {
  return shouldShow(text) && filterCommands(commands, text.slice(1).toLowerCase()).items.length > 0;
}

/** Mount discovery feedback for a leading command token, including arguments. */
export function hasCommandToken(text: string): boolean {
  return commandToken(text) !== null;
}
