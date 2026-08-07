import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  DEMO_SESSION_EVENT,
  clearDemoSession,
  createDemoSession,
  readDemoSession,
  writeDemoSession,
  type DemoSession,
} from "@/utils/demo-session";

/**
 * React binding for the demo session store. See `src/utils/demo-session.ts` —
 * this is a mock of a signed-in state, not authentication.
 *
 * `ready` exists because the store lives in localStorage, which the server
 * cannot read. The first client render must therefore match the server's
 * (session === null, ready === false) or hydration mismatches; the real value
 * arrives on the effect immediately after. Anything that gates on the session
 * must wait for `ready`, otherwise it will act on a false "signed out" during
 * that first paint.
 */

interface DemoSessionValue {
  session: DemoSession | null;
  /** False until localStorage has been read on the client. */
  ready: boolean;
  signIn: (operator: string, remember: boolean) => DemoSession;
  signOut: () => void;
}

const DemoSessionContext = createContext<DemoSessionValue | null>(null);

export function DemoSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<DemoSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(readDemoSession());
    setReady(true);

    // Same-tab writes go through the custom event; `storage` covers other tabs
    // so signing out in one window signs out the rest.
    const resync = () => setSession(readDemoSession());
    window.addEventListener(DEMO_SESSION_EVENT, resync);
    window.addEventListener("storage", resync);
    return () => {
      window.removeEventListener(DEMO_SESSION_EVENT, resync);
      window.removeEventListener("storage", resync);
    };
  }, []);

  const signIn = useCallback((operator: string, remember: boolean) => {
    const next = createDemoSession(operator, remember);
    writeDemoSession(next);
    setSession(next);
    return next;
  }, []);

  const signOut = useCallback(() => {
    clearDemoSession();
    setSession(null);
  }, []);

  const value = useMemo<DemoSessionValue>(
    () => ({ session, ready, signIn, signOut }),
    [session, ready, signIn, signOut],
  );

  return <DemoSessionContext.Provider value={value}>{children}</DemoSessionContext.Provider>;
}

export function useDemoSession(): DemoSessionValue {
  const ctx = useContext(DemoSessionContext);
  if (!ctx) throw new Error("useDemoSession must be used inside <DemoSessionProvider>");
  return ctx;
}
