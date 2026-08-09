export interface ParsedArguments {
  command: string;
  subcommand?: string;
  flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["confirm", "publish"]);

export function parseArguments(arguments_: string[]): ParsedArguments {
  const [command = "", ...remaining] = arguments_;
  const rest = [...remaining];
  const subcommand = rest[0] && !rest[0].startsWith("--")
    ? rest.shift()
    : undefined;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag?.startsWith("--") || flag.length === 2) {
      throw new Error(`Expected --flag value near ${flag ?? "end of command"}.`);
    }
    const name = flag.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(name)) {
        throw new Error(`Expected --flag value near ${flag}.`);
      }
      flags.set(name, "true");
      continue;
    }
    flags.set(name, value);
    index += 1;
  }
  return { command, ...(subcommand ? { subcommand } : {}), flags };
}

export function booleanFlag(flags: Map<string, string>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`--${name} must be true or false.`);
}
