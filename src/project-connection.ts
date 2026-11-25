import { isEmptyArray, matchesUndefined, nonemptyText } from "./native-predicates.ts";
import { commandOutput } from "./project-command.ts";
import { hostEnvironment, readEnvFile } from "./project-files.ts";
import { inUserinfo, urlParts } from "./project-url-template.ts";
import type { UrlPart } from "./project-url-template.ts";

const DEFAULT_VARIABLE = "DATABASE_URL";
const FIRST_COLUMN = 1;
const VARIABLE = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu;

export interface ConnectionContext {
  env: Record<string, string | undefined>;
  envFiles: string[];
  error: string | undefined;
  label: string;
  root: string;
  shown: (path: string) => string;
}

interface Connection {
  error?: string | undefined;
  refreshUrl?: () => string | undefined;
  url?: string | undefined;
  urlSource: string;
}

interface VariableValue {
  source: string;
  value: string;
}

// The process environment wins. Among dotenv files, the first file that sets a variable wins.
const lookup = (name: string, context: ConnectionContext): VariableValue | undefined => {
  const { env, envFiles, shown } = context;
  if (!matchesUndefined(env[name])) {return { source: `${name} in the environment`, value: env[name] };}
  return Iterator.from(envFiles).map((path) => {
    const value = readEnvFile(path)[name];
    return matchesUndefined(value) ? undefined : { source: `${name} in ${shown(path)}`, value };
  }).find((hit) => !matchesUndefined(hit));
};

interface TextParts {
  missing: string[];
  sources: string[];
  texts: (string | undefined)[];
}

// Expand text variables here. Shell variables are resolved inside the command with the same precedence.
const expandText = (parts: UrlPart[], context: ConnectionContext): TextParts => {
  const missing: string[] = [];
  const sources: string[] = [];
  const expand = (_match: string, name: string): string => {
    const hit = lookup(name, context);
    if (matchesUndefined(hit)) {missing.push(name);}
    else {sources.push(hit.source);}
    return hit?.value ?? "";
  };
  const texts = parts.map((part) => "text" in part ? part.text.replaceAll(VARIABLE, expand) : undefined);
  return { missing, sources, texts };
};

const commandEnvironment = (context: ConnectionContext): Record<string, string> => {
  const shellEnv: Record<string, string> = {};
  Iterator.from(context.envFiles.toReversed()).forEach((path) => {Object.assign(shellEnv, readEnvFile(path));});
  Object.entries({ ...hostEnvironment(), ...context.env }).forEach(([name, value]) => {
    if (!matchesUndefined(value)) {shellEnv[name] = value;}
  });
  return shellEnv;
};

interface CommandContext {
  cwd: string;
  env: Record<string, string>;
}

interface BuildContext {
  encoded: Set<UrlPart>;
  invocation: CommandContext;
  label: string;
  parts: UrlPart[];
  texts: (string | undefined)[];
}

const commandText = (
  part: Extract<UrlPart, { command: string }>,
  context: BuildContext,
  fresh: boolean,
): { text: string } | { error: string } => {
  const out = commandOutput(part.command, context.invocation, fresh);
  if ("error" in out) {return { error: `${context.label}: "direct_url" runs \`${part.command}\`, ${out.error}.` };}
  return { text: context.encoded.has(part) ? encodeURIComponent(out.value) : out.value };
};

const buildConnection = (context: BuildContext, fresh: boolean): { url: string } | { error: string } => {
  const chunks: string[] = [];
  const { parts, texts } = context;
  // oxlint-disable-next-line rules/no-for-loops -- Commands run synchronously in URL order and must stop at the first failure.
  for (const [index, part] of parts.entries()) {
    const output = "text" in part ? { text: String(texts[index]) } : commandText(part, context, fresh);
    if ("error" in output) {return output;}
    chunks.push(output.text);
  }
  return { url: chunks.join("") };
};

interface ExpandedCommands {
  parts: UrlPart[];
  texts: (string | undefined)[];
  urlSource: string;
}

const commandConnection = (parts: ExpandedCommands, context: ConnectionContext): Connection => {
  const { urlSource } = parts;
  const invocation = { cwd: context.root, env: commandEnvironment(context) };
  const build = { encoded: inUserinfo(parts.parts), invocation, label: context.label, parts: parts.parts, texts: parts.texts };
  // A project that already has an error never prompts for a password or runs a command.
  if (!matchesUndefined(nonemptyText(context.error))) {return { error: context.error, urlSource };}
  const refreshUrl = (): string | undefined => {
    const again = buildConnection(build, true);
    return "url" in again ? again.url : undefined;
  };
  const first = buildConnection(build, false);
  return { error: context.error, refreshUrl, ...first, urlSource };
};

const missingVariables = (missing: string[], context: ConnectionContext): string => {
  const names = missing.map((name) => `\${${name}}`).join(", ");
  const files = context.envFiles.map((path) => context.shown(path)).join(" nor ");
  return `${context.label}: "direct_url" names ${names}, which neither the environment nor ${files} sets.`;
};

const expandedConnection = (parts: UrlPart[], source: string, context: ConnectionContext): Connection => {
  const { missing, sources, texts } = expandText(parts, context);
  const urlSource = [source, ...sources].join(", ");
  if (!isEmptyArray(missing)) {
    return { error: context.error ?? missingVariables(missing, context), urlSource };
  }
  if (parts.some((part) => "command" in part)) {return commandConnection({ parts, texts, urlSource }, context);}
  return { error: context.error, url: texts.join(""), urlSource };
};

const directConnection = (written: string, context: ConnectionContext): Connection => {
  const parts = urlParts(written);
  const source = `"direct_url" in ${context.label}`;
  if ("open" in parts) {
    return { error: context.error ?? `${context.label}: "direct_url" opens $( at column ${parts.open + FIRST_COLUMN} and never closes it.`, urlSource: source };
  }
  return expandedConnection(parts, source, context);
};

export const resolveConnection = (written: string | undefined, context: ConnectionContext): Connection => {
  if (!matchesUndefined(written)) {return directConnection(written, context);}
  const hit = lookup(DEFAULT_VARIABLE, context);
  return { error: context.error, url: hit?.value, urlSource: hit?.source ?? DEFAULT_VARIABLE };
};
