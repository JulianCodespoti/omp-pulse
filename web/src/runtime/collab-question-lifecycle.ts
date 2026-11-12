// Pending-set authority is scoped to one daemon generation and exact session.
// A new daemon's empty cache is NOT evidence that an old question completed.
export interface CollabQuestionIdentity {
  sessionPath: string;
  generation: string;
  token: string;
  reqId: number;
}

export function collabQuestionKey(identity: Pick<CollabQuestionIdentity, "sessionPath" | "reqId" | "token">): string {
  return JSON.stringify([identity.sessionPath, identity.reqId, identity.token]);
}
export interface CollabQuestionCursor {
  sessionPath: string;
  generation: string;
  revision: number;
}
type Request = Record<string, unknown> & { reqId: number; pulseQuestionToken: string };
export interface CollabQuestionFrame {
  cursor: CollabQuestionCursor;
  kind: "snapshot" | "request" | "end";
  requests: readonly Request[];
  ended: { reqId: number; token: string | null } | null;
}
const object = (raw: unknown): raw is Record<string, unknown> => typeof raw === "object" && raw !== null && !Array.isArray(raw);
const id = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;

// One cursor per active controller stream: constant memory, retained across
// reconnect, discarded on session/credential navigation. No end-ID history.
export function readCollabQuestionFrame(previous: CollabQuestionCursor | null, raw: unknown, sessionPath: string): CollabQuestionFrame | null {
  if (!object(raw) || !object(raw.lifecycle)) return null;
  const stamp = raw.lifecycle;
  if (stamp.sessionPath !== sessionPath || typeof stamp.generation !== "string" || !stamp.generation || !id(stamp.revision)) return null;
  const cursor = { sessionPath, generation: stamp.generation, revision: stamp.revision };
  const snapshot = raw.type === "collab_ui_snapshot";
  if (previous?.sessionPath === sessionPath) {
    if (previous.generation !== cursor.generation && !snapshot) return null;
    if (previous.generation === cursor.generation && (snapshot ? cursor.revision < previous.revision : cursor.revision <= previous.revision)) return null;
  } else if (!snapshot) return null; // The attaching snapshot establishes authority first.
  const request = (value: unknown): value is Request => object(value) && id(value.reqId) && typeof value.pulseQuestionToken === "string" && value.pulseQuestionToken.startsWith(`${cursor.generation}:`);
  if (snapshot) {
    if (raw.complete !== true || !Array.isArray(raw.requests) || !raw.requests.every(request)) return null;
    if (new Set(raw.requests.map(value => value.pulseQuestionToken)).size !== raw.requests.length || new Set(raw.requests.map(value => value.reqId)).size !== raw.requests.length) return null;
    return { cursor, kind: "snapshot", requests: raw.requests, ended: null };
  }
  if (raw.type === "collab_ui_request" && request(raw.request)) return { cursor, kind: "request", requests: [raw.request], ended: null };
  if (raw.type === "collab_ui_request_end" && id(raw.reqId) && (raw.pulseQuestionToken === null || typeof raw.pulseQuestionToken === "string")) {
    return { cursor, kind: "end", requests: [], ended: { reqId: raw.reqId, token: raw.pulseQuestionToken } };
  }
  return null;
}

export function collabQuestionIdentity(frame: CollabQuestionFrame, reqId: number): CollabQuestionIdentity | null {
  const request = frame.requests.find(value => value.reqId === reqId);
  return request ? { sessionPath: frame.cursor.sessionPath, generation: frame.cursor.generation, token: request.pulseQuestionToken, reqId } : null;
}

export function collabQuestionSettled(identity: CollabQuestionIdentity | undefined, frame: CollabQuestionFrame): boolean {
  if (!identity || identity.sessionPath !== frame.cursor.sessionPath || identity.generation !== frame.cursor.generation) return false;
  if (frame.kind === "snapshot") return !frame.requests.some(request => request.reqId === identity.reqId && request.pulseQuestionToken === identity.token);
  if (frame.kind === "end") return frame.ended?.reqId === identity.reqId && frame.ended.token === identity.token;
  // A reused reqId gets a new token only after removal (true end/room closure).
  return frame.requests.some(request => request.reqId === identity.reqId && request.pulseQuestionToken !== identity.token);
}
