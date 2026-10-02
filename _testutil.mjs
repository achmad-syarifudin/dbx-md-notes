import fs from "node:fs";
import { spawn } from "node:child_process";

export function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let error = null;
    let timedOut = false;
    const timer = options.timeoutMs && setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (e) => { error = e; });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) error = new Error(`Process timed out after ${options.timeoutMs}ms`);
      resolve({ code, signal, out, err, error });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
