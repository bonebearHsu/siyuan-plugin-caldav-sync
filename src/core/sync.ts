/**
 * 双向同步引擎：
 * - 拉取：优先 sync-collection 增量，回退 calendar-query 全量
 * - 上传：本地脏条目 PUT（带 If-Match），412 冲突按策略处理
 * - 删除：本地 deleted 标记 -> 服务端 DELETE
 */
import type { CalItem } from "./types";
import { keyOf, type CalStore } from "./store";
import { syncCollection, fetchCalendarItems, putItem, deleteItem, icsRangeIso, type DavAuth } from "./caldav";
import { httpRequest } from "./http";
import { itemToEditedICS, itemToNewICS } from "./ics";
import { dateStampOfMs, stampOfMs } from "./date";
import type { Channel } from "./http";

export interface SyncReport {
  ok: boolean;
  fetched: number;
  uploaded: number;
  deleted: number;
  errors: string[];
  elapsedMs: number;
}

/** 把底层网络错误翻成可读提示（"Failed to fetch" 对用户毫无信息量） */
function explainError(e: any): string {
  const msg = e?.message || String(e);
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(msg)) {
    return "网络请求失败（服务不可达，或直连被跨域拦截，建议把请求通道改为「内核代理」）";
  }
  if (/timeout|aborted|abort/i.test(msg)) return "请求超时";
  if (/401/.test(msg)) return "认证失败（401）：用户名或密码错误";
  if (/403/.test(msg)) return "无权限（403）";
  return msg;
}

