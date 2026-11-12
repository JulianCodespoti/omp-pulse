export type StopOutcome = "requested" | "nothing_running" | "failed" | "unavailable";

// Request acknowledgement is not evidence that the agent stopped. The live
// session state owns that fact; this guard owns only one card's request UI.
// `send` resolving to exactly `false` is the daemon saying no agent was there
// to stop (it settles the stale turn itself); anything else is "requested".
export class SessionStopRequest {
  private generation = 0;
  pending = false;

  reset(): void { this.generation++; this.pending = false; }

  async run(send: () => Promise<unknown>, capability: boolean | null): Promise<StopOutcome | null> {
    if (this.pending) return null;
    if (capability === false) return "unavailable";
    this.pending = true;
    const generation = ++this.generation;
    let result: StopOutcome = "requested";
    try { if (await send() === false) result = "nothing_running"; } catch { result = "failed"; }
    if (generation !== this.generation) return null;
    this.pending = false;
    return result;
  }
}
