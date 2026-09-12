// 前台启动本地 Radicale（供端到端测试）：node scripts/radicale.mjs
// 用户: testuser / testpass
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = path.join(process.cwd(), ".e2e-radicale");
const py = process.env.E2E_PYTHON || "python";

fs.mkdirSync(path.join(dir, "collections"), { recursive: true });
fs.writeFileSync(path.join(dir, "users"), "testuser:testpass\n");
fs.writeFileSync(
  path.join(dir, "config"),
  `
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = ${path.join(dir, "users").replace(/\\/g, "/")}
htpasswd_encryption = plain

[rights]
type = owner_only

[storage]
type = multifilesystem
filesystem_folder = ${path.join(dir, "collections").replace(/\\/g, "/")}
`.trim() + "\n"
);

const r = spawnSync(py, ["-c", "import importlib.metadata as m;print(m.version("radicale"))"], { encoding: "utf8" });
if (r.status !== 0) {
  console.error("[radicale] 未安装 radicale，请先: pip install radicale");
  process.exit(1);
}
console.log("[radicale] version", r.stdout.trim(), "http://127.0.0.1:5232/  (testuser/testpass)");

const { spawn } = await import("node:child_process");
const child = spawn(py, ["-m", "radicale", "--config", path.join(dir, "config")], { stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