export class SyncEngine {
  private syncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: CalStore,
    private getChannel: () => Channel
  ) {}

  private auth(): DavAuth {
    return { username: this.store.settings.username, password: this.store.settings.password };
  }

  private channel(): Channel {
    return this.getChannel();
  }

  /** 启动定时同步（分钟） */
  startAutoSync(onDone?: () => void): void {
    this.stopAutoSync();
    const min = this.store.settings.syncIntervalMin;
    if (!min || min <= 0) return;
    this.timer = setInterval(() => {
      void this.syncAll().then(() => onDone?.());
    }, min * 60000);
  }

  stopAutoSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncAll(): Promise<SyncReport> {
    if (this.syncing) return { ok: false, fetched: 0, uploaded: 0, deleted: 0, errors: ["正在同步中"], elapsedMs: 0 };
    this.syncing = true;
    const t0 = Date.now();
    const report: SyncReport = { ok: true, fetched: 0, uploaded: 0, deleted: 0, errors: [], elapsedMs: 0 };
    try {
      // 凭据缺失时直接给出明确错误，不再发无效请求、也不再显示“同步成功”
      const credErr = this.credentialError();
      if (credErr) {
        report.ok = false;
        report.errors.push(credErr);
        this.store.lastError = credErr;
        return report;
      }
      const enabledCals = this.store.settings.calendars.filter((c) => c.enabled);
      if (!enabledCals.length) {
        report.ok = false;
        report.errors.push("没有启用的日历");
        this.store.lastError = "没有启用的日历";
        return report;
      }
      const rangeStart = Date.now() - this.store.settings.pastDays * 86400000;
      const rangeEnd = Date.now() + this.store.settings.futureDays * 86400000;

      // 1. 先上传本地脏数据（新条目无 etag 直接 PUT；有 etag 带条件）
      await this.pushDirty(report);

      // 2. 逐日历拉取
      for (const cal of this.store.settings.calendars) {
        if (!cal.enabled) continue;
        try {
          let items: CalItem[] = [];
          let deletedHrefs: string[] = [];
          if (cal.syncToken) {
            try {
              const r = await syncCollection(cal, this.channel(), this.auth(), cal.syncToken);
              items = r.items;
              deletedHrefs = r.deletedHrefs;
              if (r.syncToken) cal.syncToken = r.syncToken;
            } catch (e: any) {
              // sync-token 失效等，回退全量
              console.warn("[caldav] sync-collection 失败，回退全量:", e?.message);
              cal.syncToken = undefined;
            }
          }
          if (!cal.syncToken) {
            const r = await fetchCalendarItems(
              cal,
              this.channel(),
              this.auth(),
              icsRangeIso(rangeStart),
              icsRangeIso(rangeEnd)
            );
            items = r.items;
            // 尝试获取 sync-token 供下次增量（RFC 6578：PROPFIND sync-token）
            cal.syncToken = await this.tryGetSyncToken(cal);
          }
          report.fetched += items.length;
          const deletedKeys = deletedHrefs
            .map((h) => this.findKeyByHref(h, cal.url))
            .filter(Boolean) as string[];
          this.store.mergeServerItems(items, deletedKeys);
        } catch (e: any) {
          report.ok = false;
          report.errors.push(`${cal.displayName}: ${explainError(e)}`);
        }
      }

      // 3. 已删除条目已在 pushDirty 中处理（成功后即从本地移除），此处不再重复 DELETE

      // 使用本地时区墙上时间（东八区等），避免 toISOString() 输出 UTC 导致显示偏差
      this.store.lastSync = stampOfMs(Date.now()).replace("T", " ");
      this.store.lastError = report.errors.length ? report.errors.join("; ") : undefined;
    } finally {
      this.syncing = false;
      report.elapsedMs = Date.now() - t0;
      await this.store.persist();
      // 通知订阅者（Dock 状态栏等）刷新，否则自动同步失败时界面不会更新
      this.store.notify();
    }
    return report;
  }

  /** 凭据不可用时的统一提示（密码为空/解密失败），避免静默 401 */
  private credentialError(): string | undefined {
    const s = this.store.settings;
    if (!s.serverUrl) return "未配置服务器地址";
    if (!s.username) return "未填写用户名";
    if (this.store.secretBroken) return "密码解密失败，请在设置中重新输入密码";
    if (!s.password) return "未填写密码，请在设置中填写";
    return undefined;
  }

  private findKeyByHref(href: string, calUrl: string): string | undefined {
    const norm = (u: string) => decodeURIComponent(u).replace(/\/+$/, "");
    for (const it of this.store.getAll()) {
      if (norm(it.href) === norm(href) && it.calendarUrl === calUrl) {
        return it.recurId ? `${it.uid}|${it.recurId}|${it.kind}` : `${it.uid}|${it.kind}`;
      }
    }
    return undefined;
  }

  private async tryGetSyncToken(cal: import("./types").CalCalendar): Promise<string | undefined> {
    try {
      const res = await httpRequest(
        cal.url,
        {
          method: "PROPFIND",
          headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
          body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:sync-token/></D:prop></D:propfind>`,
          timeoutMs: 15000
        },
        this.channel(),
        this.auth()
      );
      if (res.status >= 400) return undefined;
      const m = /<(?:[A-Za-z0-9_-]+:)?sync-token[^>]*>([^<]*)</.exec(res.body);
      return m ? m[1].trim() || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  private async pushDirty(report: SyncReport): Promise<void> {
    // 新建 / 修改
    for (const item of this.store.dirtyItems()) {
      try {
        const ics = item.raw ? itemToEditedICS(item) : itemToNewICS(item);
        const r = await putItem(item, ics, this.channel(), this.auth());
        item.etag = r.etag;
        item.dirty = false;
        item.raw = item.raw || ics; // 新建后保留原文
        report.uploaded++;
      } catch (e: any) {
        if (e?.status === 412) {
          if (this.store.settings.conflict === "local") {
            // 本地优先：强制覆盖（去掉 If-Match）
            const keep = item.etag;
            item.etag = undefined;
            try {
              const ics = itemToEditedICS(item);
              const r = await putItem(item, ics, this.channel(), this.auth());
              item.etag = r.etag || keep;
              item.dirty = false;
              report.uploaded++;
              continue;
            } catch (e2: any) {
              report.errors.push(`覆盖 ${item.summary}: ${explainError(e2)}`);
            }
          } else {
            // 服务端优先：丢弃本地改动
            item.dirty = false;
            report.errors.push(`「${item.summary}」服务端已变更，本地改动已按策略丢弃`);
          }
        } else {
          report.ok = false;
          report.errors.push(`上传 ${item.summary}: ${explainError(e)}`);
        }
      }
    }
    // 删除
    for (const item of this.store.deletedItems()) {
      try {
        await deleteItem(item, this.channel(), this.auth());
        report.deleted++;
        // 删除成功后从本地移除，否则每次同步都会重复发 DELETE
        this.store.remove(keyOf(item));
      } catch (e: any) {
        report.ok = false;
        report.errors.push(`删除 ${item.summary}: ${explainError(e)}`);
      }
    }
  }

  /** 新建条目（先入本地并标记脏，立即上传） */
  async createItem(item: CalItem): Promise<void> {
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.pushAndPersist();
  }

  /** 更新条目 */
  async updateItem(item: CalItem): Promise<void> {
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.pushAndPersist();
  }

  /** 删除条目：标记后同步删除 */
  async removeItem(item: CalItem): Promise<void> {
    item.deleted = true;
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.pushAndPersist();
  }

  private async pushAndPersist(): Promise<void> {
    const report: SyncReport = { ok: true, fetched: 0, uploaded: 0, deleted: 0, errors: [], elapsedMs: 0 };
    await this.pushDirty(report);
    this.store.lastError = report.errors.length ? report.errors.join("; ") : this.store.lastError;
    await this.store.persist();
    this.store.notify();
  }
}

export function rangeWindowFor(store: CalStore): { startMs: number; endMs: number } {
  return {
    startMs: Date.now() - store.settings.pastDays * 86400000,
    endMs: Date.now() + store.settings.futureDays * 86400000
  };
}

export { dateStampOfMs };
