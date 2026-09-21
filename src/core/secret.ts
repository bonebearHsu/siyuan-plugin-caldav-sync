/**
 * 凭据密文存储：AES-GCM（WebCrypto）
 *
 * 密文格式（新 → 旧）：
 *   enc:v3: 主密钥 = 本机随机生成，**随插件数据一起保存**（petal 里的 keyring 字段），
 *           并镜像一份到 localStorage。云同步把数据带到别的设备时，密钥同行 →
 *           任何一端都解得开。这是当前唯一的加密格式。
 *   enc:v2: 主密钥 = PBKDF2(conf.system.id + workspaceDir)。**已弃用于加密，仅保留解读**。
 *   enc:v1: 更早的 localStorage 随机密钥。仅保留解读。
 *
 * 【v2 为什么必须淘汰 —— 有实测证据】
 * 密文存在 `data/storage/petal/<插件>/`，这个目录**参与思源云同步**（内核日志里持续出现
 * `cloud upsert [.../storage/petal/siyuan-plugin-caldav-sync/caldav-sync-dock]`）；
 * 而 v2 的密钥来自 `conf/`，conf **不参与云同步**。结果：
 *   手机写入密文 → 同步到 PC → PC 密钥不同解不开 → PC 把「空密码」写回磁盘
 *   → 空串又同步回手机 → 手机也丢。两端来回互相覆盖，表现为「不管手机还是 PC 总是丢密码」。
 * 插件无法写入不参与同步的位置（conf 属思源，插件无写权限），所以唯一稳健解是
 * **让密钥跟着数据走**：代价是同目录可解（等价于本地混淆），换来的是永不丢失。
 *
 * 【另一个历史教训】思源插件 iframe 的端口每次启动都可能变化（实测 7591 / 7594 / 10391），
 * 而 localStorage 按 origin（含端口）隔离，所以 localStorage 不能作为**唯一**的密钥来源，
 * 只能做本机快速副本 —— 真正的权威副本是随数据走的 keyring。
 */
const PREFIX_V3 = "enc:v3:";
const PREFIX_V2 = "enc:v2:";
const PREFIX_V1 = "enc:v1:";
const LS_KEY = "caldav-sync-secret-key";
const LS_KEYRING_V3 = "caldav-sync-keyring-v3";
const LS_PROBE = "__caldav_secret_probe__";
const SALT_V2 = "siyuan-caldav-sync-v2";
const LEGACY_PASS = "siyuan-plugin-caldav-sync";
const LEGACY_SALT = "caldav-sync-local-fallback";

let seed = "";
/** v3 主密钥（base64）；权威副本随数据持久化，见 adoptKeyring() */
let keyring = "";
/** keyring 首次生成时的落盘回调（由 store 注入，把密钥写进 petal 随数据走） */
let keyringSink: ((value: string) => void) | null = null;
const keyCache = new Map<string, Promise<CryptoKey>>();

/** 由插件入口注入设备标识（思源 conf.system.id + 工作空间路径）—— 仅供解 v2 旧密文 */
export function setSecretSeed(value: string): void {
  const v = (value || "").trim();
  if (!v || v === seed) return;
  seed = v;
  keyCache.delete("v2");
}

/**
 * 注入 v3 主密钥（来自持久化数据）。
 * stored 为空时尝试 localStorage 镜像；都没有则保持为空，等首次加密时随机生成。
 * sink 用于把「新生成的密钥」交还调用方持久化 —— 这一步决定了密钥能否随数据同步。
 */
export function adoptKeyring(stored?: string, sink?: (value: string) => void): void {
  if (sink) keyringSink = sink;
  const v = (stored || "").trim();
  if (v) {
    if (v !== keyring) {
      keyring = v;
      keyCache.delete("v3");
    }
    return;
  }
  if (keyring) return;
  const mirror = lsRead(LS_KEYRING_V3);
  if (mirror) {
    keyring = mirror;
    keyCache.delete("v3");
  }
}

