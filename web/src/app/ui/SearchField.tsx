import { SearchIcon, XIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The one search field: a filled, borderless M3 search bar. Sessions,
 * New session, the model picker, commands and providers each used to draw
 * their own (filled rounded-xl, outlined black, outlined grey), so the same
 * action looked like three different controls.
 *
 * Height is rem (3rem = 48dp at 100%) so it grows with the text inside it.
 * The clear button only takes room while there is something to clear: a
 * permanently reserved slot cut the placeholder to "Search moc" at 150%.
 * The fill is `surface-2`, one step above both the page and the sheet canvas,
 * so the field reads as a control on either.
 */
export function SearchField({
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
  testId,
  clearTestId,
  clearLabel = "Clear search",
  className,
  inputRef,
  onKeyDown,
  autoFocus,
  autoCapitalize = "none",
  autoCorrect = "off",
  spellCheck = false,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Runs after the field is emptied by the clear button. */
  onClear?: () => void;
  placeholder: string;
  ariaLabel?: string;
  testId?: string;
  clearTestId?: string;
  clearLabel?: string;
  className?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoFocus?: boolean;
  autoCapitalize?: string;
  autoCorrect?: string;
  spellCheck?: boolean;
  inputClassName?: string;
}): React.JSX.Element {
  const ownRef = React.useRef<HTMLInputElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      ownRef.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
    },
    [inputRef],
  );
  return (
    <div
      data-slot="search-field"
      className={cn(
        "flex min-h-12 min-w-0 items-center gap-3 rounded-full bg-surface-2 pl-4 transition-colors focus-within:bg-surface-3 focus-within:outline-2 focus-within:outline-ring/60",
        value ? "pr-1" : "pr-4",
        className,
      )}
    >
      <label className="flex min-h-12 min-w-0 flex-1 items-center gap-3">
        <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <input
          ref={setRefs}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          autoFocus={autoFocus}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          spellCheck={spellCheck}
          data-testid={testId}
          className={cn(
            "min-h-12 min-w-0 flex-1 bg-transparent text-body text-ellipsis text-foreground outline-hidden placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden",
            inputClassName,
          )}
        />
      </label>
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          data-testid={clearTestId}
          className="pressable flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            onChange("");
            onClear?.();
            ownRef.current?.focus();
          }}
        >
          <XIcon aria-hidden className="size-5" />
        </button>
      ) : null}
    </div>
  );
}
