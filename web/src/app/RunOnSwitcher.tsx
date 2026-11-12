import { useState } from "react";
import type { JSX } from "react";
import { ChevronDownIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";

import { DropdownMenu, DropdownMenuChoice, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { getOmpLocal, readLocalState, switchComputer } from "../platform/local-mode";
import type { LocalState } from "../platform/local-mode";
import { computerName } from "./session-format";

type Target = { key: string; name: string; detail: string; phone: boolean; url: string | null; current: boolean };

/** This phone (once its runtime is installed) and every saved computer. */
function targetsOf(state: LocalState): Target[] {
  const computers = state.computers ?? (state.laptopUrl ? [state.laptopUrl] : []);
  const list: Target[] = computers.map((url) => {
    const { host, hostname } = new URL(url);
    return { key: url, name: computerName(hostname), detail: host, phone: false, url, current: state.mode === "laptop" && url === state.laptopUrl };
  });
  if (state.supported && state.installed) {
    list.unshift({ key: "phone", name: "This phone", detail: "omp runs here", phone: true, url: null, current: state.mode === "phone" });
  }
  return list;
}

/**
 * The quick switch beside Settings: which machine this list comes from, and
 * a tap to move to another one already set up. Only in the Android app, and
 * only once there are at least two places to choose from. Adding one stays in
 * Settings › Run on. The state is read when the menu opens rather than
 * polled, so the sessions screen pays nothing for it.
 *
 * `trigger` swaps the chip for the caller's own control (the drawer's computer
 * row), which is always shown: it is told whether there is anywhere to switch
 * to, and becomes the menu's trigger when there is. `menu={false}` leaves it a
 * plain control the caller handles (the row, while the computer is down).
 */
export function RunOnSwitcher({ trigger, menu = true }: { trigger?: (switchable: boolean) => JSX.Element; menu?: boolean } = {}): JSX.Element | null {
  const [bridge] = useState(getOmpLocal);
  const [state, setState] = useState(() => (bridge ? readLocalState(bridge) : null));
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const targets = bridge && state ? targetsOf(state) : [];
  if (!bridge || !state || targets.length < 2) return trigger ? trigger(false) : null;
  const current = targets.find((t) => t.current) ?? targets[0];

  const pick = (target: Target) => {
    if (target.current || switching) return;
    setSwitching(target.key);
    // Both restart the app onto the chosen machine; phone mode starts its
    // runtime natively and shows the starting page until omp answers.
    if (target.phone) bridge.setMode("phone");
    else if (switchComputer(bridge, target.url!)) setSwitching(null);
  };

  const button = trigger ? trigger(true) : (
    <button
      type="button"
      data-testid="run-on-switcher"
      aria-label={`Running on ${current.name}. Switch`}
      className="press-bounce flex h-9 min-w-0 max-w-[45%] items-center gap-1.5 rounded-full bg-surface-1 pl-3 pr-2 text-meta font-medium text-foreground"
    >
      {current.phone ? <SmartphoneIcon aria-hidden className="size-4 shrink-0" /> : <MonitorIcon aria-hidden className="size-4 shrink-0" />}
      <span className="truncate">{current.name}</span>
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
  if (!menu) return button;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) setState(readLocalState(bridge));
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger render={button} />
      <DropdownMenuContent align="start" sideOffset={8} data-testid="run-on-switcher-sheet">
        {targets.map((target) => (
          <DropdownMenuChoice
            key={target.key}
            data-testid="run-on-switcher-option"
            icon={target.phone ? <SmartphoneIcon /> : <MonitorIcon />}
            title={target.name}
            subtitle={switching === target.key ? "Switching\u2026" : target.detail}
            selected={target.current}
            disabled={switching !== null && switching !== target.key}
            // Stays up showing "Switching…" until the app restarts onto the choice.
            closeOnClick={false}
            onClick={() => pick(target)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
