/**
 * The conversation as it stands on the session's active branch.
 *
 * The daemon serves history as PHYSICAL session-file entries, every branch
 * included. A tree move does not rewrite the file: omp's TUI `/tree` only
 * moves the in-memory leaf (the next appended turn hangs off the new
 * position), and the phone's "Go here" appends an `omp-pulse-goto` custom
 * entry whose `parentId` is the entry the conversation now continues from.
 * Either way the branch is the parent chain back from the newest entry, the
 * same leaf the daemon's Timeline resolves (`ActiveLeafSelection`,
 * src/sessions/jsonl.rs). Waiting for a goto marker before filtering left the turns a
 * TUI move abandoned interleaved with the live branch on the phone.
 */
export const GOTO_CUSTOM_TYPE = "omp-pulse-goto";

/** Entry shape this module reads; anything else on the entry is carried through. */
export interface BranchEntry {
  readonly id?: string;
  readonly type?: string;
  readonly customType?: string;
  readonly parentId?: unknown;
  readonly activeLeafId?: unknown;
}

/**
 * Where the chain stands after a page, for the next OLDER page: the ids it
 * must contain (the chain's next link, or none once it reached a root);
 * null while no leaf has been resolved (no tree entry yet), so an older page
 * resolves it; `UNLINKED` once a chain entry carried no `parentId` at all,
 * so nothing older can be proven abandoned and everything is kept.
 */
export type BranchFrontier = Set<string> | null | typeof UNLINKED;
export const UNLINKED = "unlinked";

export interface BranchFilterResult<T> {
  /** Entries still on the current branch, in FILE order. */
  readonly kept: T[];
  readonly frontier: BranchFrontier;
  /** The leaf THIS call resolved; null when it continued a given frontier or found none. */
  readonly leaf: string | null;
  /** Ids of tree entries left off the branch, newest first. */
  readonly dropped: string[];
}

/**
 * Whether the entry is a node of omp's session tree. The header and title
 * lines (and id-less legacy lines) belong to no branch, so no move can
 * abandon them; same split as `is_session_entry` in src/sessions/jsonl.rs.
 */
function isTreeEntry(entry: BranchEntry): entry is BranchEntry & { id: string } {
  return typeof entry.id === "string" && entry.id !== "" && entry.type !== "session" && entry.type !== "title";
}

/**
 * Drop the entries off the active branch from one page of file-order entries.
 *
 * Scans newest to oldest. With a null `frontier` the newest tree entry is the
 * leaf (entries newer than it that are not tree nodes are kept as they are);
 * from then on only the parent chain survives: an entry is kept when its id
 * is in the frontier, which then steps to its parent. Pass the frontier a
 * newer page returned so the chain continues across pages. A chain entry
 * with no `parentId` field (pre-tree lines, synthetic fixtures) ends what can
 * be proven: it and everything older is kept.
 *
 * INVARIANT: a goto marker is an ordinary link of the chain and never shown;
 * an off-chain marker belongs to an abandoned branch and restarts nothing.
 * INVARIANT: a parent is always appended before its children, so an entry
 * newer than the chain's next link and not on it is provably off the branch,
 * even when that link lies in a page not loaded yet.
 */
