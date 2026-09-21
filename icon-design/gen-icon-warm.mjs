/**
 * 生成插件图标设计稿（512×512 PNG）—— 暖色浅底版
 * 结构沿用 gen-icon.mjs（calCheck 描边日历 + refreshThin 同步箭头 + 绿勾徽章），
 * 只替换配色：浅暖渐变底 + 深暖描边 + 琥珀橙同步箭头 + 绿色勾徽章（完成语义）。
 */
import sharp from "sharp";
import fs from "fs";
import path from "path";

const OUT = "D:/Develop/WorkBuddy/SiYuan/icon-design";
fs.mkdirSync(OUT, { recursive: true });

const REFRESH = `<path d="M20 12a8 8 0 0 0-14.1-5.1L4.5 9.5"/><polyline points="4 4.5 4.5 9.5 9.5 8.5"/><path d="M4 12a8 8 0 0 0 14.1 5.1L19.5 14.5"/><polyline points="20 19.5 19.5 14.5 14.5 15.5"/>`;

const PALETTES = {
  // 奶油：最浅最柔，接近思源浅色主题
  cream: { a: "#FFF8EE", b: "#FFE7C8", line: "#8A5A2E", accent: "#EF8A34", ring: "#FFF8EE" },
  // 杏仁：略深一点，暖而不甜
  almond: { a: "#FDF1E0", b: "#F6DCBC", line: "#6E4A33", accent: "#D9722F", ring: "#FDF1E0" },
  // 蜜桃：粉橙调，更活泼
  peach: { a: "#FFF3E8", b: "#FFD6B4", line: "#A8542A", accent: "#F26B2A", ring: "#FFF3E8" }
};

const GREEN = "#2EBC5B";

function defs(p) {
  return `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.85" y2="1">
    <stop offset="0" stop-color="${p.a}"/><stop offset="1" stop-color="${p.b}"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.26" cy="0.16" r="0.85">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
</defs>`;
}
const bg = `<rect x="0" y="0" width="512" height="512" rx="110" fill="url(#bg)"/><rect x="0" y="0" width="512" height="512" rx="110" fill="url(#glow)"/>`;

function outlineCalendar(color) {
  return `<g fill="none" stroke="${color}" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
    <rect x="92" y="120" width="328" height="310" rx="54"/>
    <line x1="92" y1="212" x2="420" y2="212"/>
    <line x1="170" y1="86" x2="170" y2="156"/>
    <line x1="342" y1="86" x2="342" y2="156"/>
  </g>`;
}
function refreshArrows(cx, cy, size, sw, color) {
  const s = size / 19.6, t = 12 * s;
  return `<g transform="translate(${cx - t},${cy - t}) scale(${s})" fill="none" stroke="${color}" stroke-width="${(sw / s).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">${REFRESH}</g>`;
}
function badge(cx, cy, r, ring, inner) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${GREEN}" stroke="${ring}" stroke-width="13"/>${inner}`;
}
const checkIn = (cx, cy, r) => {
  const k = r / 86;
  return `<polyline points="${cx - 40 * k},${cy + 4 * k} ${cx - 11 * k},${cy + 33 * k} ${cx + 45 * k},${cy - 31 * k}" fill="none" stroke="#ffffff" stroke-width="${26 * k}" stroke-linecap="round" stroke-linejoin="round"/>`;
};

// 方案 A：描边日历 + 体内 CalDAV 同步箭头 + 绿色勾徽章
const A = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs(p)}${bg}
${outlineCalendar(p.line)}
${refreshArrows(256, 322, 148, 18, p.accent)}
${badge(380, 380, 86, p.ring, checkIn(380, 380, 86))}
</svg>`;

// 方案 B：描边日历 + 体内对勾（入口图标同款） + 绿色 CalDAV 同步徽章
const B = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs(p)}${bg}
${outlineCalendar(p.line)}
<polyline points="198 318 246 366 330 262" fill="none" stroke="${p.line}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
${badge(380, 380, 86, p.ring, refreshArrows(380, 380, 90, 20, "#ffffff"))}
</svg>`;

// 方案 C：白底日历卡片 + 琥珀色同步箭头 + 绿色勾徽章
const C = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs(p)}${bg}
<line x1="176" y1="90" x2="176" y2="152" stroke="${p.line}" stroke-width="22" stroke-linecap="round"/>
<line x1="336" y1="90" x2="336" y2="152" stroke="${p.line}" stroke-width="22" stroke-linecap="round"/>
<rect x="96" y="124" width="320" height="306" rx="52" fill="#FFFFFF" stroke="#E8CFAE" stroke-width="6"/>
<line x1="122" y1="208" x2="390" y2="208" stroke="#F0D9B6" stroke-width="13" stroke-linecap="round"/>
${refreshArrows(256, 322, 150, 26, p.accent)}
${badge(384, 384, 84, p.ring, checkIn(384, 384, 84))}
</svg>`;

const jobs = [
  ["icon-warmA-cream", A(PALETTES.cream)],
  ["icon-warmB-cream", B(PALETTES.cream)],
  ["icon-warmC-cream", C(PALETTES.cream)],
  ["icon-warmA-almond", A(PALETTES.almond)],
  ["icon-warmA-peach", A(PALETTES.peach)]
];
for (const [name, svg] of jobs) {
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, `${name}.png`));
  await sharp(Buffer.from(svg)).resize(64, 64).png().toFile(path.join(OUT, `${name}-64.png`));
  await sharp(Buffer.from(svg)).resize(32, 32).png().toFile(path.join(OUT, `${name}-32.png`));
  console.log("done", name);
}
