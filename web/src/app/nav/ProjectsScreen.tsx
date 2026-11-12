import { FolderGit2Icon } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { JSX } from "react";

import { recentProjects } from "../../domain/recent-projects";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { relativeTime } from "../session-format";
import { EmptyState } from "../ui/EmptyState";
import { Row, RowGroup } from "../ui/Row";
import { ScreenHeader } from "../ui/ScreenHeader";
import { useStoreValue } from "../store-hooks";

/**
 * Projects: the folders chats run in, most recently used first.
 *
 * A project has no settings and no record of its own, so this is the list of
 * what the listing already knows. Opening one shows that folder's chats with
 * "New chat" there, which is the whole of what a project is for.
 */
export function ProjectsScreen({
  controller,
  onOpen,
  onClose,
}: {
  controller: OmpSessionController;
  /** A folder's chats. */
  onOpen: (cwd: string) => void;
  onClose: () => void;
}): JSX.Element {
  const store = controller.getStore();
  const sessions = useStoreValue(store, (state) => state.sessions);
  const error = useStoreValue(store, (state) => state.error);
  useEffect(() => {
    // Explicitly unscoped: the controller keeps the last listing's scope, and
    // arriving from one project's chats would otherwise list only that folder.
    void controller.loadSessions({ query: "", pinned: [], project: null }).catch(() => undefined);
  }, [controller]);
  // The same source as the new-chat screen and the drawer, so a folder cannot
  // rank differently in each.
  const projects = useMemo(() => recentProjects(sessions, 50), [sessions]);

  return (
    <main className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="sticky top-0 z-sticky border-b border-hairline bg-background">
        <ScreenHeader title="Projects" onBack={onClose} />
      </header>
      <div className="flex-1 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-3">
        {projects.length === 0 ? (
          <EmptyState
            className="pt-16"
            testId="projects-empty"
            icon={<FolderGit2Icon />}
            title="No projects yet"
            description={error ?? "A project is the folder a chat runs in. Start a chat and it appears here."}
          />
        ) : (
          <RowGroup testId="projects-list">
            {projects.map((project) => (
              <Row
                key={project.cwd}
                testId="project-row"
                data-cwd={project.cwd}
                leading={<FolderGit2Icon />}
                title={project.label}
                subtitle={[
                  `${project.sessionCount} ${project.sessionCount === 1 ? "chat" : "chats"}`,
                  project.lastActiveAt ? relativeTime(project.lastActiveAt) : null,
                ].filter(Boolean).join(" · ")}
                chevron
                onClick={() => onOpen(project.cwd)}
              />
            ))}
          </RowGroup>
        )}
      </div>
    </main>
  );
}