export function filterAbandoned<T extends BranchEntry>(
  entries: readonly T[],
  frontier: BranchFrontier,
  currentLeaf: string | null = null,
): BranchFilterResult<T> {
  let chain: BranchFrontier = frontier instanceof Set ? new Set(frontier) : frontier;
  let leaf: string | null = null;
  let present: Set<string> | null = null;
  const kept: T[] = [];
  const dropped: string[] = [];
  // A rewritten or re-sent line can repeat an id; a copy of a chain node is
  // the same node, not an abandoned one (the transcript dedupes it).
  const linked = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isTreeEntry(entry) || chain === UNLINKED) {
      kept.push(entry);
      continue;
    }
    if (chain === null) {
      if (entry.type === "model_usage") {
        // omp `appendModelUsage` records usage on its initiating branch and
        // keeps the leaf where it was unless the usage hangs off that leaf.
        // Newer omp records the leaf it left in place as `activeLeafId`; it
        // counts only when that entry is in this page, so a dangling or
        // unloaded id cannot hide the whole window. Without the marker
        // (omp 18.8.6) the usage is the leaf exactly when its parent was the
        // leaf: the next older tree entry here, or `currentLeaf` (the leaf an
        // earlier batch resolved) when none is in this page. Same rule as the
        // daemon's `ActiveLeafSelection` (src/sessions/jsonl.rs).
        if (present === null) present = new Set(entries.flatMap((e) => (isTreeEntry(e) ? [e.id] : [])));
        let target: string | null;
        if (entry.activeLeafId === undefined) {
          target = usageHangsOffLeaf(entries, i, entry.parentId, currentLeaf) ? entry.id : null;
        } else {
          target = typeof entry.activeLeafId === "string" && present.has(entry.activeLeafId) ? entry.activeLeafId : null;
        }
        if (target !== entry.id) {
          if (target !== null) {
            leaf = target;
            chain = new Set([target]);
          }
          kept.push(entry);
          continue;
        }
      }
      leaf = entry.id;
      chain = new Set([entry.id]);
    }
    if (!chain.has(entry.id)) {
      if (linked.has(entry.id)) kept.push(entry);
      else dropped.push(entry.id);
      continue;
    }
    chain.delete(entry.id);
    linked.add(entry.id);
    if (entry.parentId === undefined) {
      chain = UNLINKED;
    } else if (typeof entry.parentId === "string" && entry.parentId) {
      chain.add(entry.parentId);
    }
    if (entry.type !== "custom" || entry.customType !== GOTO_CUSTOM_TYPE) kept.push(entry);
  }
  kept.reverse();
  return { kept, frontier: chain, leaf, dropped };
}

/**
 * Whether the unmarked usage at `index` hangs off the leaf it was appended
 * under: the newest older tree entry that was itself the leaf (usage that
 * kept the leaf elsewhere is skipped), or `currentLeaf` past the page start.
 */
function usageHangsOffLeaf(entries: readonly BranchEntry[], index: number, parentId: unknown, currentLeaf: string | null): boolean {
  if (typeof parentId !== "string" || parentId === "") return false;
  for (let j = index - 1; j >= 0; j--) {
    const older = entries[j];
    if (!isTreeEntry(older)) continue;
    if (older.type === "model_usage") {
      const selfSelected = older.activeLeafId === undefined
        ? usageHangsOffLeaf(entries, j, older.parentId, currentLeaf)
        : older.activeLeafId === older.id;
      if (!selfSelected) {
        if (typeof older.activeLeafId === "string") return older.activeLeafId === parentId;
        continue;
      }
    }
    return older.id === parentId;
  }
  return parentId === currentLeaf;
}

/**
 * Whether newly arrived entries prove the transcript on screen is on an
 * abandoned branch, so it must be re-seeded from the tail rather than merged.
 *
 * `previousLeaf` is the leaf the transcript was built to (null when unknown);
 * `onScreen` holds the ids it shows. A batch continues the transcript when
 * its chain runs through `previousLeaf` or hangs off it; anything else is a
 * tree move (TUI `/tree`, Esc Esc, phone "Go here") made since.
 */
export function branchMoved(
  result: BranchFilterResult<BranchEntry>,
  previousLeaf: string | null,
  onScreen: ReadonlySet<string>,
): boolean {
  if (result.dropped.some((id) => onScreen.has(id))) return true;
  if (previousLeaf === null || result.leaf === null || result.leaf === previousLeaf) return false;
  if (result.dropped.includes(previousLeaf)) return true;
  if (result.kept.some((entry) => entry.id === previousLeaf)) return false;
  return result.frontier instanceof Set ? !result.frontier.has(previousLeaf) : false;
}
