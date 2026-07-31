import { Agent, fetch as undiciFetch } from "undici";
import { socksConnector } from "fetch-socks";
import logger from "./logger.js";

// Parse a SOCKS proxy URL (socks5://[user:pass@]host:port; socks4:// → type 4) into the
// shape fetch-socks wants. Returns null for empty/invalid input (→ direct connection).
// Exported for unit tests.
export function parseSocksProxy(url: string): { type: 4 | 5; host: string; port: number; userId?: string; password?: string } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const type = u.protocol === "socks4:" || u.protocol === "socks4a:" ? 4 : 5;
  return {
    type,
    host: u.hostname,
    port: Number(u.port) || 1080,
    ...(u.username ? { userId: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

export type SocksProxyCfg = NonNullable<ReturnType<typeof parseSocksProxy>>;

// A fetch that dials through the SOCKS proxy. Uses undici's OWN fetch + Agent (not Node's
// global fetch): the connector's dispatcher must come from the SAME undici that runs the
// request, or the handler interfaces mismatch (UND_ERR_INVALID_ARG onRequestStart). TLS/SNI
// to the real host is preserved by the connector, so no /etc/hosts trick is needed.
// Exported for tests. Returns a fetch typed as the global one for the OpenAI SDK.
export function buildSocksFetch(proxy: SocksProxyCfg): typeof fetch {
  const agent = new Agent({ connect: socksConnector({ type: proxy.type, host: proxy.host, port: proxy.port, userId: proxy.userId, password: proxy.password }) });
  const f = (input: string | URL, init?: Record<string, unknown>) => undiciFetch(input, { ...init, dispatcher: agent });
  return f as unknown as typeof fetch;
}

// null = no proxy configured, use a direct connection. Both API-format paths call this so
// the proxy decision (and its one startup log line) exists in exactly one place.
export function proxiedFetch(socksProxyUrl: string): typeof fetch | null {
  const proxy = parseSocksProxy(socksProxyUrl);
  if (!proxy) return null;
  logger.info(`[llm] routing LLM API through SOCKS${proxy.type} proxy ${proxy.host}:${proxy.port}`);
  return buildSocksFetch(proxy);
}
