import { useEffect, useState } from "react";
import type { JSX } from "react";
import { ArrowUpIcon, CheckSquareIcon, ListIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { collabAnswerMatches, collabAnswerStatus } from "../../runtime/collab-answer";
import { useStoreValue } from "../store-hooks";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { Notice } from "../ui/Notice";
import { Row, RowGroup } from "../ui/Row";
import { BottomSheet } from "../ui/Sheet";

// omp's ask tool marks the recommended option by appending this suffix to its
// label (tools/ask.ts RECOMMENDED_SUFFIX) and strips it from the answer, so the
// value is sent back untouched while the UI shows a badge instead of the text.
const RECOMMENDED_SUFFIX = " (Recommended)";

export interface CollabDialogProps {
  controller: OmpSessionController;
  onPendingChange?: (hasPending: boolean) => void;
}

/** A question remains visible until the host closes it, not just transport handoff. */
export function CollabDialog({ controller, onPendingChange }: CollabDialogProps): JSX.Element | null {
  const store = controller.getStore();
  const collabRequest = useStoreValue(store, (s) => s.collabRequest);
  const sessionPath = useStoreValue(store, (s) => s.sessionPath);
  const held = useStoreValue(store, (s) => s.heldCollabResponse);
  const answer = useStoreValue(store, (s) => s.collabAnswer);
  const capacityBlocked = useStoreValue(store, () => !controller.canRetainCollabAnswer());
  const hasPending = collabRequest !== null;
  const currentAnswer = collabAnswerMatches(answer, sessionPath, collabRequest?.reqId)
    && answer?.question.token === collabRequest?.pulseQuestionToken ? answer : null;
  const isHeld = capacityBlocked || (currentAnswer !== null && currentAnswer.phase !== "draft" && currentAnswer.phase !== "rejected")
    || (held !== null && collabRequest !== null && held.reqId === collabRequest.reqId
      && held.pulseQuestionToken === collabRequest.pulseQuestionToken);

  useEffect(() => {
    onPendingChange?.(hasPending);
  }, [hasPending, onPendingChange]);

  const identity = JSON.stringify([sessionPath, collabRequest?.reqId, collabRequest?.pulseQuestionToken]);
  const textValue = typeof currentAnswer?.value === "string" ? currentAnswer.value : collabRequest?.initialValue ?? "";
  const [hiddenIdentity, setHiddenIdentity] = useState<string | null>(null);
  const isHidden = hiddenIdentity === identity;
  const [owner, setOwner] = useState(controller);
  if (owner !== controller) {
    setOwner(controller);
    setHiddenIdentity(null);
  }

  function send(value: string | null): void {
    if (!collabRequest || isHeld) return;
    controller.sendCollabUiResponse(collabRequest.reqId, value, collabRequest.pulseQuestionToken);
  }

  // Seed the bounded, token-bound draft owner, not component state. In
  // particular an intentionally cleared draft is different from no draft.
  useEffect(() => {
    if (collabRequest?.kind === "editor" && !currentAnswer && !isHeld) {
      controller.setCollabAnswerDraft(collabRequest.reqId, collabRequest.initialValue ?? "", collabRequest.pulseQuestionToken);
    }
  }, [controller, collabRequest, currentAnswer, isHeld]);

  // The track strip's pill (and the legacy banner event) reopen a hidden sheet.
  useEffect(() => {
    const reopen = (): void => setHiddenIdentity(null);
    window.addEventListener("collab:show", reopen);
    window.addEventListener("collab-banner-tap", reopen);
    return () => {
      window.removeEventListener("collab:show", reopen);
      window.removeEventListener("collab-banner-tap", reopen);
    };
  }, []);

  if (!collabRequest) return null;
  const { kind, prompt, options, placeholder } = collabRequest;
  const isChoice = kind === "choice" || kind === "confirm";
  const multi = collabRequest.selectionMarker === "checkbox";
  const markableCount = collabRequest.markableCount ?? options?.length ?? 0;
  // A blank text answer is never sent (Enter sent "" with no sign of it). An
  // editor may be deliberately emptied, as ExtensionDialogSheet allows for its editor.
  const blankText = kind === "text" && !textValue.trim();
  const sending = currentAnswer?.phase === "sending";
  const optionRow = (opt: NonNullable<typeof options>[number], idx: number): JSX.Element => {
    const recommended = opt.label.endsWith(RECOMMENDED_SUFFIX);
    const label = recommended ? opt.label.slice(0, -RECOMMENDED_SUFFIX.length) : opt.label;
    const toggle = multi && idx < markableCount;
    const checked = toggle && (collabRequest.checkedIndices?.includes(idx) ?? false);
    return <Row
      key={`${collabRequest.reqId}-${idx}-${opt.value}`}
      testId="collab-option"
      data-collab-action={toggle ? "toggle" : "answer"}
      role={toggle ? "checkbox" : undefined}
      aria-checked={toggle ? checked : undefined}
      aria-current={undefined}
      selected={checked}
      disabled={isHeld}
      leading={toggle ? checked ? <CheckSquareIcon aria-hidden /> : <SquareIcon aria-hidden /> : undefined}
      title={label}
      subtitle={opt.description}
      trailing={recommended ? <Chip tone="accent" testId="collab-recommended">Recommended</Chip> : undefined}
      onClick={() => send(opt.value)}
    />;
  };

  return (
    <BottomSheet
      open={!isHidden}
      onOpenChange={(next) => {
        if (!next) setHiddenIdentity(identity);
      }}
      title="Question"
      testId="collab-dialog"
      footer={
        <Button variant="ghost" className="w-full" disabled={isHeld} onClick={() => send(null)} data-testid="collab-skip">
          Skip question
        </Button>
      }
    >
      <div id="collab-dialog" className="flex flex-col gap-4">
        <p className="whitespace-pre-wrap break-words text-body">{prompt}</p>
        {capacityBlocked ? (
          <Notice tone="warning" testId="collab-capacity">Earlier answers are still waiting. Finish one of those questions before starting another; your drafts are kept.</Notice>
        ) : currentAnswer && currentAnswer.phase !== "draft" ? (
          <Notice tone={currentAnswer.phase === "rejected" ? "danger" : "warning"} testId="collab-held">
            <span role="status">{collabAnswerStatus(currentAnswer)}</span>
            {currentAnswer.value !== null ? <p className="mt-1 whitespace-pre-wrap break-words">Your answer: {currentAnswer.value || "(empty)"}</p> : <p className="mt-1">Cancellation requested</p>}
          </Notice>
        ) : isHeld ? (
          <Notice tone="warning" testId="collab-held">Waiting for your connection. Your answer is kept.</Notice>
        ) : null}
        {isChoice ? (
          !options || options.length === 0 ? (
            <EmptyState icon={<ListIcon />} title="No options" className="py-6" />
          ) : (
            <div className="space-y-3">
              {multi ? <p className="text-meta text-muted-foreground" data-testid="collab-selection-help">Selections confirmed by desktop OMP. Tap a choice to toggle it; use the actions below to continue.</p> : null}
              <RowGroup inset aria-label={prompt}>
                {options.slice(0, multi ? markableCount : options.length).map(optionRow)}
              </RowGroup>
              {multi && options.length > markableCount ? (
                <RowGroup inset title="Continue or enter another answer" testId="collab-selection-actions">
                  {options.slice(markableCount).map((option, index) => optionRow(option, markableCount + index))}
                </RowGroup>
              ) : null}
            </div>
          )
        ) : (
          <div className="flex items-end gap-2">
            {kind === "editor" ? (
              <Textarea
                id="collab-text-input"
                aria-label={prompt}
                disabled={isHeld}
                className="min-h-36 flex-1 rounded-lg"
                placeholder={placeholder ?? "Edit your answer"}
                value={textValue}
                onChange={(e) => controller.setCollabAnswerDraft(collabRequest.reqId, e.target.value, collabRequest.pulseQuestionToken)}
              />
            ) : (
              <Input
                id="collab-text-input"
                aria-label={prompt}
                disabled={isHeld}
                className="h-11 flex-1 rounded-lg"
                placeholder={placeholder ?? "Type your answer"}
                value={textValue}
                onChange={(e) => controller.setCollabAnswerDraft(collabRequest.reqId, e.target.value, collabRequest.pulseQuestionToken)}
                onKeyDown={(e) => {
                  if (e.repeat || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.key === "Enter" && !blankText) send(textValue);
                }}
              />
            )}
            <Button
              variant="primary"
              size={sending ? "md" : "icon"}
              aria-label={sending ? "Sending answer" : "Send answer"}
              disabled={isHeld || blankText}
              onClick={() => send(textValue)}
            >
              {sending ? (
                <>
                  <Spinner size={14} label={null} />
                  Sending…
                </>
              ) : (
                <>
                  {currentAnswer?.phase === "rejected" ? <span className="sr-only">Retry answer</span> : null}
                  <ArrowUpIcon className="size-5" aria-hidden />
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
