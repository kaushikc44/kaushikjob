import type { Exec } from "./exec";
import type { Paths } from "./paths";
import type { SystemInfo } from "./system";

export interface Prompter {
  /** Returns the chosen option, or null if the user gave none. */
  choose(question: string, options: string[]): Promise<string | null>;
}

export interface Ctx {
  paths: Paths;
  exec: Exec;
  info: SystemInfo;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  out: (line: string) => void;
  prompt?: Prompter;
}
