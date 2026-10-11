/** Process execution behind an interface so tests never touch the real system. */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be started (e.g. not installed) or timed out. */
  error?: "not_found" | "timeout" | "failed";
}
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string; inherit?: boolean }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: ExecResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    } catch {
      return done({ code: null, stdout, stderr, error: "failed" });
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          done({ code: null, stdout, stderr, error: "timeout" });
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      done({ code: null, stdout, stderr, error: e.code === "ENOENT" ? "not_found" : "failed" });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
