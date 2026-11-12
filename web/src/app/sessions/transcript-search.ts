type SearchResult<T> = { ok: true; query: string; value: T } | { ok: false; query: string; error: unknown };

/** Owns visible results, not the lifetime of the server's search request. */
export class TranscriptSearch<T> {
  private generation = 0;
  private pendingQuery: string | null = null;

  reset(): void {
    this.generation++;
    this.pendingQuery = null;
  }

  async run(query: string, search: () => Promise<T>): Promise<SearchResult<T> | null> {
    if (this.pendingQuery === query) return null;
    this.pendingQuery = query;
    const generation = ++this.generation;
    let result: SearchResult<T>;
    try { result = { ok: true, query, value: await search() }; }
    catch (error) { result = { ok: false, query, error }; }
    if (generation !== this.generation) return null;
    this.pendingQuery = null;
    return result;
  }
}
