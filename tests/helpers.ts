// Shared SQLite driver fixtures and the content mapper run over its JSON-RPC protocol.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = join(import.meta.dirname, "..");
export const DRIVERS = join(ROOT, "lab", "drivers", "node_modules");
export const MAPPER = join(ROOT, "src", "mapper.ts");
export const INDEX = pathToFileURL(join(ROOT, "src", "index.ts")).href;

/** A driver as `lab/drivers` installs it. */
export function driver(name: string): any {
  const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
  return createRequire(join(DRIVERS, pkg, "package.json"))(name);
}

/** Closes every session the tests opened, so that the next analysis connects afresh. */
export async function closeSessions(): Promise<void> {
  const { Session } = await import("../src/analyze.ts");
  for (const session of Session.opened()) await session.close();
}

/** Rows as plain objects, to compare with literals. */
export const plain = (rows: readonly object[]) => [...rows].map((r) => ({ ...r }));

/** A diagnostic the content mapper reports. */
export type Diagnostic = { messageText: string; start: number; length: number; code: number };

/** The declaration the content mapper writes for each file of `files` (name to content), which it must write with no diagnostic. */
export async function declarations(root: string, files: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, { text, diagnostics }] of Object.entries(await transform(root, files))) {
    if (diagnostics.length) throw new Error(`${name}: ${JSON.stringify(diagnostics)}`);
    out[name] = text;
  }
  return out;
}

/** What the content mapper answers for each file of `files` (name to content) in the project at `root`, through its own JSON-RPC process, as the type check runs it: the declaration and its diagnostics. */
export async function transform(root: string, files: Record<string, string>): Promise<Record<string, { text: string; diagnostics: Diagnostic[] }>> {
  const child = spawn(process.execPath, [MAPPER], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (result: unknown) => void>();
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))![1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      pending.get(message.id)?.(message.error ? Promise.reject(new Error(message.error.message)) : message.result);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    });
  try {
    await call("initialize", { protocolVersion: 1 });
    await call("openProject", { projectHandle: "p", configFileName: join(root, "tsconfig.json"), options: {} });
    const out: Record<string, { text: string; diagnostics: Diagnostic[] }> = {};
    for (const [name, content] of Object.entries(files)) {
      const result = await call("transform", { fileName: join(root, name), content, projectHandle: "p" });
      out[name] = { text: result.text, diagnostics: result.diagnostics };
    }
    await call("closeProject", { projectHandle: "p" });
    return out;
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

/** TypeScript's language server for the project at `root`, over stdio with LSP framing, as an editor talks to it. */
export function languageServer(root: string) {
  const child = spawn(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--lsp", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (result: any) => void>();
  let buffer = Buffer.alloc(0);
  const write = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))![1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.subarray(end + 4 + length);
      // A request from the server (registerCapability, workspace/configuration) is answered as a client that has nothing to add.
      if (message.method && message.id !== undefined) write({ id: message.id, result: message.method === "workspace/configuration" ? message.params.items.map(() => null) : null });
      else if (message.id !== undefined) pending.get(message.id)?.(message.result);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      pending.set(++id, resolve);
      write({ id, method, params });
    });
  const notify = (method: string, params: unknown) => write({ method, params });
  const close = async () => {
    await request("shutdown", undefined);
    notify("exit", undefined);
    await new Promise((resolve) => child.once("exit", resolve));
  };
  return { request, notify, close };
}
