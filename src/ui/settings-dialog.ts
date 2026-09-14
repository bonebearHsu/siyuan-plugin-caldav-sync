/**
 * 设置面板：服务器参数 / 测试连接 / 发现日历 / 同步策略
 */
import { Dialog } from "siyuan";
import type { CalCalendar } from "../core/types";
import { testConnection, discoverCalendars } from "../core/caldav";
import type { PanelCtx } from "./panel";
import { escape } from "./view-common";
import { enableDialogResize } from "./dialog-resize";
import { icons } from "./icons";

export function openSettingsDialog(ctx: PanelCtx): Promise<void> {
  return new Promise((resolve) => {
    const s = ctx.store.settings;
    const dialog = new Dialog({
      title: "CalDAV 同步设置",
      content: `<div class="caldav-settings">${settingsHtml(s)}</div>`,
      width: "640px",
      height: "86vh"
    });
    const el = dialog.element.querySelector(".caldav-settings") as HTMLElement;
    enableDialogResize(dialog);
    const $ = (sel: string) => el.querySelector(sel) as HTMLInputElement;
    const msgEl = el.querySelector("[data-msg]") as HTMLElement;
    renderCalChecks(el, s.calendars);
    if (ctx.store.secretBroken) {
      msgEl.textContent = "本地密钥已丢失，原密码无法解密，请重新输入密码后保存";
      msgEl.classList.add("is-err");
    }

    // 通道切换提示
    $("select[data-s='channel']").addEventListener("change", () => {
      /* 仅保存时生效 */
    });

    el.querySelector("[data-action='test']")?.addEventListener("click", () => {
      const server = $("input[data-s='server']").value.trim();
      const username = $("input[data-s='username']").value.trim();
      const password = $("input[data-s='password']").value;
      const channel = $("select[data-s='channel']").value as any;
      if (!server) {
        msgEl.textContent = "服务器地址不能为空";
        msgEl.classList.remove("is-ok");
        msgEl.classList.add("is-err");
        return;
      }
      msgEl.textContent = "正在测试连接…";
      msgEl.classList.remove("is-ok", "is-err");
      void testConnection(server, channel, { username, password }).then((r) => {
        msgEl.textContent = r.message;
        msgEl.classList.toggle("is-ok", r.ok);
        msgEl.classList.toggle("is-err", !r.ok);
      });
    });

    el.querySelector("[data-action='discover']")?.addEventListener("click", async () => {
      const server = $("input[data-s='server']").value.trim();
      const username = $("input[data-s='username']").value.trim();
      const password = $("input[data-s='password']").value;
      const channel = $("select[data-s='channel']").value as any;
      const path = $("input[data-s='path']").value.trim();
      msgEl.textContent = "正在发现日历…";
      msgEl.classList.remove("is-ok", "is-err");
      try {
        const r = await discoverCalendars(server, channel, { username, password }, path);
        const existing = new Map(s.calendars.map((c) => [c.url, c]));
        s.calendars = r.calendars.map(
          (c) =>
            existing.get(c.url) || { ...c, enabled: true }
        );
        renderCalChecks(el, s.calendars);
        msgEl.textContent = `发现 ${r.calendars.length} 个日历，请勾选后保存`;
        msgEl.classList.add("is-ok");
      } catch (e: any) {
        msgEl.textContent = "发现失败: " + (e?.message || e);
        msgEl.classList.add("is-err");
      }
    });

    el.querySelector("[data-action='save']")?.addEventListener("click", async () => {
      s.serverUrl = $("input[data-s='server']").value.trim();
      s.username = $("input[data-s='username']").value.trim();
      s.password = $("input[data-s='password']").value;
      s.calendarPath = $("input[data-s='path']").value.trim();
      s.channel = $("select[data-s='channel']").value as any;
      s.syncIntervalMin = Math.max(0, +$("input[data-s='interval']").value || 0);
      s.conflict = $("select[data-s='conflict']").value as any;
      s.pastDays = Math.max(7, +$("input[data-s='past']").value || 90);
      s.futureDays = Math.max(30, +$("input[data-s='future']").value || 370);
      // 勾选的日历
      el.querySelectorAll<HTMLElement>(".caldav-set-cal").forEach((row) => {
        const c = s.calendars[+row.dataset.idx!];
        c.enabled = (row.querySelector("input[type='checkbox']") as HTMLInputElement).checked;
        const colorInput = row.querySelector("input[type='color']") as HTMLInputElement;
        if (colorInput.value) c.color = colorInput.value;
        const nameInput = row.querySelector("input[data-role='name']") as HTMLInputElement;
        if (nameInput.value.trim()) c.displayName = nameInput.value.trim();
      });
      s.defaultCalendarUrl = s.calendars.find((c) => c.enabled)?.url;
      await ctx.store.persist();
      ctx.sync.startAutoSync();
      dialog.destroy();
      resolve();
    });
    el.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
      dialog.destroy();
      resolve();
    });
  });
}

