/**
 * The one prose spec for conversation text (assistant replies, user bubbles,
 * subagent output). Streamdown ships desktop sizes; this scales its blocks for
 * a 390px viewport. Body is text-body (16/24); headings sit ABOVE the body
 * (h1 20, h2 18, h3 16, h4 15, all 600) so h3/h4 never read smaller than the
 * paragraphs around them. Bold is 500. Inline code and in-prose paths share
 * one look (markdown.tsx `inlineCode` / PathChip): text-code on surface-2,
 * radius 6. Fenced code and tables scroll sideways inside their own box.
 * Element rules reach only rendered markdown (`.md-body`): tool details,
 * notices and live tails inside a message keep their own <p>/<pre> styling.
 */
export const PROSE =
  "min-w-0 max-w-full text-body " +
  "[&_.md-body_h1]:mt-5 [&_.md-body_h1]:mb-2 [&_.md-body_h1]:text-[1.25rem] [&_.md-body_h1]:leading-7 [&_.md-body_h1]:font-semibold [&_.md-body_h1]:tracking-[-0.015em] " +
  "[&_.md-body_h2]:mt-5 [&_.md-body_h2]:mb-2 [&_.md-body_h2]:text-[1.125rem] [&_.md-body_h2]:leading-[1.625rem] [&_.md-body_h2]:font-semibold [&_.md-body_h2]:tracking-[-0.01em] " +
  "[&_.md-body_h3]:mt-4 [&_.md-body_h3]:mb-1.5 [&_.md-body_h3]:text-body [&_.md-body_h3]:font-semibold " +
  "[&_.md-body_h4]:mt-4 [&_.md-body_h4]:mb-1 [&_.md-body_h4]:text-ui [&_.md-body_h4]:font-semibold " +
  "[&_.md-body_strong]:font-medium [&_[data-streamdown=strong]]:font-medium " +
  "[&_.md-body_p]:my-3 [&_.md-body_p]:break-words [overflow-wrap:anywhere] " +
  "[&_.md-body_ul]:my-3 [&_.md-body_ul]:pl-5 [&_.md-body_ol]:my-3 [&_.md-body_ol]:pl-5 [&_.md-body_li]:my-1 [&_.md-body_li]:marker:text-muted-foreground [&_.md-body_li>p]:my-1 " +
  // Long URLs were tall stacked buttons; keep them as inline <a>
  // with break-all so they flow with the sentence instead of destroying rhythm.
  "[&_.md-body_a]:text-primary-text [&_.md-body_a]:underline [&_.md-body_a]:decoration-primary/30 [&_.md-body_a]:underline-offset-2 hover:[&_.md-body_a]:decoration-primary [&_.md-body_a]:break-all " +
  "[&_.md-body_blockquote]:my-3 [&_.md-body_blockquote]:border-l-2 [&_.md-body_blockquote]:border-hairline [&_.md-body_blockquote]:pl-3 [&_.md-body_blockquote]:text-muted-foreground " +
  // Curl lines overflow with no cue and fight vertical scroll. Keep
  // pre horizontally scrollable and lock the gesture to pan-x without
  // replacing the highlighter (see the no-`pre`-override note in markdown.tsx).
  "[&_.md-body_pre]:my-3 [&_.md-body_pre]:rounded-lg [&_.md-body_pre]:bg-surface-1 [&_.md-body_pre]:p-3 [&_.md-body_pre]:text-code [&_.md-body_pre]:overflow-x-auto [&_.md-body_pre]:[scrollbar-width:thin] [&_.md-body_pre]:touch-pan-x [&_.md-body_pre]:[overscroll-behavior-x:contain] " +
  // Tables are wrapped in an overflow-x-auto region (markdown.tsx
  // TableWrapper); the table itself is w-max so it can scroll.
  "[&_.md-body_table]:w-max [&_.md-body_table]:min-w-full [&_.md-body_table]:border-collapse [&_.md-body_table]:text-ui " +
  "[&_.md-body_th]:px-2.5 [&_.md-body_th]:py-2 [&_.md-body_th]:text-left [&_.md-body_th]:font-medium [&_.md-body_th]:text-muted-foreground [&_.md-body_th]:whitespace-nowrap [&_.md-body_th]:border-b [&_.md-body_th]:border-hairline " +
  "[&_.md-body_td]:px-2.5 [&_.md-body_td]:py-2 [&_.md-body_td]:border-t [&_.md-body_td]:border-hairline [&_.md-body_td]:align-top [&_.md-body_td]:whitespace-nowrap md:[&_.md-body_td]:whitespace-normal " +
  "[&_.md-body_hr]:my-5 [&_.md-body_hr]:border-hairline " +
  "[&_.md-body>*:first-child]:mt-0 [&_.md-body>*:last-child]:mb-0 " +
  // Task-list checkboxes were 13×13 grey squares. Display-only
  // (pointer-events none) 16px rounded squares aligned to cap-height. The
  // check mark's SVG spells spaces as %20: a literal space split the class
  // into fragments, so Tailwind never built it and tailwind-merge dropped
  // bg-primary as a conflicting fragment.
  // GFM task items still carried the list marker, so "• ⭘ Mirror the pool
  // change" read as two bullets. A task item is its checkbox; drop its disc.
  "[&_li:has(input[type=checkbox])]:list-none " +
  "[&_input[type=checkbox]]:size-4 [&_input[type=checkbox]]:appearance-none [&_input[type=checkbox]]:rounded-sm [&_input[type=checkbox]]:border [&_input[type=checkbox]]:border-control [&_input[type=checkbox]]:bg-surface-2 [&_input[type=checkbox]]:align-[-2px] [&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:pointer-events-none [&_input[type=checkbox]:checked]:bg-primary [&_input[type=checkbox]:checked]:border-primary [&_input[type=checkbox]:checked]:bg-[url('data:image/svg+xml;utf8,<svg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2012%2012%27><path%20fill=%27none%27%20stroke=%27white%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%20d=%27M3%206l2%202%204-4%27/></svg>')] [&_input[type=checkbox]:checked]:bg-center [&_input[type=checkbox]:checked]:bg-no-repeat";

/**
 * Appearance → Message style → Bubbles. The agent's text takes the user
 * bubble's surface, anchored left with the corner by its sender tightened;
 * code and paths step up one surface, as in the user bubble.
 */
export const AGENT_BUBBLE =
  "w-fit min-w-0 max-w-full rounded-[calc(1.125rem*var(--radius-scale,1))] rounded-tl-md bg-surface-2 px-3.5 py-2.5 " +
  "[&_code]:!bg-surface-3 [&_[data-testid=path-chip]]:!bg-surface-3";
/** The agent's work under a bubble: a hairline from the avatar's centre threads it to the text above. */
export const AGENT_THREAD = "ml-3 border-l border-hairline pl-5";
/**
 * Bubbles: the user's message takes the messenger shape (tail corner
 * bottom-right). Its fill is the same accent-tinted `user-bubble` as Plain,
 * as ChatGPT tints it.
 */
export const USER_BUBBLE =
  "group-[.is-user]:rounded-[calc(1.125rem*var(--radius-scale,1))] group-[.is-user]:rounded-br-md";
