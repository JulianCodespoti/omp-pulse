import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

// Scope follows the Conversation's key, so old visits cannot release a new
// visit's navigation. The ref also guards callbacks already queued this frame.
const NavigationOwnership = createContext<{
  active: boolean;
  isActive: () => boolean;
  setActive: (active: boolean) => void;
} | null>(null);

export function NavigationOwnershipProvider({ children }: { children: ReactNode }) {
  const current = useRef(false);
  const [active, updateActive] = useState(false);
  const setActive = useCallback((next: boolean) => {
    current.current = next;
    updateActive(next);
  }, []);
  const value = useMemo(() => ({ active, isActive: () => current.current, setActive }), [active, setActive]);
  return <NavigationOwnership value={value}>{children}</NavigationOwnership>;
}

export function useNavigationOwnership() {
  const value = useContext(NavigationOwnership);
  if (!value) throw new Error("Navigation ownership requires a Conversation");
  return value;
}
