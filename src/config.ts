import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSafe } from "./backends/lock.js";
import { AxiError } from "./errors.js";

/**
 * Backend + path resolution (report §8 config selection).
 *
 * Override order:
 *   --backend / --file flag > TASKS_AXI_* env > project .tasks.toml >
 *   ~/.tasks-axi/config.toml > defaults (markdown, first existing
 *   backlog.md/data/backlog.md, otherwise backlog.md).
 *
 * Backends: markdown (default) and beads (drives the `bd` CLI). The Store seam
 * keeps sqlite/remote additions invisible to the CLI layer.
 */

export interface ResolvedConfig {
  backend: string;
  /** Markdown backlog path (resolved to an absolute path). */
  path: string;
  /** Which override named the markdown path, when one did (--file or env). */
  fileSource?: "--file" | "TASKS_AXI_FILE";
  /** Optional archive path for pruned tasks (resolved to an absolute path). */
  archivePath?: string;
  doneKeep: number;
  /** The `[beads]` table, used only when the beads backend is selected. */
  beads: BeadsConfig;
}

export interface BeadsConfig {
  /** The bd executable (default `bd`); a path is resolved against its TOML dir. */
  binary: string;
  /**
   * The Beads workspace (`.beads` directory) handed to bd as BEADS_DIR, resolved
   * against the directory holding the TOML that named it. Unset lets bd
   * discover the workspace itself.
   */
  path?: string;
  /** Issue id prefix the workspace expects; ids must start with `<prefix>-`. */
  prefix?: string;
}

export interface ConfigOverrides {
  backend?: string;
  file?: string;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

interface TomlConfig {
  backend?: string;
  markdown?: {
    path?: string;
    archive?: string;
    done_keep?: number;
  };
  beads?: {
    binary?: string;
    path?: string;
    prefix?: string;
  };
}

const DEFAULT_KEEP = 10;
const PATH_CANDIDATES = ["backlog.md", "data/backlog.md"];
type ConfigTable = "root" | "markdown" | "beads" | "unsupported";
const TABLES: Record<string, ConfigTable> = {
  markdown: "markdown",
  beads: "beads",
};

/**
 * Minimal TOML reader for the tiny config surface we need: a top-level
 * `backend` key, a `[markdown]` table with `path` / `archive` / `done_keep`,
 * and a `[beads]` table with `binary` / `path` / `prefix`.
 * `archive` points at the file that receives pruned tasks.
 * Intentionally not a general TOML parser.
 */
export function parseConfigToml(src: string): TomlConfig {
  const config: TomlConfig = {};
  let table: ConfigTable = "root";

  for (const rawLine of src.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      table = TABLES[section[1].trim()] ?? "unsupported";
      continue;
    }

    if (table === "unsupported") continue;

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!kv) {
      throw new AxiError(
        "Invalid config line: expected `key = value`",
        "VALIDATION_ERROR",
        ["Use `key = value` assignments in .tasks.toml"],
      );
    }
    const key = kv[1];
    const source = configKeySource(table, key);
    if (!source) continue;
    const value = parseTomlValue(kv[2], source);

    if (table === "root") {
      config.backend = requireTomlString(value, source);
      continue;
    }
    if (table === "beads") {
      config.beads ??= {};
      config.beads[key as "binary" | "path" | "prefix"] = requireTomlString(
        value,
        source,
      );
      continue;
    }
    config.markdown ??= {};
    if (key === "path") config.markdown.path = requireTomlString(value, source);
    if (key === "archive")
      config.markdown.archive = requireTomlString(value, source);
    if (key === "done_keep") {
      if (typeof value !== "number") {
        throw new AxiError(
          "markdown.done_keep must be an integer",
          "VALIDATION_ERROR",
          ["Set `[markdown] done_keep = 10` in .tasks.toml"],
        );
      }
      config.markdown.done_keep = value;
    }
  }

  return config;
}

function stripTomlComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function configKeySource(
  table: ConfigTable,
  key: string,
): string | undefined {
  if (table === "root" && key === "backend") return "backend";
  if (
    table === "markdown" &&
    (key === "path" || key === "archive" || key === "done_keep")
  ) {
    return `markdown.${key}`;
  }
  if (
    table === "beads" &&
    (key === "binary" || key === "path" || key === "prefix")
  ) {
    return `beads.${key}`;
  }
  return undefined;
}

