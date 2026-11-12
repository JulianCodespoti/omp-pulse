import { Row } from "../ui/Row";
import { sourceIcon } from "./command-order";

/**
 * A command's help as a short human phrase for a list row. omp writes
 * its descriptions for the terminal: a trailing period, a trailing
 * parenthetical about arguments ("Rename the current session (omit title to
 * generate)", "Manage SSH hosts (add, list, remove)") and the odd `<arg>`,
 * `[arg]` or `--flag`. The list shows what the command does; argument syntax
 * belongs to the input sheet that asks for it.
 */
export function displayDescription(text?: string): string | undefined {
  if (!text) return undefined;
  const phrase = text
    .trim()
    .replace(/\s+(?:<[^>]*>|\[[^\]]*\]|--[\w-]+)/g, "")
    .replace(/\s*\([^()]*\)\s*\.?$/, "")
    .replace(/[.:;,\s]+$/, "")
    .trim();
  return phrase || undefined;
}

/**
 * One slash command, shared by the palette and the inline slash menu so a
 * command reads the same in both. Built on the list Row: a source icon leads
 * (so commands sit on the same text column as the palette's panel and action
 * rows), the name is the title, the description its subtitle, and a live
 * value (the current model, context used) sits trailing as a row value does.
 */
export function CommandRow({
  title, aliases, description, detail, drill, selected, source, onClick,
}: {
  title: string;
  aliases?: string;
  description?: string;
  detail?: string;
  drill?: boolean;
  selected?: boolean;
  /** The command's source (builtin, tasks, skill, file, mcp). */
  source?: string;
  onClick: () => void;
}) {
  const Icon = sourceIcon(source);
  return (
    <Row
      testId="command-row"
      aria-label={[title, aliases, description, detail].filter(Boolean).join(". ")}
      selected={selected}
      onClick={onClick}
      chevron={drill}
      leading={<Icon aria-hidden />}
      title={
        <>
          <span data-testid="command-name">{title}</span>
          {aliases ? <span data-testid="command-aliases" className="ml-2 text-meta text-muted-foreground">{aliases}</span> : null}
        </>
      }
      subtitle={description ? <span data-testid="command-description">{description}</span> : undefined}
      trailing={detail ? <span data-testid="command-detail" className="tabular-nums">{detail}</span> : undefined}
    />
  );
}
