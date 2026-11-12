import type { AgentDiscussionReference } from "./agent-discussion";

/** Memory-only provenance for references explicitly prepared in this visit. */
export type AgentDraftProjection = {
  namespace: string;
  path: string;
  prefix: string;
  references: readonly AgentDiscussionReference[];
  text: string;
};

function canonicalText(prefix: string, references: readonly AgentDiscussionReference[]): string {
  return references.reduce((text, reference) => text ? `${text}\n\n${reference.text}` : reference.text, prefix);
}

/** A match proves every prefix, block and app-owned separator still exists. */
export function validAgentDraftProjection(
  projection: AgentDraftProjection | null,
  text: string,
  namespace: string,
  path: string | null,
): AgentDraftProjection | null {
  if (!projection || path === null || projection.namespace !== namespace || projection.path !== path
    || projection.references.length === 0 || projection.text !== text
    || canonicalText(projection.prefix, projection.references) !== text) return null;
  return projection;
}

/** The caller deduplicates identities before preparing a newly generated block. */
export function appendAgentDraftReference(
  projection: AgentDraftProjection | null,
  text: string,
  namespace: string,
  path: string,
  reference: AgentDiscussionReference,
): AgentDraftProjection {
  const current = validAgentDraftProjection(projection, text, namespace, path);
  // Unproven raw text stays entirely editable, even if it resembles a reference.
  const prefix = current ? current.prefix : text;
  const references = [...(current?.references ?? []), { ...reference }];
  return { namespace, path, prefix, references, text: canonicalText(prefix, references) };
}

/** Call only after validating against the current canonical draft and scope. */
export function replaceAgentDraftPrefix(projection: AgentDraftProjection, prefix: string): AgentDraftProjection {
  return { ...projection, prefix, text: canonicalText(prefix, projection.references) };
}

/** A final removal leaves the caller's unchanged projection.prefix as raw text. */
export function removeAgentDraftReference(projection: AgentDraftProjection, identity: string): AgentDraftProjection | null {
  const references = projection.references.filter(reference => reference.identity !== identity);
  if (references.length === projection.references.length) return projection;
  if (references.length === 0) return null;
  return { ...projection, references, text: canonicalText(projection.prefix, references) };
}
