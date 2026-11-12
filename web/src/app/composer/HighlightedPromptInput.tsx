import { useLayoutEffect, useRef, type ComponentProps, type CSSProperties } from "react";
import { PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { MagicKeywordText } from "../parts/MagicKeywordText";
import type { MagicKeyword } from "../../domain/magic-keywords";

/** A paint-only layer: the native textarea remains the sole editor and accessible value. */
export function HighlightedPromptInput({ keywords, ...props }: ComponentProps<typeof PromptInputTextarea> & {
  keywords: readonly MagicKeyword[] | null;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const input = wrapper.current?.querySelector("textarea"), layer = overlay.current;
    if (!input || !layer) return;
    const sync = () => {
      const style = getComputedStyle(input);
      for (const property of ["font", "font-kerning", "font-feature-settings", "font-variation-settings", "letter-spacing", "line-height", "tab-size", "text-align", "text-indent", "text-transform", "word-spacing", "padding-top", "padding-right", "padding-bottom", "padding-left"]) {
        layer.style.setProperty(property, style.getPropertyValue(property));
      }
      layer.style.width = `${input.clientWidth}px`;
      layer.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    };
    sync();
    input.addEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    return () => { observer.disconnect(); input.removeEventListener("scroll", sync); };
  }, [props.value]);
  return <div ref={wrapper} className="relative min-w-0 flex-1">
    <PromptInputTextarea {...props} />
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 1 }}>
      <div ref={overlay} data-testid="composer-keyword-overlay" style={OVERLAY_STYLE}>
        <MagicKeywordText text={String(props.value ?? "")} keywords={keywords ?? []} />
        {/* Preserve the final empty textarea line without changing submitted bytes. */}
        {"\u200b"}
      </div>
    </div>
  </div>;
}
const OVERLAY_STYLE: CSSProperties = {
  boxSizing: "border-box", color: "transparent", whiteSpace: "pre-wrap", overflowWrap: "break-word",
};
