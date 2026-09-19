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

/**
 * 直连失败后是否自动改走内核代理。
 *
 * 为什么需要：移动端 WebView 会拦掉「明文 HTTP + 跨域」的直连请求，
 * 表现就是 `TypeError: Failed to fetch`（PC 上同样的配置却能通）。
 * 用户此时往往已经在设置里选了「仅浏览器直连」，光靠文案提示不够——
 * 直连在网络层就失败时，静默改走内核代理（Go 侧发起请求，无 CORS、无明文限制）。
 *
 * 只在收到「网络级错误」时兜底：401/404 这类服务器真实响应不会走到这里，
 * 「仅浏览器直连」的语义在服务器可达时仍然成立。
 * 由入口按 isMobile() 打开，core 层不 import "siyuan"。
 */
export let directFallbackToProxy = false;
export function setDirectFallbackToProxy(on: boolean) {
  directFallbackToProxy = on;
}

/** 网络级失败（请求根本没到达服务器）而非服务器返回的 HTTP 错误 */
export function isNetworkLevelError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /failed to fetch|networkerror|network request failed|load failed|err_/i.test(msg);
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

/**
 * 组装 /api/network/forwardProxy 的请求体。
 *
 * 三个必须遵守的内核约定（均已实测确认，SiYuan 3.1.0 与 3.8.4 一致）：
 * 1. `headers` 必须是「单键对象数组」`[{"k":"v"}]`，不是键值对数组 `[["k","v"]]`。
 *    传成后者时，内核遍历 `map[string]any` 取不到任何键，**自定义头被静默丢弃**——
 *    表现为代理通道永远 401（Authorization 没送到），而直连通道一切正常。
 * 2. `contentType` 是独立字段，内核会用它覆盖请求头里的 Content-Type；
 *    若固化传 text/plain，PROPFIND 的 application/xml 会被改写。
 * 3. `payloadEncoding: "base64"` 时内核要求 `payload` 必须是字符串：
 *    无 body 的请求（DELETE）也要传空串，否则报 `[payload] must be a string`。
 *    另外 `payloadEncoding: "text"` 不会发送 body，所以 body 一律走 base64。
 */
export function buildProxyBody(url: string, opts: HttpOptions): Record<string, unknown> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let contentType = "text/plain";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") {
      contentType = headers[k];
      delete headers[k];
    }
  }
  return {
    url,
    method: opts.method || "GET",
    timeout: Math.floor(opts.timeoutMs || 30000),
    contentType,
    headers: Object.entries(headers).map(([k, v]) => ({ [k]: v })),
    payload: btoa(unescape(encodeURIComponent(opts.body ?? ""))),
    payloadEncoding: "base64",
    responseEncoding: "text"
  };
}

async function viaProxy(url: string, opts: HttpOptions): Promise<HttpResult> {
  const t0 = Date.now();
  const res = await fetch(kernelBase + "/api/network/forwardProxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildProxyBody(url, opts))
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

  if (channel === "direct") {
    try {
      return await tryDirect();
    } catch (e) {
      // 直连在网络层就被拦（常见于手机 WebView 的明文 HTTP / 跨域限制）→ 改走内核代理
      if (!directFallbackToProxy || !isNetworkLevelError(e)) throw e;
      console.warn("[caldav] 浏览器直连被拦截，改走内核代理:", e);
      return tryProxy();
    }
  }
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
