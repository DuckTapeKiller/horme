import { Platform, requestUrl } from "obsidian";
import { asArray, getRecordProp, getStringProp } from "../utils/TypeGuards";

/** Apple's Foundation Models command-line tool, installed with macOS 27. */
const FM = "/usr/bin/fm";

/** What Apple Intelligence needs, said wherever it is not ready. */
export const APPLE_REQUIREMENTS =
  "Apple Intelligence needs a Mac with Apple silicon and macOS 27 or later, with Apple Intelligence turned on in System Settings (Apple Intelligence & Siri).";

/** The one command that accepts Apple's terms for its model tool, for every user of the Mac. */
export const APPLE_TERMS_COMMAND = "sudo fm license";

export const APPLE_TERMS_NEEDED = `Apple's terms for its model tool are not accepted yet. Open Terminal, run ${APPLE_TERMS_COMMAND}, read the terms and agree (it asks for your Mac password), then come back.`;

/**
 * Whether `fm license --status` (or any fm command) says the terms are
 * accepted: "Agreed to license FM1 …" when they are; before that, fm answers
 * every command with "YOU HAVE NOT AGREED TO THE FOUNDATION MODELS CLI LEGAL
 * NOTICE & TERMS".
 */
export function fmTermsAccepted(output: string): boolean {
  if (/have not agreed/i.test(output)) return false;
  return /agreed to license/i.test(output);
}

/** A model the server offers, and why it cannot be used when it cannot. */
export interface AppleModelStatus {
  name: string;
  available: boolean;
  reason: string;
}

interface ChildProcessLike {
  kill(signal?: string): boolean;
  once(event: "exit", listener: () => void): void;
}
type Spawn = (command: string, args: string[], options: { stdio: string }) => ChildProcessLike;
type ExecFile = (
  command: string,
  args: string[],
  options: { timeout: number },
  callback: (error: unknown, stdout: string, stderr: string) => void,
) => void;

function nodeModule<T>(name: string): T | null {
  const w = window as unknown as { require?: (id: string) => unknown };
  try {
    return typeof w.require === "function" ? (w.require(name) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Apple's Foundation Models on this Mac, through Apple's own `fm serve`: a
 * local server that speaks OpenAI's chat completions API. Horme starts it the
 * first time it is needed, on a port of its own on 127.0.0.1, starts it again
 * if it stops, and stops it when the plugin unloads. A computer only, and
 * only where macOS has the tool (macOS 27 and later).
 */
export class AppleModelServer {
  private child: ChildProcessLike | null = null;
  private port = 0;
  private starting: Promise<string> | null = null;

  /** Why Apple Intelligence could not be used the last time it was tried, in plain words; "" when it worked. */
  problem = "";

  /** True in Obsidian on a Mac, where Apple Intelligence may be offered (and explained when not ready). */
  static onMac(): boolean {
    return Platform.isDesktopApp && Platform.isMacOS;
  }

  /** True where Apple's tool is installed: a Mac with macOS 27 or later. */
  static installed(): boolean {
    if (!AppleModelServer.onMac()) return false;
    return nodeModule<{ existsSync(path: string): boolean }>("fs")?.existsSync(FM) === true;
  }

  /** Whether Apple's terms for its model tool have been accepted on this Mac. */
  termsAccepted(): Promise<boolean> {
    const execFile = nodeModule<{ execFile: ExecFile }>("child_process")?.execFile;
    if (!execFile) return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile(FM, ["license", "--status"], { timeout: 10000 }, (_error, stdout, stderr) =>
        resolve(fmTermsAccepted(`${stdout}\n${stderr}`)),
      );
    });
  }

  private get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The server's base address (…/v1), starting the server first if it is not running. */
  async baseUrl(): Promise<string> {
    if (this.child && (await this.healthy())) return `${this.origin}/v1`;
    this.starting ??= this.start()
      .then((url) => {
        this.problem = "";
        return url;
      })
      .catch((e: unknown) => {
        this.problem = e instanceof Error ? e.message : String(e);
        throw e;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** The models the server offers, each with whether it can be used here and why not. */
  async status(): Promise<AppleModelStatus[]> {
    await this.baseUrl();
    const res = await requestUrl({ url: `${this.origin}/health`, throw: false });
    return (asArray(getRecordProp(res.json as unknown, "models")) ?? []).map((m) => ({
      name: getStringProp(m, "name") ?? "",
      available: getRecordProp(m, "available") === true,
      reason: getStringProp(m, "reason") ?? "",
    }));
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await requestUrl({ url: `${this.origin}/health`, throw: false });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private async start(): Promise<string> {
    if (!AppleModelServer.installed()) throw new Error(APPLE_REQUIREMENTS);
    if (!(await this.termsAccepted())) throw new Error(APPLE_TERMS_NEEDED);
    const spawn = nodeModule<{ spawn: Spawn }>("child_process")?.spawn;
    if (!spawn) throw new Error("Apple Intelligence can only start on a computer.");
    this.stop();
    // A port of its own, so it never meets another server; tried twice in case one is taken.
    for (let attempt = 0; attempt < 2; attempt++) {
      this.port = 49152 + Math.floor(Math.random() * 16000);
      const child = spawn(FM, ["serve", "--host", "127.0.0.1", "--port", String(this.port)], {
        stdio: "ignore",
      });
      this.child = child;
      let exited = false;
      child.once("exit", () => {
        exited = true;
        if (this.child === child) this.child = null;
      });
      for (let waited = 0; waited < 15000 && !exited; waited += 200) {
        if (await this.healthy()) return `${this.origin}/v1`;
        await new Promise<void>((r) => window.setTimeout(r, 200));
      }
      child.kill();
    }
    throw new Error(`Apple's model server (fm serve) did not start. ${APPLE_REQUIREMENTS}`);
  }
}