function settingsHtml(s: PanelCtx["store"]["settings"]): string {
  return `
<div class="caldav-settings-form">
  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.server}</span>服务器</div>
    <div class="caldav-field">
      <label class="caldav-field-label">服务器地址</label>
      <input class="caldav-input" data-s="server" placeholder="http://192.168.1.10:5232/ 或 https://dav.example.com/" value="${escape(s.serverUrl)}"/>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">用户名</label>
        <input class="caldav-input" data-s="username" value="${escape(s.username)}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">密码</label>
        <input class="caldav-input" type="password" data-s="password" value="${escape(s.password)}"/>
      </div>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">日历路径（可选，留空自动发现）</label>
        <input class="caldav-input" data-s="path" placeholder="如 http://host:5232/user/personal/" value="${escape(s.calendarPath)}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">请求通道</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="channel">
            <option value="auto" ${s.channel === "auto" ? "selected" : ""}>自动（内核代理优先）</option>
            <option value="proxy" ${s.channel === "proxy" ? "selected" : ""}>仅思源内核代理</option>
            <option value="direct" ${s.channel === "direct" ? "selected" : ""}>仅浏览器直连</option>
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
    </div>
    <div class="caldav-actions-row">
      <button class="caldav-foot-btn caldav-foot-btn--ghost" data-action="test">${icons.check} 测试连接</button>
      <button class="caldav-foot-btn caldav-foot-btn--primary" data-action="discover">${icons.calendar} 发现日历</button>
      <span class="caldav-set-msg" data-msg></span>
    </div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.calendar}</span>日历</div>
    <div class="caldav-set-cals" data-cals></div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.sync}</span>同步</div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">自动同步间隔（分钟，0 关闭）</label>
        <input class="caldav-input" type="number" min="0" data-s="interval" value="${s.syncIntervalMin}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">冲突策略</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="conflict">
            <option value="server" ${s.conflict === "server" ? "selected" : ""}>服务端优先</option>
            <option value="local" ${s.conflict === "local" ? "selected" : ""}>本地优先</option>
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">同步过去（天）</label>
        <input class="caldav-input" type="number" min="7" data-s="past" value="${s.pastDays}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">同步未来（天）</label>
        <input class="caldav-input" type="number" min="30" data-s="future" value="${s.futureDays}"/>
      </div>
    </div>
  </div>
</div>

<div class="caldav-editor-foot">
  <span class="caldav-set-hint">密码保存在本机插件数据中，请勿在公共环境使用</span>
  <span class="caldav-flex"></span>
  <button class="caldav-foot-btn caldav-foot-btn--ghost" data-action="cancel">${icons.close} 取消</button>
  <button class="caldav-foot-btn caldav-foot-btn--primary" data-action="save">${icons.check} 保存</button>
</div>`;
}

function renderCalChecks(el: HTMLElement, cals: CalCalendar[]): void {
  const box = el.querySelector("[data-cals]") as HTMLElement;
  if (!cals.length) {
    box.innerHTML = `<div class="caldav-set-hint">尚未发现日历，请先填写服务器信息并点击「发现日历」</div>`;
    return;
  }
  box.innerHTML = cals
    .map(
      (c, i) => `
    <div class="caldav-set-cal" data-idx="${i}">
      <input type="checkbox" ${c.enabled ? "checked" : ""}/>
      <input type="color" value="${escape(c.color)}" title="颜色"/>
      <input class="caldav-input" data-role="name" value="${escape(c.displayName)}" title="${escape(c.url)}"/>
      <span class="caldav-set-cal-tags">${c.supportsTodo ? "<i>任务</i>" : ""}${c.supportsEvent ? "<i>日程</i>" : ""}</span>
    </div>`
    )
    .join("");
}
