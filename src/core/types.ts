/** 条目种类 */
export type CalKind = "event" | "todo";

/** 排序方式（Dock 排序菜单 + 月/周视图条目排序共用） */
export type SortMode = "start" | "end" | "priority" | "completed" | "created" | "category" | "title";

/** 本地墙上时间：时间型 "YYYY-MM-DDTHH:mm:ss"，全天 "YYYY-MM-DD" */
export type LocalStamp = string;

export interface Recurrence {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay?: string[]; // ["MO", "TU", ...]（WEEKLY/MONTHLY 生效）
  byMonthDay?: number[]; // MONTHLY 生效
  count?: number;
  until?: LocalStamp;
}

export interface Alarm {
  minutesBefore: number; // 提前分钟数
}

/** 本地缓存的一条日历条目（事件或待办） */
export interface CalItem {
  uid: string;
  kind: CalKind;
  calendarUrl: string;
  /** 服务器资源地址（.ics），PUT/DELETE 用 */
  href: string;
  etag?: string;
  summary: string;
  description?: string;
  location?: string;
  categories?: string[];
  allDay: boolean;
  /** 开始（本地墙上时间） */
  start: LocalStamp;
  /** 结束（本地墙上时间；待办为 due，可为空） */
  end?: LocalStamp;
  /** RRULE 描述；不存在则无重复 */
  rrule?: Recurrence;
  /** RECURRENCE-ID：覆盖实例的基准开始时间 */
  recurId?: LocalStamp;
  exdates?: LocalStamp[];
  alarms?: Alarm[];
  /** 待办：0 无 9 低 5 中 3 高 1 紧急 */
  priority?: number;
  /** 待办状态：needs-action / in-process / completed */
  status?: string;
  /** 待办完成度 0-100 */
  percent?: number;
  completedAt?: LocalStamp;
  /** 创建时间（本地墙上时间；解析 ICS CREATED 或本地新建时写入） */
  createdAt?: LocalStamp;
  /** 本地脏标记：待上传 */
  dirty?: boolean;
  /** 本地删除标记：同步时执行服务端删除 */
  deleted?: boolean;
  /** 服务端 ICS 原文，编辑时在其基础上修改 */
  raw?: string;
}

export interface CalCalendar {
  url: string;
  displayName: string;
  color: string;
  enabled: boolean;
  /** 支持 VTODO */
  supportsTodo?: boolean;
  /** 支持 VEVENT */
  supportsEvent?: boolean;
  /** sync-collection 支持的 sync-token，空则回退全量 */
  syncToken?: string;
  /** 描述（如 Nextcloud 共享说明） */
  description?: string;
}

/** 任务分类定义（编辑弹窗的彩色药丸） */
export interface CategoryDef {
  id: string;
  name: string;
  /** 药丸底色（HEX） */
  color: string;
  /** 图标（emoji 或单字符） */
  icon: string;
}

export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: "work", name: "工作", color: "#e05a4c", icon: "🎯" },
  { id: "study", name: "学习", color: "#3d82d6", icon: "📖" },
  { id: "life", name: "生活", color: "#43a05c", icon: "🍀" }
];

export interface CalSettings {
  serverUrl: string;
  username: string;
  password: string;
  /** 可选，直接指定日历集合或主目录；空则自动发现 */
  calendarPath: string;
  /** auto：内核代理优先、失败回退直连 */
  channel: "auto" | "proxy" | "direct";
  /** 自动同步间隔（分钟），0 关闭 */
  syncIntervalMin: number;
  /** 启用提醒通知（托盘运行时，对设置了提醒时间的日程/待办到点弹系统通知） */
  enableReminders?: boolean;
  /** 服务端冲突时：server 服务端优先 / local 本地优先 */
  conflict: "server" | "local";
  /** 显示范围：过去 N 天 / 未来 N 天 */
  pastDays: number;
  futureDays: number;
  calendars: CalCalendar[];
  defaultCalendarUrl?: string;
  /**
   * 日历视图（年/月/周/日）是否显示待办任务，默认 true。
   * 关掉后日历视图只显示日程事件 —— 待办仍可在「任务视图」与 Dock 列表中看到与勾选，
   * 所以这是一个纯展示开关，不影响数据与同步。
   */
  showTodosInCalendar?: boolean;
  /** 任务分类（编辑弹窗药丸选择），空数组时回退 DEFAULT_CATEGORIES */
  categories?: CategoryDef[];
  /** 分类是否允许多选 */
  categoryMulti?: boolean;
}

export const DEFAULT_SETTINGS: CalSettings = {
  serverUrl: "",
  username: "",
  password: "",
  calendarPath: "",
  channel: "auto",
  syncIntervalMin: 15,
  enableReminders: false,
  conflict: "server",
  pastDays: 90,
  futureDays: 370,
  calendars: [],
  showTodosInCalendar: true,
  categories: DEFAULT_CATEGORIES,
  categoryMulti: false
};

export interface SyncState {
  lastSync?: string;
  lastError?: string;
}

export interface PersistData {
  settings: CalSettings;
  items: CalItem[];
  sync: SyncState;
  /**
   * 凭据加密的主密钥（base64）。**故意与密文放在同一份数据里**：
   * 这份数据会被思源云同步带到别的设备，密钥同行才能保证「换设备/多端」都解得开。
   * 详见 core/secret.ts 里对 v2（设备绑定密钥）被淘汰的原因说明。
   */
  keyring?: string;
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
