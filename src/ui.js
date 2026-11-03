import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 端口是否已有服务在监听 */
function portInUse() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/** 找到监听端口的进程，并确认它确实是本项目的 server.js */
function currentServer() {
  const pid = Number(
    powershell(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ),
  );
  if (!pid) return null;
  const commandLine = powershell(
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
  );
  return { pid, commandLine };
}

/** 已有本项目在运行时先关掉，端口被其他程序占用则直接报错 */
async function stopRunningServer() {
  if (process.platform !== 'win32' || !(await portInUse())) return;

  const running = currentServer();
  if (!running) throw new Error(`端口 ${port} 已被占用，但无法识别占用进程，请手动关闭后重试。`);
  if (!/server\.js/.test(running.commandLine)) {
    throw new Error(`端口 ${port} 被其他程序占用（PID ${running.pid}）：${running.commandLine}`);
  }

  try {
    execFileSync('taskkill', ['/PID', String(running.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // 进程可能已经退出
  }
  for (let i = 0; i < 50 && (await portInUse()); i += 1) await delay(100);
  if (await portInUse()) throw new Error(`端口 ${port} 仍被占用，重启失败。`);
}

async function main() {
  await stopRunningServer();

  // 始终在当前窗口前台启动，Ctrl+C 即可停止
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
