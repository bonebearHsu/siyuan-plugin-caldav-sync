/**
 * 死导出扫描：列出 src 下所有 .ts 文件的 export 符号，统计它们在
 * src/ + test/ + scripts/ 里的引用次数（排除声明行自身）。
 * 仅输出报告，不做任何删除 —— 是否删除由人工判断。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const scanDirs = ["src", "test", "scripts"];
const files = [];
for (const dir of scanDirs) {
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) {
        if (n === "node_modules" || n.startsWith(".test") || n === "backup") continue;
        walk(p);
      } else if (/\.(ts|mjs|js)$/.test(n)) files.push(p);
    }
  };
  walk(dir);
}
const allText = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

const declRe = /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm;

const report = [];
for (const [f, text] of allText) {
  if (!f.startsWith("src")) continue;
  let m;
  declRe.lastIndex = 0;
  while ((m = declRe.exec(text))) {
    const name = m[1];
    let uses = 0;
    const where = [];
    const useRe = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g");
    for (const [f2, t2] of allText) {
      let count = 0;
      let um;
      useRe.lastIndex = 0;
      while ((um = useRe.exec(t2))) {
        // 排除本文件声明行：粗略处理 —— 本文件里出现次数减 1（声明 1 次）
        count++;
      }
      if (count > 0) {
        if (f2 === f) count -= 1; // 声明自身算一次
        if (count > 0) {
          uses += count;
          where.push(`${f2}(${count})`);
        }
      }
    }
    if (uses === 0) report.push({ name, file: f });
  }
}
console.log("=== 零引用导出（在 src/test/scripts 范围内） ===");
if (!report.length) console.log("(无)");
for (const r of report) console.log(`${r.name}  <-  ${r.file}`);

// 附加：default export 与文件级引用检查 —— 每个文件是否被 import 过
console.log("\n=== 从未被 import 的 src 文件 ===");
for (const f of files.filter((x) => x.startsWith("src") && x.endsWith(".ts"))) {
  const base = path.basename(f, ".ts");
  const rel = f.replace(/\\/g, "/");
  let imported = false;
  for (const [f2, t2] of allText) {
    if (f2 === f) continue;
    if (new RegExp(`["'./\\w-]${base}["']`).test(t2)) { imported = true; break; }
  }
  if (!imported) console.log(rel);
}
