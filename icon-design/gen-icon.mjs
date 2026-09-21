/**
 * 生成插件图标设计稿（512×512 PNG）
 * 设计语言对齐 src/ui/icons.ts：
 *  - 入口图标 calCheck：描边日历（rx 圆角 + 横梁 + 双环扣）
 *  - CalDAV 元素：refreshThin 的双弧+双箭头循环同步符号
 *  - 任务勾选：绿色圆徽章 + 白色对勾（延续现版识别度）
 */
import sharp from "sharp";
import fs from "fs";
import path from "path";

const OUT = "D:/Develop/WorkBuddy/SiYuan/icon-design";
fs.mkdirSync(OUT, { recursive: true });

// refreshThin 几何（viewBox 2.2 2.2 19.6 19.6，中心 12,12）
const REFRESH = `<path d="M20 12a8 8 0 0 0-14.1-5.1L4.5 9.5"/><polyline points="4 4.5 4.5 9.5 9.5 8.5"/><path d="M4 12a8 8 0 0 0 14.1 5.1L19.5 14.5"/><polyline points="20 19.5 19.5 14.5 14.5 15.5"/>`;

const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4E8CFF"/><stop offset="1" stop-color="#7B57F7"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.28" cy="0.18" r="0.9">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
</defs>`;

const bg = `<rect x="0" y="0" width="512" height="512" rx="110" fill="url(#bg)"/>
<rect x="0" y="0" width="512" height="512" rx="110" fill="url(#glow)"/>`;

// 描边日历（呼应入口图标 calCheck）
function outlineCalendar() {
  return `<g fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
    <rect x="92" y="120" width="328" height="310" rx="54"/>
    <line x1="92" y1="212" x2="420" y2="212"/>
    <line x1="170" y1="86" x2="170" y2="156"/>
    <line x1="342" y1="86" x2="342" y2="156"/>
  </g>`;
}

// refreshThin 以 size 大小、sw 描边、居中放在 (cx,cy)
function refreshArrows(cx, cy, size, sw, color) {
  const s = size / 19.6;
  const t = 12 * s;
  return `<g transform="translate(${cx - t},${cy - t}) scale(${s})" fill="none" stroke="${color}" stroke-width="${(sw / s).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">${REFRESH}</g>`;
}

function badge(cx, cy, r, inner) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#2EBC5B" stroke="#ffffff" stroke-width="14"/>${inner}`;
}
const checkIn = (cx, cy, r) => {
  const k = r / 86;
  return `<polyline points="${cx - 40 * k},${cy + 4 * k} ${cx - 11 * k},${cy + 33 * k} ${cx + 45 * k},${cy - 31 * k}" fill="none" stroke="#ffffff" stroke-width="${26 * k}" stroke-linecap="round" stroke-linejoin="round"/>`;
};

// ── 方案 A：描边日历 + 体内 CalDAV 同步箭头 + 绿色勾徽章（推荐） ──
const svgA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}${bg}
${outlineCalendar()}
${refreshArrows(256, 322, 148, 18, "#ffffff")}
${badge(380, 380, 86, checkIn(380, 380, 86))}
</svg>`;

// ── 方案 B：描边日历 + 体内对勾（入口图标同款） + 绿色 CalDAV 同步徽章 ──
const svgB = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}${bg}
${outlineCalendar()}
<polyline points="198 318 246 366 330 262" fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
${badge(380, 380, 86, refreshArrows(380, 380, 90, 20, "#ffffff"))}
</svg>`;

// ── 方案 C：延续现版（白色实底日历），格点换成 CalDAV 同步箭头 + 绿色勾徽章 ──
const svgC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}${bg}
<line x1="176" y1="90" x2="176" y2="152" stroke="#ffffff" stroke-width="22" stroke-linecap="round"/>
<line x1="336" y1="90" x2="336" y2="152" stroke="#ffffff" stroke-width="22" stroke-linecap="round"/>
<rect x="96" y="124" width="320" height="306" rx="52" fill="#ffffff"/>
<line x1="122" y1="208" x2="390" y2="208" stroke="#6C7BFF" stroke-width="13" stroke-linecap="round"/>
${refreshArrows(256, 322, 150, 26, "#5B7CFA")}
${badge(384, 384, 84, checkIn(384, 384, 84))}
</svg>`;

for (const [name, svg] of [["icon-A", svgA], ["icon-B", svgB], ["icon-C", svgC]]) {
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, `${name}.png`));
  await sharp(Buffer.from(svg)).resize(64, 64).png().toFile(path.join(OUT, `${name}-64.png`));
  await sharp(Buffer.from(svg)).resize(32, 32).png().toFile(path.join(OUT, `${name}-32.png`));
  console.log("done", name);
}