/** 当前主密钥（未生成时为空串）；store 用它写进持久化数据 */
export function getKeyring(): string {
  return keyring;
}

function webcrypto(): Crypto | undefined {
  return (globalThis as any)?.crypto as Crypto | undefined;
}

function subtle(): SubtleCrypto | undefined {
  return webcrypto()?.subtle;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function lsRead(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function lsWrite(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 隐私模式 / 端口隔离下写不进去也不致命 —— 权威副本在 petal */
  }
}

function lsUsable(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return false;
    ls.setItem(LS_PROBE, "1");
    ls.removeItem(LS_PROBE);
    return true;
  } catch {
    return false;
  }
}

async function deriveKey(pass: string, salt: string, iterations: number): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await subtle()!.importKey("raw", enc.encode(pass) as any, "PBKDF2", false, ["deriveKey"]);
  return await subtle()!.deriveKey(
    { name: "PBKDF2", salt: enc.encode(salt) as any, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function cached(name: string, factory: () => Promise<CryptoKey>): Promise<CryptoKey> {
  let p = keyCache.get(name);
  if (!p) {
    p = factory().catch((e) => {
      keyCache.delete(name);
      throw e;
    });
    keyCache.set(name, p);
  }
  return p;
}

async function importAesKey(b64: string): Promise<CryptoKey> {
  return subtle()!.importKey("raw", fromB64(b64) as any, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** v3 主密钥：随机生成、随数据走 */
async function ensureKeyringKey(): Promise<CryptoKey> {
  if (!keyring) {
    const bytes = new Uint8Array(32);
    webcrypto()!.getRandomValues(bytes);
    keyring = toB64(bytes);
    lsWrite(LS_KEYRING_V3, keyring);
    keyCache.delete("v3");
    // 交回调用方持久化（store 会写进 petal，从而随云同步到达其它设备）
    keyringSink?.(keyring);
  }
  return cached("v3", () => importAesKey(keyring));
}

/** 兼容密钥：v2 设备标识派生 */
function getKeyV2(): Promise<CryptoKey> {
  return cached("v2", () => deriveKey(seed, SALT_V2, 100000));
}

/** 兼容密钥：v1 旧版 localStorage 随机密钥（读不到时退回固定派生） */
function getLegacyKey(): Promise<CryptoKey> {
  return cached("v1", async () => {
    if (lsUsable()) {
      const stored = lsRead(LS_KEY);
      if (stored) {
        try {
          return await importAesKey(stored);
        } catch {
          /* 密钥损坏，退回固定派生 */
        }
      }
    }
    return deriveKey(LEGACY_PASS, LEGACY_SALT, 1000);
  });
}

async function seal(key: CryptoKey, plain: string): Promise<string> {
  const s = subtle()!;
  const iv = new Uint8Array(12);
  webcrypto()!.getRandomValues(iv);
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: iv as any }, key, new TextEncoder().encode(plain) as any));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv, 0);
  joined.set(ct, iv.length);
  return toB64(joined);
}

async function unseal(key: CryptoKey, payload: string): Promise<string> {
  const data = fromB64(payload);
  const pt = await subtle()!.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) as any }, key, data.slice(12) as any);
  return new TextDecoder().decode(pt);
}

/** 是否为密文格式 */
export function isEncrypted(value: string): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith(PREFIX_V3) || value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1))
  );
}

/** 是否为旧版（v1 / v2）密文 —— 解开后会被自动升级重存为 v3 */
export function isLegacyEncrypted(value: string): boolean {
  return typeof value === "string" && (value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1));
}

/**
 * 解密失败的原因。**必须与「密码本身是空的」区分开**：
 *   unavailable —— 密钥还没就绪（如 v2 的设备标识尚未取到）。这种情况**不能**判定密码损坏，
 *                  也不允许把密文覆盖掉，稍后重试即可。
 *   mismatch    —— 密钥不匹配（密文来自别的设备 / 换过设备 / 数据被覆盖）。
 */
