/**
 * HTTP 通道：思源内核代理（无 CORS 限制，默认）+ 浏览器直连（回退）
 * 不 import "siyuan"，以便在 Node 测试环境独立运行
 */

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
  via: "proxy" | "direct";
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type Channel = "auto" | "proxy" | "direct";

/** 内核代理通道的相对根（思源渲染进程同源）；测试环境可覆盖 */
export let kernelBase = "";
export function setKernelBase(base: string) {
  kernelBase = base;
}

function normalizeHeaders(h: Record<string, string[]> | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const k of Object.keys(h)) {
    const v = (h as any)[k];
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

async function viaProxy(url: string, opts: HttpOptions): Promise<HttpResult> {
  const t0 = Date.now();
  const res = await fetch(kernelBase + "/api/network/forwardProxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: opts.method || "GET",
      timeout: Math.floor(opts.timeoutMs || 30000),
      contentType: "text/plain",
      headers: Object.entries(opts.headers || {}).map(([k, v]) => [k, v]),
      payload: opts.body ? btoa(unescape(encodeURIComponent(opts.body))) : undefined,
      payloadEncoding: "base64",
      responseEncoding: "text"
    })
  });
  const data: any = await res.json();
  if (data.code !== 0) throw new Error("内核代理失败: " + (data.msg || JSON.stringify(data)));
  const d = data.data || {};
  const body = typeof d.body === "string" ? d.body : d.body?.content ?? "";
  return {
    status: d.status ?? 0,
    headers: normalizeHeaders(d.headers),
    body,
    elapsedMs: Date.now() - t0,
    via: "proxy"
  };
}

async function viaDirect(url: string, opts: HttpOptions): Promise<HttpResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body, elapsedMs: Date.now() - t0, via: "direct" };
  } finally {
    clearTimeout(timer);
  }
}

export function basicAuthHeader(username: string, password: string): string {
  return "Basic " + btoa(unescape(encodeURIComponent(username + ":" + password)));
}

/**
 * 按通道发起请求；channel=auto 时代理失败自动回退直连
 */
export async function httpRequest(
  url: string,
  opts: HttpOptions,
  channel: Channel,
  auth?: { username: string; password: string }
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (auth) headers["Authorization"] = basicAuthHeader(auth.username, auth.password);
  const full: HttpOptions = { ...opts, headers };

  const tryProxy = async () => viaProxy(url, full);
  const tryDirect = async () => viaDirect(url, full);

  if (channel === "direct") return tryDirect();
  if (channel === "proxy") return tryProxy();
  try {
    return await tryProxy();
  } catch (e) {
    console.warn("[caldav] 内核代理通道失败，回退浏览器直连:", e);
    return tryDirect();
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}
