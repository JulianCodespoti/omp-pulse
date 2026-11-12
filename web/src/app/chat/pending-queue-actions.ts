// Tokens own pending UI state. A reset or a newer action with the same row key
// must never be released by an older request's completion.
export class PendingQueueActions {
  private readonly tokens = new Map<string, symbol>();
  begin(key: string): symbol | null {
    if (this.tokens.has(key)) return null;
    const token = Symbol();
    this.tokens.set(key, token);
    return token;
  }
  isCurrent(key: string, token: symbol): boolean { return this.tokens.get(key) === token; }
  finish(key: string, token: symbol): boolean {
    if (!this.isCurrent(key, token)) return false;
    this.tokens.delete(key);
    return true;
  }
  reset(): void { this.tokens.clear(); }
}
