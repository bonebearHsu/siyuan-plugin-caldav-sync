/**
 * 本地存储与条目仓库：插件私有数据读写 + 内存索引 + 订阅
 */
import type { CalItem, CalSettings, PersistData } from "./types";
import { DEFAULT_SETTINGS } from "./types";

export interface StoreEnv {
  loadData: () => Promise<any>;
  saveData: (data: any) => Promise<void>;
}

export class CalStore {
  settings: CalSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  private items = new Map<string, CalItem>();
  lastSync?: string;
  lastError?: string;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private env: StoreEnv) {}

  async load(): Promise<void> {
    const data = (await this.env.loadData()) as PersistData | undefined;
    if (data) {
      this.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...data.settings };
      this.items = new Map((data.items || []).map((it) => [keyOf(it), it]));
      this.lastSync = data.sync?.lastSync;
      this.lastError = data.sync?.lastError;
    }
  }

  private persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 400);
  }

  async persist(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.env.saveData({
      settings: this.settings,
      items: Array.from(this.items.values()),
      sync: { lastSync: this.lastSync, lastError: this.lastError }
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.persistSoon();
    for (const fn of this.listeners) fn();
  }

  getAll(): CalItem[] {
    return Array.from(this.items.values());
  }

  get(key: string): CalItem | undefined {
    return this.items.get(key);
  }

  /** upsert（不触发 emit 的低层方法） */
  put(item: CalItem): void {
    this.items.set(keyOf(item), item);
  }

  putAndEmit(item: CalItem): void {
    this.put(item);
    this.emit();
  }

  remove(key: string): void {
    this.items.delete(key);
    this.emit();
  }

  /** 用一批服务端条目合并替换同日历的远端态（保留本地脏数据） */
  mergeServerItems(incoming: CalItem[], deletedKeys: string[] = []): boolean {
    let changed = false;
    for (const inc of incoming) {
      // 本地脏数据优先：等上传后再被服务端确认覆盖
      const existing = this.items.get(keyOf(inc));
      if (existing?.dirty) continue;
      const cur = existing;
      if (cur && cur.href === inc.href) {
        // 同一资源：保留本地字段引用判断是否实质变化
        const same =
          cur.etag === inc.etag &&
          cur.summary === inc.summary &&
          cur.start === inc.start &&
          cur.end === inc.end &&
          cur.description === inc.description &&
          cur.location === inc.location &&
          cur.priority === inc.priority &&
          cur.percent === inc.percent &&
          cur.status === inc.status &&
          cur.raw === inc.raw &&
          JSON.stringify(cur.rrule || null) === JSON.stringify(inc.rrule || null) &&
          JSON.stringify(cur.alarms || null) === JSON.stringify(inc.alarms || null) &&
          JSON.stringify(cur.categories || null) === JSON.stringify(inc.categories || null) &&
          JSON.stringify(cur.exdates || null) === JSON.stringify(inc.exdates || null);
        if (same) continue;
      }
      this.items.set(keyOf(inc), { ...inc, dirty: false, deleted: false });
      changed = true;
    }
    for (const key of deletedKeys) {
      if (this.items.has(key)) {
        this.items.delete(key);
        changed = true;
      }
    }
    // 清理标记 deleted 且已处理完的
    for (const [k, it] of Array.from(this.items.entries())) {
      if (it.deleted && !it.dirty) {
        this.items.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
    return changed;
  }

  /** 待上传的脏条目 */
  dirtyItems(): CalItem[] {
    return this.getAll().filter((it) => it.dirty && !it.deleted);
  }

  /** 待删除 */
  deletedItems(): CalItem[] {
    return this.getAll().filter((it) => it.dirty && it.deleted);
  }

  isConfigured(): boolean {
    return !!this.settings.serverUrl && !!this.settings.username && this.settings.calendars.some((c) => c.enabled);
  }

  /** 手动通知订阅者（数据已被外部流程修改后） */
  notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** 修改 settings 后调用：持久化并通知订阅者 */
  saveSettings(): void {
    this.emit();
  }
}

export function keyOf(item: CalItem): string {
  // 同一资源同一 UID 一条；重复实例覆盖用 recurId 区分
  return item.recurId ? `${item.uid}|${item.recurId}|${item.kind}` : `${item.uid}|${item.kind}`;
}
