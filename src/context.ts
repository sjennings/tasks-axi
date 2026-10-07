import { BeadsStore } from "./backends/beads.js";
import { MarkdownStore } from "./backends/markdown.js";
import {
  type ConfigOverrides,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { AxiError } from "./errors.js";
import type { Store } from "./store.js";
import type { SuggestionGlobals } from "./suggestions.js";

/**
 * The resolved CLI context: the active backend Store plus the config that
 * selected it. The command layer only ever talks to `Store`, so the markdown
 * and beads backends (and later sqlite/remote ones) never touch arg parsing
 * or rendering.
 */
export interface TasksContext {
  store: Store;
  config: ResolvedConfig;
  suggestionGlobals?: SuggestionGlobals;
}

export function resolveTasksContext(
  overrides: ConfigOverrides = {},
  suggestionGlobals?: SuggestionGlobals,
): TasksContext {
  const config = resolveConfig(overrides);
  const store = createStore(config, overrides.cwd);
  return {
    store,
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

function createStore(config: ResolvedConfig, cwd: string | undefined): Store {
  if (config.backend === "markdown") {
    return new MarkdownStore({
      path: config.path,
      ...(config.archivePath ? { archivePath: config.archivePath } : {}),
    });
  }
  if (config.backend === "beads") {
    // --file names a markdown backlog; on Beads it would silently address the
    // wrong store, so refuse it. TASKS_AXI_FILE is a markdown-only default and
    // is ignored here, letting one environment serve homes on either backend.
    if (config.fileSource === "--file") {
      throw new AxiError(
        "--file addresses a markdown backlog; the beads backend uses `[beads] path`",
        "VALIDATION_ERROR",
        [
          "Drop --file, or pass `--backend markdown` to address a markdown file",
        ],
      );
    }
    return new BeadsStore({
      binary: config.beads.binary,
      ...(config.beads.path !== undefined ? { path: config.beads.path } : {}),
      ...(config.beads.prefix !== undefined
        ? { prefix: config.beads.prefix }
        : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    });
  }
  throw new AxiError(
    `Unsupported backend "${config.backend}" - expected markdown or beads`,
    "UNSUPPORTED",
    ['Set `backend = "markdown"` or `backend = "beads"` in .tasks.toml'],
  );
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
