const DEFAULT_KASPA_API = "https://api.kaspa.org";
const DEFAULT_KASPA_HISTORY_API = "https://api.kaspa.org";
const DEFAULT_KASPA_WRPC = "";

export const KASPA_API = String(process.env.KASPA_API || DEFAULT_KASPA_API).replace(/\/+$/, "");
export const KASPA_HISTORY_API = String(process.env.KASPA_HISTORY_API || DEFAULT_KASPA_HISTORY_API).replace(/\/+$/, "");
export const KASPA_WRPC = String(process.env.KASPA_WRPC || DEFAULT_KASPA_WRPC);

export function kaspaApiUrl(pathname) {
  const path = String(pathname || "");
  return `${KASPA_API}${path.startsWith("/") ? path : `/${path}`}`;
}

export function kaspaHistoryApiUrl(pathname) {
  const path = String(pathname || "");
  return `${KASPA_HISTORY_API}${path.startsWith("/") ? path : `/${path}`}`;
}
