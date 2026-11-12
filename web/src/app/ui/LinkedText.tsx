/** Event a tapped review link sends: `detail` is the link's `#dev=…` fragment (dev/DevReviewHost listens). */
export const OPEN_REVIEW_EVENT = "omp:open-review";

/**
 * Question text with its web links tappable: an agent asks "is this right?"
 * with a link to what it built. A link on the app's own address stays inside
 * the app (the native shell keeps same-origin pages in its WebView); any other
 * opens in the browser. Only absolute http(s) URLs without credentials link.
 */
export function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/gi);
  return parts.map((match, index) => {
    if (index % 2 === 0) return match;
    // Sentence punctuation after a link ("…/doc.") belongs to the sentence.
    const part = match.replace(/[.,;:!?]+$/, "");
    const tail = match.slice(part.length);
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      return match;
    }
    if (url.username || url.password) return match;
    // The installed app runs from its own bundled address, not the daemon's,
    // so "same origin" misses links to it: an `…/app/#dev=…` review link on
    // any host opens the review screen in place (DevReviewHost).
    const review = url.pathname === "/app/" && url.hash.startsWith("#dev=");
    const internal = review || url.origin === window.location.origin;
    return [
      <a
        key={index}
        href={review ? url.hash : url.href}
        onClick={review ? (event) => { event.preventDefault(); window.dispatchEvent(new CustomEvent(OPEN_REVIEW_EVENT, { detail: url.hash })); } : undefined}
        target={internal ? undefined : "_blank"}
        rel={internal ? undefined : "noopener noreferrer"}
        data-testid="extension-dialog-link"
        className={review ? "my-1 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-4 text-ui font-semibold text-primary-foreground no-underline" : "text-primary-text underline underline-offset-4"}
      >
        {/* A review link is a long encoded address nobody reads: a button says what it does. */}
        {review ? "Open review" : part}
      </a>,
      tail,
    ];
  });
}
