export type NoticePauseReason = "hover" | "focus" | "touch" | "hidden";
export type NoticePauseState = Readonly<Record<NoticePauseReason, boolean>>;
export const NO_NOTICE_PAUSE: NoticePauseState = { hover: false, focus: false, touch: false, hidden: false };

export function setNoticePause(state: NoticePauseState, reason: NoticePauseReason, active: boolean): NoticePauseState {
  return state[reason] === active ? state : { ...state, [reason]: active };
}

export function isNoticePaused(state: NoticePauseState): boolean {
  return state.hover || state.focus || state.touch || state.hidden;
}
