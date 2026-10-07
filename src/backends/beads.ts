import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { AxiError, unsupported } from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import { PUBLIC_FOLLOWUP_KIND } from "../public-followup.js";
import type { Capabilities, Store } from "../store.js";
import {
  type BdIssue,
  type TasksAxiMeta,
  bdDepType,
  closeReason,
  holdActiveOn,
  isBuiltInStatus,
  issueToTask,
  mergeMetadata,
  nativeStatus,
  parseStatusCategories,
  readTasksAxiMeta,
  sameJson,
  stateForStatus,
} from "./beads-mapping.js";
import {
  addBodyLine,
  bodyHasLine,
  normalizeDate,
  normalizeDep,
  normalizeHold,
  normalizePriority,
  normalizeTagValue,
  normalizeTitle,
  normalizeTypedLink,
  sameHold,
  sameMeta,
  today,
} from "./normalize.js";

/** Captured result of one bd invocation. */
export interface BdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one bd invocation; injectable so tests can script bd. */
export type BdRunner = (args: string[], input?: string) => Promise<BdResult>;

export interface BeadsStoreOptions {
  /** bd executable (default `bd`). */
  binary?: string;
  /** Beads workspace (`.beads` dir) passed to bd as BEADS_DIR. */
  path?: string;
  /** Expected issue-id prefix; ids must start with `<prefix>-`. */
  prefix?: string;
  /** Working directory used when no workspace path is configured. */
  cwd?: string;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
  /** Injectable bd runner (for tests). */
  runner?: BdRunner;
}

const BD_TIMEOUT_MS = 120_000;
const READ_VERBS = new Set(["list", "statuses"]);
const DEFAULT_PRIORITY = 2;
const NOISE_LINE_RE = /^(warning: beads\.role|\s+(Fix|Or):|Hint:)/;

/**
 * The Beads backend: a Store that drives the installed `bd` CLI and reads only
 * its `--json` output. Every mutation is one bd write (plus, where Beads has
 * no single verb for it, one follow-up write that a retry repairs), so bd's
 * own per-command transaction is the unit of atomicity.
 *
 * Holds, kinds, repos, typed links, dependency reasons, and stamps live under
 * `metadata.tasks_axi` (see beads-mapping.ts); state, priority, body, and
 * dependency edges use the native fields. An active hold on queued work is
 * mirrored as native `deferred` (with `defer_until` for hold-until) so
 * `bd ready` hides it too.
 *
 * The CLI builds one store per invocation, so reads share one `bd list`
 * snapshot until this store writes; a write made by another process after
 * that snapshot is seen by the next invocation, as with any read-then-write.
 */
export class BeadsStore implements Store {
  private readonly binary: string;
  private readonly path: string | undefined;
  private readonly prefix: string | undefined;
  private readonly now: () => string;
  private readonly runner: BdRunner;
  private categories: Map<string, string> | undefined;
  /** The last full `bd list`, reused by reads until the next bd write. */
  private snapshot: BdIssue[] | undefined;

  constructor(options: BeadsStoreOptions = {}) {
    this.binary = options.binary ?? "bd";
    this.path = options.path;
    this.prefix = options.prefix;
    this.now = options.now ?? today;
    this.runner =
      options.runner ??
      spawnRunner(this.binary, this.path, options.cwd ?? process.cwd());
  }

  capabilities(): Capabilities {
    return {
      backend: "beads",
      deps: true,
      prune: false,
      comments: true,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: true,
      serverMintsIds: false,
      publicFollowups: false,
    };
  }

  // -------------------------------------------------------------------------
  // bd plumbing
  // -------------------------------------------------------------------------

  private async bd(args: string[], input?: string): Promise<string> {
    if (this.path !== undefined && !existsSync(this.path)) {
      throw new AxiError(
        `Beads workspace ${this.path} does not exist`,
        "VALIDATION_ERROR",
        [
          "Run `bd init` in the graph repo, or fix `[beads] path` in .tasks.toml",
        ],
      );
    }
    // Any write - even a refused one - may have changed the graph.
    if (!READ_VERBS.has(args[0])) this.snapshot = undefined;
    const result = await this.runner(args, input);
    if (result.code !== 0) throw bdError(args[0], result);
    return result.stdout;
  }

