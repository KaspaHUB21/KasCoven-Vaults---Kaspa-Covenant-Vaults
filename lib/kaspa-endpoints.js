const DEFAULT_KASPA_API = "http://127.0.0.1:8000";
const DEFAULT_KASPA_WRPC = "ws://172.30.0.1:17110";

export const KASPA_API = String(process.env.KASPA_API || DEFAULT_KASPA_API).replace(/\/+$/, "");
export const KASPA_WRPC = String(process.env.KASPA_WRPC || DEFAULT_KASPA_WRPC);

export function kaspaApiUrl(pathname) {
  const path = String(pathname || "");
  return `${KASPA_API}${path.startsWith("/") ? path : `/${path}`}`;
}