export type SecretDecryptFail = "unavailable" | "mismatch";
export interface SecretDecryptResult {
  ok: boolean;
  /** ok = true 时的明文 */
  value?: string;
  /** ok = false 时的失败原因 */
  reason?: SecretDecryptFail;
}

/** 带原因的解密（新代码请用这个，不要用只看字符串的 decryptSecret） */
export async function decryptSecretEx(stored: string): Promise<SecretDecryptResult> {
  if (!stored) return { ok: true, value: "" };
  if (stored.startsWith(PREFIX_V3)) {
    if (!subtle()) return { ok: false, reason: "unavailable" };
    const k = keyring || lsRead(LS_KEYRING_V3);
    if (!k) return { ok: false, reason: "unavailable" };
    try {
      return { ok: true, value: await unseal(await importAesKey(k), stored.slice(PREFIX_V3.length)) };
    } catch {
      return { ok: false, reason: "mismatch" };
    }
  }
  if (stored.startsWith(PREFIX_V2)) {
    if (!seed || !subtle()) return { ok: false, reason: "unavailable" };
    try {
      return { ok: true, value: await unseal(await getKeyV2(), stored.slice(PREFIX_V2.length)) };
    } catch {
      return { ok: false, reason: "mismatch" };
    }
  }
  if (stored.startsWith(PREFIX_V1)) {
    if (!subtle()) return { ok: false, reason: "unavailable" };
    try {
      return { ok: true, value: await unseal(await getLegacyKey(), stored.slice(PREFIX_V1.length)) };
    } catch {
      return { ok: false, reason: "mismatch" };
    }
  }
  return { ok: true, value: stored };
}

/**
 * 逐层解密：专治「新旧版本混用」造成的**套娃密文**（升级过渡期的安全网）。
 *
 * 旧版（≤ v0.1.8）的 isEncrypted() 只认 enc:v1:/enc:v2:。它遇到新版的 enc:v3:
 * 会当成「旧版明文密码」，在 unlockPassword() 里立刻 persist() 重新加密一遍，
 * 磁盘上于是留下 `enc:v2:(AES("enc:v3:..."))` —— 外层是密文，里面装的还是密文。
 *
 * 只要本机持有能解开外层的密钥（典型情形：手机拿着自己的 v2 设备密钥），
 * 就该继续往里剥，把真正的密码取回来。这样混用期不丢密码：
 * 谁解得开谁收口，第一个解开的设备会把结果重存为 v3，此后全线一致。
 */
export async function decryptSecretDeep(stored: string, maxDepth = 4): Promise<SecretDecryptResult> {
  let cur = stored || "";
  for (let depth = 0; depth < maxDepth; depth++) {
    const r = await decryptSecretEx(cur);
    if (!r.ok) return r; // 外层就解不开：如实回报原因（unavailable / mismatch）
    const val = r.value ?? "";
    if (!isEncrypted(val)) return { ok: true, value: val };
    cur = val; // 剥出来仍是密文 → 再剥一层
  }
  // 层数超限仍不是明文：当异常处理，交由上层保守应对（保留原密文、提示重输），绝不写空
  return { ok: false, reason: "mismatch" };
}

/** 加密；空值或环境不支持时原样返回 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return "";
  try {
    if (!subtle()) return plain;
    return PREFIX_V3 + (await seal(await ensureKeyringKey(), plain));
  } catch {
    // 极端情况（无 WebCrypto / 密钥生成失败）：退回明文也比「密码看起来丢了」强
    return plain;
  }
}

/** 解密；非密文（旧明文）原样返回，解密失败返回空串 */
export async function decryptSecret(stored: string): Promise<string> {
  const r = await decryptSecretEx(stored);
  return r.ok ? r.value ?? "" : "";
}

/** 丢弃本地密钥（仅调试用） */
export function resetSecretKey(): void {
  keyCache.clear();
  keyring = "";
  try {
    globalThis.localStorage?.removeItem(LS_KEY);
    globalThis.localStorage?.removeItem(LS_KEYRING_V3);
  } catch {
    /* ignore */
  }
}
