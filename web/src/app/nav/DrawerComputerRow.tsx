import type { JSX } from "react";
import { ChevronDownIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { getOmpLocal, isPhoneMode } from "../../platform/local-mode";
import { RunOnSwitcher } from "../RunOnSwitcher";
import { LINK_INDICATOR_LABEL, computerName } from "../session-format";
import { useLinkIndicator } from "../link-hooks";
import { StatusDot } from "../ui/Status";
import { openSettingsPage } from "./panels";

/**
 * "studio · ● Connected ⌄": which computer these chats live on and whether it
 * answers. The state is the app's one connection truth, `useLinkIndicator()`
 * (the same indicator the Sessions list and Settings show), so the drawer
 * never disagrees with them. Tapping opens the computer switcher; when the
 * computer cannot be reached it is red and opens Settings › Computer, where
 * the fix lives.
 */
export function DrawerComputerRow({ className }: { className: string }): JSX.Element {
  const connection = useLinkIndicator().kind;
  const down = connection === "unreachable" || connection === "offline" || connection === "daemon-down";
  const phone = isPhoneMode();
  const name = computerName(window.location.hostname, phone);
  const Icon = phone ? SmartphoneIcon : MonitorIcon;

  return (
    <RunOnSwitcher
      menu={!down}
      trigger={(switchable) => (
        <button
          type="button"
          data-testid="switcher-computer"
          data-state={connection}
          aria-label={`${name}, ${LINK_INDICATOR_LABEL[connection]}${down ? ". Troubleshoot" : switchable ? ". Switch computer" : ""}`}
          className={cn(className, down && "text-destructive [&>svg]:text-destructive")}
          onClick={() => {
            if (down) openSettingsPage("computer");
            // Nothing to switch to: the app shell adds computers in Run on, the browser has only its connection page.
            else if (!switchable) openSettingsPage(getOmpLocal() ? "run-on" : "computer");
            // Otherwise the tap opens the computer menu (RunOnSwitcher).
          }}
        >
          <Icon aria-hidden />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 truncate">{name}</span>
            <span aria-hidden>·</span>
            <StatusDot tone={connection === "ok" ? "success" : connection === "connecting" ? "warning" : "danger"} />
            <span className="shrink-0">{LINK_INDICATOR_LABEL[connection]}</span>
          </span>
          <ChevronDownIcon aria-hidden />
        </button>
      )}
    />
  );
}
