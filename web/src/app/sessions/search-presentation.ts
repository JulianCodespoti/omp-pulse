/**
 * What the one search field shows: title matches, a Messages group below
 * them, and a single "No sessions match" only once both searches have
 * answered. While the debounce or a request is in flight nothing has been
 * proven absent, so claiming "no match" then would be a lie.
 */
export function sessionSearchPresentation({
  query,
  debouncedQuery,
  titleCount,
  messageCount,
  listingPending,
  moreAvailable,
  messagesPending,
  failed,
}: {
  /** What the field holds now. */
  query: string;
  /** What the searches were last asked for. */
  debouncedQuery: string;
  titleCount: number;
  messageCount: number;
  listingPending: boolean;
  /** An older listing page may still hold a title match. */
  moreAvailable: boolean;
  messagesPending: boolean;
  /** A failed search reports itself; it has no empty state. */
  failed: boolean;
}) {
  const q = query.trim();
  const asked = debouncedQuery.trim();
  const settled = q !== "" && q === asked;
  // One letter matches nearly every message; the message search waits for two.
  const showMessages = q !== "" && asked.length >= 2;
  return {
    showMessages,
    titlesPending: q !== "" && titleCount === 0 && (!settled || listingPending),
    empty:
      settled && !listingPending && !moreAvailable && !messagesPending && !failed &&
      titleCount === 0 && (!showMessages || messageCount === 0),
  };
}
