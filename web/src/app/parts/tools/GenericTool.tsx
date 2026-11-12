"use client";

import { BotIcon } from "lucide-react";
import { useMemo } from "react";

import { Markdown } from "@/components/markdown";
import { Row, RowGroup } from "@/app/ui/Row";

import { DiffPart, looksLikeDiff } from "../DiffPart";
import { PROSE } from "../prose";
import { ArgsDetails, DetailNote, OutputBlock } from "./OutputBlock";
import { TodoBoard } from "./TodoTool";
import { delegatedTasks, toolKind, type ToolUiPart } from "./describe";

/** Subagent work: who was asked to do what, then what they reported, as prose. */
function TaskDetail({ part }: { part: ToolUiPart }) {
  const tasks = delegatedTasks(part.args);
  const output = part.output ?? "";
  return (
    <>
      {tasks.length ? (
        <RowGroup>
          {tasks.map((task, index) => (
            <Row key={index} leading={<BotIcon aria-hidden />} title={task.description || "Task"} subtitle={task.agent || undefined} testId="delegated-task" />
          ))}
        </RowGroup>
      ) : null}
      {output ? (
        part.state === "error"
          ? <OutputBlock text={output} failed copyLabel="Copy error" />
          : (
            <div className="flex min-w-0 flex-col">
              <div className={PROSE} data-testid="task-report">
                <Markdown>{output}</Markdown>
              </div>
            </div>
          )
      ) : null}
    </>
  );
}

/** Any other call: its result as one mono block (or a diff), arguments behind Details. */
export function GenericTool({ part }: { part: ToolUiPart }) {
  const kind = toolKind(part.name);
  const output = part.output ?? "";
  const failed = part.state === "error";
  // Output can be megabytes: sniff it once per output, not on every render of an open detail.
  const isDiff = useMemo(() => !failed && !!output && looksLikeDiff(output), [failed, output]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {kind === "task" ? (
        <TaskDetail part={part} />
      ) : kind === "todo" && part.todo?.length ? (
        <TodoBoard phases={part.todo} />
      ) : isDiff ? (
        <DiffPart text={output} />
      ) : output ? (
        <OutputBlock text={output} failed={failed} copyLabel={failed ? "Copy error" : "Copy output"} />
      ) : null}
      {part.pruned ? <DetailNote>Output removed from the transcript to save space.</DetailNote> : null}
      <ArgsDetails args={part.args} />
    </div>
  );
}