  private async bdJson(args: string[]): Promise<unknown> {
    const stdout = await this.bd([...args, "--json"]);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new AxiError(
        `bd ${args[0]} returned output that is not JSON`,
        "UNKNOWN",
        ["Check that the configured bd binary is a Beads CLI with --json"],
      );
    }
  }

  /**
   * Every issue, read once per process and reused until the next bd write.
   * Lookups filter this list by exact id, never through `bd show`, which
   * resolves a partial id to whichever issue it prefixes.
   */
  private async issues(ids?: string[]): Promise<BdIssue[]> {
    if (this.snapshot === undefined) {
      const payload = await this.bdJson([
        "list",
        "--all",
        "--flat",
        "--limit",
        "0",
      ]);
      if (!Array.isArray(payload)) {
        throw new AxiError("bd list did not return a JSON array", "UNKNOWN");
      }
      this.snapshot = payload as BdIssue[];
    }
    const issues = this.snapshot;
    return ids ? issues.filter((issue) => ids.includes(issue.id)) : issues;
  }

  private async stateOf(issue: BdIssue): Promise<State> {
    if (!isBuiltInStatus(issue.status) && this.categories === undefined) {
      this.categories = parseStatusCategories(await this.bdJson(["statuses"]));
    }
    return stateForStatus(issue.status, this.categories) ?? "queued";
  }

  private async toTask(issue: BdIssue): Promise<Task> {
    return issueToTask(issue, await this.stateOf(issue));
  }

  private async issue(id: string): Promise<BdIssue | undefined> {
    const [issue] = await this.issues([id]);
    return issue;
  }

  private async requireIssue(id: string): Promise<BdIssue> {
    const issue = await this.issue(id);
    if (!issue) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return issue;
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.get(id);
    if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return task;
  }

  private requirePrefix(id: string): void {
    if (this.prefix === undefined || id.startsWith(`${this.prefix}-`)) return;
    throw new AxiError(
      `Task id "${id}" does not use the configured Beads prefix "${this.prefix}-"`,
      "VALIDATION_ERROR",
      [
        `Use an id like \`${this.prefix}-${id}\`, or pass \`--mint --prefix ${this.prefix}\``,
      ],
    );
  }

  private async requireExistingDeps(deps: Dep[]): Promise<void> {
    if (deps.length === 0) return;
    const found = new Set(
      (await this.issues(deps.map((dep) => dep.id))).map((issue) => issue.id),
    );
    for (const dep of deps) {
      if (found.has(dep.id)) continue;
      const label = dep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(`${label} "${dep.id}" not found`, "VALIDATION_ERROR", [
        "Create the dependency task first, or choose an existing task id",
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async get(id: string): Promise<Task | null> {
    const issue = await this.issue(id);
    return issue ? this.toTask(issue) : null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    const issues = [...(await this.issues())].sort(
      (a, b) =>
        (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
        a.id.localeCompare(b.id),
    );
    let items: Task[] = [];
    for (const issue of issues) items.push(await this.toTask(issue));
    if (query.state) items = items.filter((t) => t.state === query.state);
    if (query.repo) items = items.filter((t) => t.repo === query.repo);
    if (query.kind) items = items.filter((t) => t.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0) {
      items = items.slice(0, query.limit);
    }
    return { items, total };
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async create(input: TaskInput): Promise<Task> {
    if (input.kind === PUBLIC_FOLLOWUP_KIND || input.public_followup) {
      throw unsupported("public-followup", "beads");
    }
    const id = validateId(input.id);
    this.requirePrefix(id);
    const state: State = input.state ?? "queued";
    const title = normalizeTitle(input.title);
    const kind = normalizeTagValue(input.kind, "kind");
    const repo = normalizeTagValue(input.repo, "repo");
    const hold = normalizeHold(input.hold);
    const priority = normalizePriority(input.priority);
    const deps = (input.deps ?? []).map((dep) => normalizeDep(id, dep));
    const links = (input.links ?? []).map(normalizeTypedLink);

    if (await this.issue(id)) {
      throw new AxiError(`Task "${id}" already exists`, "CONFLICT");
    }
    await this.requireExistingDeps(deps);

    const ta: TasksAxiMeta = {};
    if (kind) ta.kind = kind;
    if (repo) ta.repo = repo;
    if (hold) ta.hold = hold;
    if (links.length > 0) ta.links = links;
    const reasons = depReasons(deps);
    if (reasons) ta.dep_reasons = reasons;
    if (priority === undefined) ta.default_priority = true;
    if (typeof input.created === "string") {
      ta.created = normalizeDate(input.created, "created date");
    }
    if (input.closed !== undefined) {
      ta.closed = normalizeDate(input.closed, "closed date");
    }
    if (input.meta) ta.meta = input.meta;

    const args = [
      "create",
      `--id=${id}`,
      `--title=${title}`,
      "--type=task",
      `--priority=${priority ?? DEFAULT_PRIORITY}`,
    ];
    if (input.body) args.push(`--description=${input.body}`);
    if (deps.length > 0) {
      // In `bd create --deps`, `blocks:<id>` points the other way (<id>
      // depends on this issue), so a blocked-by edge uses bd's `blocked-by:`.
      const spec = (dep: Dep) =>
        `${dep.type === "blocked-by" ? "blocked-by" : bdDepType(dep.type)}:${dep.id}`;
      args.push(`--deps=${deps.map(spec).join(",")}`);
    }
    const metadata = mergeMetadata(undefined, ta);
    if (Object.keys(metadata).length > 0) {
      args.push(`--metadata=${JSON.stringify(metadata)}`);
    }
    if (state !== "done") {
      args.push(`--status=${nativeStatus(state, hold, this.now())}`);
      if (state === "queued" && hold?.until && holdActiveOn(hold, this.now())) {
        args.push(`--defer=${hold.until}`);
      }
    }
    const pr = links.find((link) => link.kind === "pr");
    if (pr) args.push(`--external-ref=${pr.url}`);

    await this.bdJson(args);
    if (state === "done") {
      await this.close(id, closeReason(evidenceOf(links)));
    }
    return this.requireTask(id);
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    const issue = await this.requireIssue(id);
    const task = await this.toTask(issue);
    if (
      patch.kind !== undefined &&
      patch.kind.trim() === PUBLIC_FOLLOWUP_KIND
    ) {
      throw unsupported("public-followup", "beads");
    }

    const ta = readTasksAxiMeta(issue.metadata);
    const args: string[] = [];
    const changed: TaskUpdateChange[] = [];
    const markChanged = (field: TaskUpdateChange) => {
      if (!changed.includes(field)) changed.push(field);
    };

    if (patch.title !== undefined) {
      const title = normalizeTitle(patch.title);
      if (task.title !== title) {
        args.push(`--title=${title}`);
        markChanged("title");
      }
    }

    let body = task.body;
    if (patch.body !== undefined) body = patch.body || undefined;
    for (const line of patch.addBodyLines ?? []) {
      if (line !== "" && !bodyHasLine(body, line))
        body = addBodyLine(body, line);
    }
    const supersededBody =
      patch.archiveBody && patch.body !== undefined && body !== task.body
        ? task.body
        : undefined;
    if (body !== task.body) {
      args.push(`--description=${body ?? ""}`);
      markChanged("body");
    }

    if (patch.repo !== undefined) {
      const repo = normalizeTagValue(patch.repo, "repo");
      if (task.repo !== repo) {
        ta.repo = repo;
        markChanged("repo");
      }
    }
    if (patch.kind !== undefined) {
      const kind = normalizeTagValue(patch.kind, "kind");
      if (task.kind !== kind) {
        ta.kind = kind;
        markChanged("kind");
      }
    }
    if (patch.priority !== undefined) {
      const priority = normalizePriority(patch.priority);
      if (task.priority !== priority) {
        args.push(`--priority=${priority}`);
        delete ta.default_priority;
        markChanged("priority");
      }
    }
    if (patch.meta) {
      const meta = { ...task.meta, ...patch.meta };
      if (!sameMeta(task.meta, meta)) {
        ta.meta = meta;
        markChanged("meta");
      }
    }
    for (const link of patch.addLinks ?? []) {
      const checked = normalizeTypedLink(link);
      if (task.links.some((existing) => existing.url === checked.url)) continue;
      ta.links = [...(ta.links ?? []), checked];
      if (checked.kind === "pr" && !issue.external_ref) {
        args.push(`--external-ref=${checked.url}`);
      }
      markChanged("links");
    }
    if (patch.hold !== undefined) {
      const hold = normalizeHold(patch.hold ?? undefined);
      if (!sameHold(task.hold, hold)) {
        ta.hold = hold;
        args.push(...this.holdMirrorArgs(issue, task.state, hold));
        markChanged("hold");
      }
    }

    if (changed.length === 0) return { task, changed };

    const metadata = mergeMetadata(issue.metadata, ta);
    if (!sameJson(metadata, issue.metadata ?? {})) {
      args.push(`--metadata=${JSON.stringify(metadata)}`);
    }
    if (supersededBody !== undefined) {
      // Archive first: a failed update then leaves a harmless extra comment,
      // never a replaced body with no archived copy.
      await this.archiveBody(id, supersededBody);
      markChanged("archive");
    }
    await this.bdJson(["update", id, ...args]);
    return { task: await this.requireTask(id), changed };
  }

  async remove(id: string): Promise<Task> {
    const task = await this.requireTask(id);
    const dependents = (await this.list({})).items
      .filter(
        (other) =>
          other.state !== "done" &&
          other.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
      )
      .map((other) => other.id);
    if (dependents.length > 0) {
      throw new AxiError(
        `Task "${id}" is still blocking active tasks: ${dependents.join(", ")}`,
        "VALIDATION_ERROR",
        [
          `Unblock them first, e.g. \`tasks-axi unblock ${dependents[0]} --by ${id}\``,
        ],
      );
    }
    await this.bdJson(["delete", id, "--force"]);
    return task;
  }

  // -------------------------------------------------------------------------
  // State + dependencies
  // -------------------------------------------------------------------------

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    const issue = await this.requireIssue(id);
    const task = await this.toTask(issue);
    const date = normalizeDate(opts.date ?? this.now(), "transition date");
    const ta = readTasksAxiMeta(issue.metadata);
    const args: string[] = [];

    const added: TaskLink[] = [];
    if (opts.pr !== undefined) added.push({ kind: "pr", url: opts.pr });
    if (opts.report !== undefined) {
      added.push({ kind: "report", url: opts.report });
    }
    for (const link of added.map(normalizeTypedLink)) {
      if (task.links.some((existing) => existing.url === link.url)) continue;
      ta.links = [...(ta.links ?? []), link];
      if (link.kind === "pr" && !issue.external_ref) {
        args.push(`--external-ref=${link.url}`);
      }
    }
    if (opts.note) {
      args.push(`--description=${addBodyLine(task.body, opts.note)}`);
    }

    if (to === "done") {
      ta.closed = date;
      if (task.state !== "done") {
        // Close first: a refusal (e.g. a live blocker) then changes nothing,
        // and a failed evidence write below is backfilled by re-running done.
        await this.close(
          id,
          closeReason({
            ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
            ...(opts.report !== undefined ? { report: opts.report } : {}),
          }),
        );
      }
    } else {
      delete ta.closed;
      args.push(`--status=${nativeStatus(to, task.hold, this.now())}`);
      if (issue.defer_until && to === "in_flight") args.push("--defer=");
      if (to === "queued") args.push(...this.deferArgs(issue, task.hold));
    }

    const metadata = mergeMetadata(issue.metadata, ta);
    if (!sameJson(metadata, issue.metadata ?? {})) {
      args.push(`--metadata=${JSON.stringify(metadata)}`);
    }
    if (args.length > 0) await this.bdJson(["update", id, ...args]);
    return this.requireTask(id);
  }

  async updatePublicFollowup(): Promise<Task> {
    throw unsupported("public-followup", "beads");
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checked = normalizeDep(id, dep);
    const issue = await this.requireIssue(id);
    const task = await this.toTask(issue);
    if (task.deps.some((d) => d.type === checked.type && d.id === checked.id)) {
      return false;
    }
    await this.requireExistingDeps([checked]);
    if (checked.reason !== undefined) {
      const ta = readTasksAxiMeta(issue.metadata);
      ta.dep_reasons = { ...ta.dep_reasons, [checked.id]: checked.reason };
      await this.bdJson([
        "update",
        id,
        `--metadata=${JSON.stringify(mergeMetadata(issue.metadata, ta))}`,
      ]);
    }
    await this.bdJson([
      "dep",
      "add",
      id,
      checked.id,
      `--type=${bdDepType(checked.type)}`,
    ]);
    return true;
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const target = validateDependencyId(dep.id);
    const issue = await this.requireIssue(id);
    const task = await this.toTask(issue);
    if (!task.deps.some((d) => d.type === dep.type && d.id === target)) {
      return false;
    }
    await this.bdJson(["dep", "remove", id, target]);
    const ta = readTasksAxiMeta(issue.metadata);
    if (ta.dep_reasons?.[target] !== undefined) {
      delete ta.dep_reasons[target];
      await this.bdJson([
        "update",
        id,
        `--metadata=${JSON.stringify(mergeMetadata(issue.metadata, ta))}`,
      ]);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async close(id: string, reason: string | undefined): Promise<void> {
    const args = ["close", id];
    if (reason) args.push(`--reason=${reason}`);
    await this.bdJson(args);
  }

  /** Preserve a superseded body as a bd comment (Beads' append-only history). */
  private async archiveBody(id: string, body: string): Promise<void> {
    await this.bd(
      ["comment", id, "--stdin"],
      `tasks-axi archived the previous body on ${this.now()}:\n\n${body}`,
    );
  }

  /** Native `defer_until` args that mirror a queued task's hold-until date. */
  private deferArgs(issue: BdIssue, hold: Task["hold"]): string[] {
    if (hold?.until && holdActiveOn(hold, this.now())) {
      return [`--defer=${hold.until}`];
    }
    return issue.defer_until ? ["--defer="] : [];
  }

  /**
   * On queued work an active hold is mirrored as native `deferred` so
   * `bd ready` hides it; started and closed work keep their status.
   */
  private holdMirrorArgs(
    issue: BdIssue,
    state: State,
    hold: Task["hold"],
  ): string[] {
    if (state !== "queued") return [];
    const args: string[] = [];
    const status = nativeStatus(state, hold, this.now());
    const nativeHeld = issue.status === "deferred";
    if ((status === "deferred") !== nativeHeld) args.push(`--status=${status}`);
    args.push(...this.deferArgs(issue, hold));
    return args;
  }
}

function depReasons(deps: Dep[]): Record<string, string> | undefined {
  const reasons: Record<string, string> = {};
  for (const dep of deps) {
    if (dep.type === "blocked-by" && dep.reason) reasons[dep.id] = dep.reason;
  }
  return Object.keys(reasons).length > 0 ? reasons : undefined;
}

function evidenceOf(links: TaskLink[]): { pr?: string; report?: string } {
  const evidence: { pr?: string; report?: string } = {};
  const pr = links.find((link) => link.kind === "pr");
  const report = links.find((link) => link.kind === "report");
  if (pr) evidence.pr = pr.url;
  if (report) evidence.report = report.url;
  return evidence;
}

/**
 * Spawn bd with BEADS_DIR pointed at the configured workspace. bd also reads
 * git context from its working directory, so it runs from the graph's repo
 * (the workspace's parent) rather than the caller's directory. The caller's
 * environment passes through, so BEADS_ACTOR and per-call bd overrides such as
 * BD_DUE_REQUIRED reach bd unchanged.
 */
export function spawnRunner(
  binary: string,
  path: string | undefined,
  cwd: string,
): BdRunner {
  return (args, input) =>
    new Promise((resolvePromise, reject) => {
      const env = { ...process.env };
      if (path !== undefined) env.BEADS_DIR = path;
      const child = spawn(binary, args, {
        cwd: path !== undefined ? dirname(path) : cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: BD_TIMEOUT_MS,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new AxiError(
                `Beads binary "${binary}" was not found`,
                "VALIDATION_ERROR",
                [
                  "Install bd, or set `[beads] binary` in .tasks.toml to its path",
                ],
              )
            : new AxiError(`Could not run bd: ${error.message}`, "UNKNOWN"),
        );
      });
      child.on("close", (code, signal) => {
        resolvePromise({
          code: code ?? (signal ? 1 : 0),
          stdout,
          stderr: signal ? `${stderr}\nbd terminated by ${signal}` : stderr,
        });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input ?? "");
    });
}

/** The human-readable failure detail bd reported, minus advisory noise. */
export function bdFailureDetail(result: BdResult): string {
  const details: string[] = [];
  try {
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof payload.error === "string") details.push(payload.error);
    if (Array.isArray(payload.failed)) {
      for (const failure of payload.failed) {
        if (failure && typeof failure.error === "string") {
          details.push(failure.error);
        }
      }
    }
  } catch {
    // Not JSON; fall back to stderr below.
  }
  if (details.length === 0) {
    details.push(
      ...result.stderr
        .split("\n")
        .filter((line) => line.trim() !== "" && !NOISE_LINE_RE.test(line))
        .slice(0, 2),
    );
  }
  // eslint-disable-next-line no-control-regex
  const detail = details.join("; ").replace(/[\u0000-\u001f\u007f]+/g, " ");
  const bounded = detail.length > 300 ? `${detail.slice(0, 297)}...` : detail;
  return bounded.trim() || `exit ${result.code}`;
}

/** Map a failed bd invocation onto a structured tasks-axi error. */
export function bdError(verb: string, result: BdResult): AxiError {
  const detail = bdFailureDetail(result);
  const code = /not found|no issues found/i.test(detail)
    ? "NOT_FOUND"
    : /already exists|duplicate/i.test(detail)
      ? "CONFLICT"
      : /prefix mismatch|invalid|cannot close|blocked by|cycle|required/i.test(
            detail,
          )
        ? "VALIDATION_ERROR"
        : "UNKNOWN";
  return new AxiError(`bd ${verb} failed: ${detail}`, code);
}
