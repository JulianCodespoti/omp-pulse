import { useContext, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { getOmpLocal, isPhoneMode } from "../../platform/local-mode";
import { readPairingToken } from "../../platform/browser-storage";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { DaemonApi } from "../../runtime/rpc-client";
import { ScreenActivityContext } from "../nav/screen-activity";
import { bridgeSignInTransport, daemonSignInTransport, ProviderSignIn } from "../ProviderSignIn";
import { ModelPicker, useModelCatalogue } from "../sessions/ModelPicker";
import { useStoreValue } from "../store-hooks";
import { Notice } from "../ui/Notice";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { RowGroup, RowSkeleton } from "../ui/Row";

/**
 * Settings › Model providers. The phone's own omp is signed in through the
 * Android bridge; a computer's through its daemon, which only an administrator
 * device may ask. Everything else about the flow is `ProviderSignIn`.
 */
export function ProvidersPage({ controller }: { controller: OmpSessionController }): JSX.Element {
  const active = useContext(ScreenActivityContext);
  const bridge = isPhoneMode() ? getOmpLocal() : undefined;
  const api = useMemo(() => new DaemonApi(readPairingToken()), []);
  const transport = useMemo(() => (bridge ? bridgeSignInTransport(bridge) : daemonSignInTransport(api)), [bridge, api]);

  // The phone owns its own omp. A computer's accounts are the administrator's.
  const [canManage, setCanManage] = useState<boolean | null>(bridge ? true : null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleAttempt, setRoleAttempt] = useState(0);
  useEffect(() => {
    if (bridge) return;
    let cancelled = false;
    setRoleError(null);
    api.deviceRole().then(
      (role) => {
        if (!cancelled) setCanManage(role === "admin");
      },
      (cause: unknown) => {
        if (!cancelled) setRoleError(humanizeDaemonError(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, bridge, roleAttempt]);

  // Any listed session can answer the catalogue; it is also what proves a
  // provider works when the credential store cannot be read.
  const sessionPath = useStoreValue(controller.getStore(), (state) => state.sessions[0]?.path ?? null);
  const catalogue = useModelCatalogue(sessionPath, true);
  const catalogueProviders = useMemo(() => [...new Set(catalogue.models.map((model) => model.provider))], [catalogue.models]);
  // `retry` is stable: a changed identity would make the sign-in report again.
  const { retry } = catalogue;
  const [choosing, setChoosing] = useState(false);

  if (roleError) {
    return (
      <Notice tone="danger" action={{ label: "Try again", onClick: () => setRoleAttempt((n) => n + 1) }}>
        {roleError}
      </Notice>
    );
  }
  if (canManage === null) {
    return (
      <RowGroup inset>
        <RowSkeleton leading />
        <RowSkeleton leading />
      </RowGroup>
    );
  }
  return (
    <>
      <ProviderSignIn
        transport={transport}
        active={active}
        canManage={canManage}
        catalogueProviders={catalogueProviders}
        onSignedIn={retry}
        onChooseModel={sessionPath ? () => setChoosing(true) : undefined}
      />
      {sessionPath ? <ModelPicker open={choosing} onOpenChange={setChoosing} sessionPath={sessionPath} /> : null}
    </>
  );
}
