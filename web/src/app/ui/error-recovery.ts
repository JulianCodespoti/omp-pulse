import { CpuIcon, KeyRoundIcon, LinkIcon, Share2Icon, ShieldCheckIcon, SmartphoneIcon, StethoscopeIcon, WifiIcon, type LucideIcon } from "lucide-react";
import { isPhoneMode } from "@/platform/local-mode";
import { openSettingsPage } from "../nav/panels";
import { daemonErrorCause } from "./OwnedBySession";

export type RecoveryAction = { label: string; onClick: () => void; icon?: LucideIcon };

/** Navigation only: never changes credentials, retries a send, or discards a draft. */
export function errorRecoveryAction(error: unknown, onChooseModel?: () => void): RecoveryAction | undefined {
  const cause = daemonErrorCause(error);
  switch (cause) {
    case "model":
    case "provider-auth":
      if (cause === "model" && onChooseModel) return { label: "Choose model", icon: CpuIcon, onClick: onChooseModel };
      // Phone or computer, the page can sign in to a provider.
      return { label: "Model providers", icon: KeyRoundIcon, onClick: () => openSettingsPage("providers") };
    case "pairing":
      return { label: "Pair this device", icon: LinkIcon, onClick: () => openSettingsPage("repair-pairing") };
    case "access":
      return { label: "Device access", icon: ShieldCheckIcon, onClick: () => openSettingsPage("computer") };
    case "connection":
      return { label: "Connection details", icon: WifiIcon, onClick: () => openSettingsPage("diagnostics") };
    case "runtime":
      return isPhoneMode()
        ? { label: "Runtime setup", icon: SmartphoneIcon, onClick: () => openSettingsPage("run-on") }
        : { label: "Diagnostics", icon: StethoscopeIcon, onClick: () => openSettingsPage("diagnostics") };
    case "ownership":
      return { label: "Sharing help", icon: Share2Icon, onClick: () => window.dispatchEvent(new CustomEvent("recovery:sharing")) };
    // Unknown errors need a contextual recovery chosen by the caller.
    default:
      return undefined;
  }
}
