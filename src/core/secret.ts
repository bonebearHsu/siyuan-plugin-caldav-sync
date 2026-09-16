/**
 * 凭据密文存储：AES-GCM（WebCrypto）
 *
 * 主密钥 = PBKDF2(设备标识)，设备标识取思源 conf 里的 system.id + 工作空间路径。
 * conf 目录不参与思源云同步，所以同步到云端的只有密文，没有解密依据。
 *
 * 【为什么不用 localStorage 存密钥】思源插件 iframe 的端口每次启动都可能变化
 * （实测出现过 7591 / 7594 / 10391），而 localStorage 按 origin（含端口）隔离，
 * 换个端口就读不到上次写入的密钥 → 重新生成 → 旧密文无法解密 → 表现为「密码莫名消失」。
 * 因此密钥改为由设备标识稳定派生。enc:v1（localStorage 随机密钥）仅作旧数据兼容。
 */
const PREFIX_V2 = "enc:v2:";
const PREFIX_V1 = "enc:v1:";
const LS_KEY = "caldav-sync-secret-key";
const LS_PROBE = "__caldav_secret_probe__";
const SALT_V2 = "siyuan-caldav-sync-v2";
const LEGACY_PASS = "siyuan-plugin-caldav-sync";
const LEGACY_SALT = "caldav-sync-local-fallback";

let seed = "";
const keyCache = new Map<string, Promise<CryptoKey>>();

/** 由插件入口注入设备标识（思源 conf.system.id + 工作空间路径） */
export function setSecretSeed(value: string): void {
  const v = (value || "").trim();
  if (!v || v === seed) return;
  seed = v;
  keyCache.delete("v2");
}

export function hasSecretSeed(): boolean {
  return !!seed;
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

/** 主密钥：设备标识派生 */
function getKeyV2(): Promise<CryptoKey> {
  return cached("v2", () => deriveKey(seed, SALT_V2, 100000));
}

/** 兼容密钥：旧版 localStorage 随机密钥（读不到时退回固定派生） */
function getLegacyKey(): Promise<CryptoKey> {
  return cached("v1", async () => {
    if (lsUsable()) {
      let stored: string | null = null;
      try {
        stored = globalThis.localStorage.getItem(LS_KEY);
      } catch {
        stored = null;
      }
      if (stored) {
        try {
          return await subtle()!.importKey("raw", fromB64(stored) as any, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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
  return typeof value === "string" && (value.startsWith(PREFIX_V2) || value.startsWith(PREFIX_V1));
}

/** 是否为旧版（localStorage 随机密钥）密文 */
export function isLegacyEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX_V1);
}

/** 加密；空值或环境不支持时原样返回 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return "";
  try {
    if (!subtle()) return plain;
    if (seed) return PREFIX_V2 + (await seal(await getKeyV2(), plain));
    return PREFIX_V1 + (await seal(await getLegacyKey(), plain));
  } catch {
    return plain;
  }
}

/** 解密；非密文（旧明文）原样返回，解密失败返回空串 */
export async function decryptSecret(stored: string): Promise<string> {
  if (!stored) return "";
  if (stored.startsWith(PREFIX_V2)) {
    if (!seed || !subtle()) return "";
    try {
      return await unseal(await getKeyV2(), stored.slice(PREFIX_V2.length));
    } catch {
      return "";
    }
  }
  if (stored.startsWith(PREFIX_V1)) {
    if (!subtle()) return "";
    try {
      return await unseal(await getLegacyKey(), stored.slice(PREFIX_V1.length));
    } catch {
      return "";
    }
  }
  return stored;
}

/** 丢弃本地密钥（仅调试用） */
export function resetSecretKey(): void {
  keyCache.clear();
  try {
    globalThis.localStorage?.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}
