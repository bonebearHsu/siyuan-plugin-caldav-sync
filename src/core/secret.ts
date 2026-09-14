/**
 * 凭据密文存储：AES-GCM（WebCrypto）
 * - 随机主密钥持久化在 localStorage（不随思源 data 目录同步，云端只有密文）
 * - localStorage 不可用（如无痕/受限环境）时降级为固定派生密钥，仅做混淆，保证功能可用
 * - 旧版明文密码自动兼容：读到明文会照常使用，并在下次保存时改写为密文
 */
const PREFIX = "enc:v1:";
const LS_KEY = "caldav-sync-secret-key";
const LS_PROBE = "__caldav_secret_probe__";
const FALLBACK_PASS = "siyuan-plugin-caldav-sync";
const FALLBACK_SALT = "caldav-sync-local-fallback";

let keyPromise: Promise<CryptoKey> | null = null;

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

async function importRaw(raw: Uint8Array): Promise<CryptoKey> {
  return await subtle()!.importKey("raw", raw as any, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function fallbackKey(): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await subtle()!.importKey("raw", enc.encode(FALLBACK_PASS) as any, "PBKDF2", false, ["deriveKey"]);
  return await subtle()!.deriveKey(
    { name: "PBKDF2", salt: enc.encode(FALLBACK_SALT) as any, iterations: 1000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function getKey(): Promise<CryptoKey> {
  if (keyPromise) return await keyPromise;
  keyPromise = (async () => {
    if (!lsUsable()) return await fallbackKey();
    let stored: string | null = null;
    try {
      stored = globalThis.localStorage.getItem(LS_KEY);
    } catch {
      stored = null;
    }
    if (stored) {
      try {
        return await importRaw(fromB64(stored));
      } catch {
        /* 密钥损坏，重建 */
      }
    }
    const raw = new Uint8Array(32);
    webcrypto()!.getRandomValues(raw);
    try {
      globalThis.localStorage.setItem(LS_KEY, toB64(raw));
    } catch {
      return await fallbackKey();
    }
    return await importRaw(raw);
  })().catch((e) => {
    keyPromise = null;
    throw e;
  });
  return await keyPromise;
}

/** 是否为密文格式 */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** 加密；空值或环境不支持时原样返回 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return "";
  try {
    const s = subtle();
    if (!s) return plain;
    const key = await getKey();
    const iv = new Uint8Array(12);
    webcrypto()!.getRandomValues(iv);
    const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: iv as any }, key, new TextEncoder().encode(plain) as any));
    const joined = new Uint8Array(iv.length + ct.length);
    joined.set(iv, 0);
    joined.set(ct, iv.length);
    return PREFIX + toB64(joined);
  } catch {
    return plain;
  }
}

/** 解密；非密文（旧明文）原样返回，解密失败返回空串 */
export async function decryptSecret(stored: string): Promise<string> {
  if (!stored) return "";
  if (!isEncrypted(stored)) return stored;
  try {
    const s = subtle();
    if (!s) return "";
    const key = await getKey();
    const data = fromB64(stored.slice(PREFIX.length));
    const pt = await s.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) as any }, key, data.slice(12) as any);
    return new TextDecoder().decode(pt);
  } catch {
    return "";
  }
}

/** 丢弃本地密钥（仅调试用） */
export function resetSecretKey(): void {
  keyPromise = null;
  try {
    globalThis.localStorage?.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}
