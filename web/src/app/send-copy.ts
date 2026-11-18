// Copy shared by every surface that reports a send. A module of its own
// (not Notices.tsx) because DOM tests replace the Notices module with a stub
// that exports only the toast functions.

/**
 * The one name and the one sentence for a send whose delivery could not be
 * confirmed. The transcript pill, the outbox bar and the toast each used to
 * word it their own way ("Delivery unconfirmed", "Couldn't confirm it was
 * sent", "Delivery could not be confirmed"), so one state read as three.
 */
export const UNCERTAIN_LABEL = "Not confirmed";
export const UNCERTAIN_HINT = "We couldn’t confirm this message arrived. Check the conversation before sending again.";
export const UNCERTAIN_SEND_TOAST = UNCERTAIN_HINT;

/**
 * A removal that did not happen because the send moved on (it was delivered,
 * retried or replaced between the tap and the removal). Without a word the
 * row simply reappeared, which read as a broken button.
 */
export const SEND_KEPT_NOTICE = "This message changed, so it was kept.";
export const EDIT_KEPT_NOTICE = "Your message is back in the composer, but the original changed, so it was kept in the queue.";
