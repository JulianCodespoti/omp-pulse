import type { JSX } from "react";

export type DeviceRole = "admin" | "control" | "read";

// One role vocabulary for every screen that names a role: the device rows, the
// Access choice when pairing another device, and the screens an admin-only
// action hides behind. `omp-pulse pair` and `setup` print the same meanings
// (src/server/device_auth.rs).
export const ROLE_LABEL: Record<DeviceRole, string> = {
  admin: "Admin",
  control: "Control",
  read: "Read only",
};
// Model providers are named because they are what people miss: the old wording
// ("can't manage other devices") never said a control phone could not add one.
export const ROLE_DETAIL: Record<DeviceRole, string> = {
  admin: "Can do everything: send messages, run commands, add model providers, pair more devices and remove access.",
  control: "Can send messages and run commands on the computer, but can\u2019t add model providers or manage devices.",
  read: "Can read conversations and follow live updates, but can\u2019t send, stop or change anything.",
};

/**
 * How a phone that is not an admin becomes one. A role cannot be changed, so
 * it pairs again; `omp-pulse pair` issues admin codes by default. Shown
 * wherever an admin-only action is out of reach: phones paired under the old
 * control default found Model providers read-only with no hint why or what to do.
 */
export function BecomeAdmin(): JSX.Element {
  return (
    <>
      To make this phone an admin, run <code className="font-mono text-code text-foreground">omp-pulse pair</code> on the
      computer and pair this phone again with the new code.
    </>
  );
}
