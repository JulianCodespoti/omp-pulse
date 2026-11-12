/// <reference types="vite/client" />

/**
 * `VITE_RELEASE_ID` is stamped once by the canonical release pipeline and
 * compiled into the bundle. `VITE_PROTOCOL_VERSION` and
 * `VITE_MIN_CLIENT_PROTOCOL_VERSION` are replaced as number literals from the
 * repository-root protocol-version.json; see web/vite.config.ts.
 */
interface ImportMetaEnv {
  readonly VITE_RELEASE_ID?: string;
  readonly VITE_PROTOCOL_VERSION: number;
  readonly VITE_MIN_CLIENT_PROTOCOL_VERSION: number;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
