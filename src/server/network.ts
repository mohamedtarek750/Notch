import * as http from "node:http";
let initialized = false;
/** Honor the managed runtime proxy with Node's supported fetch/HTTP integration. TLS verification stays enabled. */
export function initializeNetwork() {
  if (initialized) return;
  initialized = true;
  const configure = (
    http as typeof http & { setGlobalProxyFromEnv?: () => void }
  ).setGlobalProxyFromEnv;
  if (
    configure &&
    (process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.https_proxy ||
      process.env.http_proxy)
  )
    configure();
}