function parseTomlValue(raw: string, source: string): string | number {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    if (!trimmed.endsWith(quote) || trimmed.length === 1) {
      throw new AxiError(
        `${source} has an unterminated quoted value`,
        "VALIDATION_ERROR",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  throw new AxiError(`${source} has an invalid value`, "VALIDATION_ERROR");
}

function requireTomlString(value: string | number, source: string): string {
  if (typeof value === "string") return value;
  throw new AxiError(`${source} must be a quoted string`, "VALIDATION_ERROR");
}

function loadToml(path: string): TomlConfig {
  const src = readFileSafe(path);
  return src ? parseConfigToml(src) : {};
}

function resolveMarkdownPath(
  explicit: string | undefined,
  tomlPath: string | undefined,
  cwd: string,
): string {
  const chosen = explicit ?? tomlPath;
  if (chosen) return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);

  for (const candidate of PATH_CANDIDATES) {
    const full = resolve(cwd, candidate);
    if (existsSync(full)) return full;
  }
  return resolve(cwd, PATH_CANDIDATES[0]);
}

function validatePathValue(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new AxiError(`${source} must not be empty`, "VALIDATION_ERROR", [
      "Set it to a backlog path or remove the empty override",
    ]);
  }
  return value;
}

function validateDoneKeep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AxiError(
      "markdown.done_keep must be a non-negative integer",
      "VALIDATION_ERROR",
      ["Set `[markdown] done_keep = 10` in .tasks.toml"],
    );
  }
  return value;
}

const BEADS_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Resolve the `[beads]` table key by key (project over user-level). A relative
 * `path` or `binary` path resolves against the directory holding the TOML that
 * named it - the backlog root for the project `.tasks.toml` - never the
 * process CWD of some other directory.
 */
function resolveBeadsConfig(
  projectToml: TomlConfig,
  projectDir: string,
  homeToml: TomlConfig,
  homeDir: string,
): BeadsConfig {
  const pick = (key: "binary" | "path" | "prefix") => {
    const project = projectToml.beads?.[key];
    if (project !== undefined) {
      return {
        value: validatePathValue(project, `beads.${key}`),
        dir: projectDir,
      };
    }
    const user = homeToml.beads?.[key];
    if (user !== undefined) {
      return { value: validatePathValue(user, `beads.${key}`), dir: homeDir };
    }
    return undefined;
  };
  const beads: BeadsConfig = { binary: "bd" };
  const binary = pick("binary");
  if (binary?.value) {
    beads.binary =
      /[\\/]/.test(binary.value) && !isAbsolute(binary.value)
        ? resolve(binary.dir, binary.value)
        : binary.value;
  }
  const path = pick("path");
  if (path?.value) {
    beads.path = isAbsolute(path.value)
      ? path.value
      : resolve(path.dir, path.value);
  }
  const prefix = pick("prefix")?.value?.trim();
  if (prefix !== undefined) {
    const bare = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;
    if (!BEADS_PREFIX_RE.test(bare)) {
      throw new AxiError(
        "beads.prefix must be a slug like `fm`",
        "VALIDATION_ERROR",
        ['Set `[beads] prefix = "fm"` in .tasks.toml'],
      );
    }
    beads.prefix = bare;
  }
  return beads;
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? process.cwd();
  const home = overrides.home ?? homedir();

  const homeDir = join(home, ".tasks-axi");
  const homeToml = loadToml(join(homeDir, "config.toml"));
  const projectToml = loadToml(resolve(cwd, ".tasks.toml"));

  const explicitPath =
    overrides.file !== undefined
      ? validatePathValue(overrides.file, "--file")
      : env.TASKS_AXI_FILE !== undefined
        ? validatePathValue(env.TASKS_AXI_FILE, "TASKS_AXI_FILE")
        : undefined;
  const tomlPath =
    explicitPath !== undefined
      ? undefined
      : projectToml.markdown?.path !== undefined
        ? validatePathValue(projectToml.markdown.path, "markdown.path")
        : validatePathValue(homeToml.markdown?.path, "markdown.path");

  const backend =
    overrides.backend ??
    env.TASKS_AXI_BACKEND ??
    projectToml.backend ??
    homeToml.backend ??
    "markdown";

  const path = resolveMarkdownPath(explicitPath, tomlPath, cwd);

  const archive =
    projectToml.markdown?.archive !== undefined
      ? validatePathValue(projectToml.markdown.archive, "markdown.archive")
      : validatePathValue(homeToml.markdown?.archive, "markdown.archive");
  const doneKeep = validateDoneKeep(
    projectToml.markdown?.done_keep ??
      homeToml.markdown?.done_keep ??
      DEFAULT_KEEP,
  );

  const config: ResolvedConfig = {
    backend,
    path,
    doneKeep,
    beads:
      backend === "beads"
        ? resolveBeadsConfig(projectToml, cwd, homeToml, homeDir)
        : { binary: "bd" },
  };
  if (overrides.file !== undefined) {
    config.fileSource = "--file";
  } else if (env.TASKS_AXI_FILE !== undefined) {
    config.fileSource = "TASKS_AXI_FILE";
  }
  if (archive) {
    config.archivePath = isAbsolute(archive) ? archive : resolve(cwd, archive);
  }
  return config;
}
