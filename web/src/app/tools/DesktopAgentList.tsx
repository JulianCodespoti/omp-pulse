import type { JSX } from "react";

import { Row, RowGroup } from "@/app/ui/Row";
import type { DesktopAgent } from "@/domain/desktop-agents";

import {
  AGENT_ROW_CLASS,
  AGENT_STATE_LABEL,
  AgentTile,
  agentDisplayName,
  agentMeta,
  agentRing,
  desktopAgentState,
} from "./agent-status";
import { formatAgo, formatDuration } from "./format";

type DesktopAgentListProps = {
  agents: readonly DesktopAgent[];
  selectedId: string | null;
  onOpen: (agent: DesktopAgent, trigger: HTMLButtonElement) => void;
};

/**
 * The computer's roster; each row opens that agent's conversation. The roster
 * reports no model or usage for its agents, so these rows carry no fact line.
 */
export function DesktopAgentList({ agents, selectedId, onOpen }: DesktopAgentListProps): JSX.Element {
  return (
    <RowGroup aria-label="Agents on your computer">
      {agents.map((agent) => {
        const name = agent.displayName ?? agent.id;
        const shown = agentDisplayName(name);
        const state = desktopAgentState(agent.status);
        const label = AGENT_STATE_LABEL[state];
        const ring = agentRing(state);
        return (
          <Row
            key={agent.id}
            data-desktop-agent={agent.id}
            data-ring={ring}
            className={AGENT_ROW_CLASS}
            aria-label={`Open ${name} conversation, ${label}`}
            selected={selectedId === agent.id}
            onClick={(event) => onOpen(agent, event.currentTarget)}
            leading={<AgentTile kind={name} state={state} />}
            leadingSize="tile"
            title={<span className="block min-w-0 truncate font-medium" title={name}>{shown}</span>}
            subtitle={agentMeta(
              state,
              // How long it has run (or ran, up to its last activity) is the
              // figure worth showing; a bare age only when that is unknown.
              agent.createdAt && agent.lastActivity && agent.lastActivity >= agent.createdAt
                ? formatDuration(agent.lastActivity - agent.createdAt)
                : agent.createdAt ? formatAgo(agent.createdAt) : undefined,
            )}
          />
        );
      })}
    </RowGroup>
  );
}
