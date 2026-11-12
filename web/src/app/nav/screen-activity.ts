import { createContext } from "react";

// Portalled sheets inherit their screen's visibility, not their DOM parent's.
// Recovery can cover an editor without closing its sheets or losing input.
export const ScreenActivityContext = createContext(true);
