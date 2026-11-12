/** A local draft reference, never an instruction or direct-agent command. */
export type AgentDiscussionReference = { identity: string; name: string; text: string };

export function agentDiscussionReference(agent: {
  id: string;
  name: string;
  source: "desktop" | "rpc" | "file";
  createdAt?: number;
  connectionId?: string;
}): AgentDiscussionReference {
  const identity = JSON.stringify({ id: agent.id, source: agent.source,
    ...(agent.createdAt === undefined ? {} : { createdAt: agent.createdAt }),
    ...(agent.connectionId === undefined ? {} : { connectionId: agent.connectionId }),
  });
  return { identity, name: agent.name, text: `About agent ${JSON.stringify(agent.name)} ${identity}:\n` };
}
