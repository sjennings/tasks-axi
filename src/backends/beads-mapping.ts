import {
  HOLD_KINDS,
  type Dep,
  type DepType,
  type Hold,
  type HoldKind,
  type State,
  type Task,
  type TaskLink,
} from "../model.js";
import { isPrUrl } from "../pr-url.js";
import { deriveLinks } from "./markdown-grammar.js";

/**
 * Pure translation between `bd ... --json` issue records and tasks-axi Tasks.
 * No I/O lives here; `beads.ts` runs bd and feeds these functions.
 *
 * Native Beads fields carry everything Beads already models: title,
 * description (= body), status (= state), priority, `blocks` /
 * `parent-child` / `discovered-from` dependency edges, `external_ref` (first
 * PR link), `close_reason` (done evidence), and `defer_until` (hold-until).
 * The tasks-axi-only fields ride in one namespaced metadata object,
 * `metadata.tasks_axi`, so they round-trip losslessly without touching any
 * other metadata key a workspace or another tool keeps on the issue.
 */

/** The metadata key that holds every tasks-axi-only field. */
export const META_KEY = "tasks_axi";

/** One dependency edge as `bd list --json` reports it. */
export interface BdDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

/** The subset of a `bd list --json` issue record tasks-axi reads. */
export interface BdIssue {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: number;
  issue_type?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  close_reason?: string | null;
  external_ref?: string | null;
  defer_until?: string | null;
  metadata?: Record<string, unknown> | null;
  dependencies?: BdDependency[] | null;
}

/** The fields stored under `metadata.tasks_axi`. */
export interface TasksAxiMeta {
  /** tasks-axi kind (Beads native issue type stays `task`). */
  kind?: string;
  repo?: string;
  hold?: Hold;
  links?: TaskLink[];
  /** Free-text `blocked-by` reasons keyed by blocker id. */
  dep_reasons?: Record<string, string>;
  /** True while the native priority is only bd's default, not a tasks-axi value. */
  default_priority?: boolean;
  /** YYYY-MM-DD created stamp when a caller supplied one explicitly. */
  created?: string;
  /** YYYY-MM-DD closed stamp recorded by `done`. */
  closed?: string;
  meta?: Record<string, unknown>;
}

/** bd's built-in statuses and the tasks-axi state each one projects to. */
const BUILT_IN_STATES: Record<string, State> = {
  open: "queued",
  blocked: "queued",
  deferred: "queued",
  pinned: "queued",
  in_progress: "in_flight",
  hooked: "in_flight",
  closed: "done",
};

/** Custom-status categories (`bd statuses --json`) and their projection. */
const CATEGORY_STATES: Record<string, State> = {
  active: "queued",
  frozen: "queued",
  wip: "in_flight",
  done: "done",
};

const DEP_TO_BD: Record<DepType, string> = {
  "blocked-by": "blocks",
  parent: "parent-child",
  "discovered-from": "discovered-from",
};

const BD_TO_DEP: Record<string, DepType> = {
  blocks: "blocked-by",
  "parent-child": "parent",
  "discovered-from": "discovered-from",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The reason given to a hold synthesized from a native `deferred` status. */
export const NATIVE_DEFER_REASON = "deferred in Beads";

/** The bd dependency type for a tasks-axi edge type. */
export function bdDepType(type: DepType): string {
  return DEP_TO_BD[type];
}

/**
 * Project a bd status onto a tasks-axi state. Built-in statuses map directly;
 * a custom status maps through its configured category. Returns undefined for
 * a status this function cannot place, so the caller can load categories.
 */
export function stateForStatus(
  status: string,
  categories?: ReadonlyMap<string, string>,
): State | undefined {
  const builtIn = BUILT_IN_STATES[status];
  if (builtIn) return builtIn;
  const category = categories?.get(status);
  return category ? CATEGORY_STATES[category] : undefined;
}

/** Whether a status needs `bd statuses` to be placed. */
export function isBuiltInStatus(status: string): boolean {
  return status in BUILT_IN_STATES;
}

/**
 * Read `{name, category}` entries from `bd statuses --json`, whatever arrays
 * the payload groups them in (built-in and custom lists).
 */
export function parseStatusCategories(payload: unknown): Map<string, string> {
  const categories = new Map<string, string>();
  if (!payload || typeof payload !== "object") return categories;
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { name, category } = entry as Record<string, unknown>;
      if (typeof name === "string" && typeof category === "string") {
        categories.set(name, category);
      }
    }
  }
  return categories;
}

/** The bd status a tasks-axi state writes, mirroring an active hold as `deferred`. */
export function nativeStatus(
  state: State,
  hold: Hold | undefined,
  today: string,
): string {
  if (state === "done") return "closed";
  if (state === "in_flight") return "in_progress";
  return holdActiveOn(hold, today) ? "deferred" : "open";
}

/** Whether a hold still gates dispatch on `today` (hold-until is exclusive). */
export function holdActiveOn(hold: Hold | undefined, today: string): boolean {
  return hold !== undefined && (!hold.until || hold.until > today);
}

/** A bd RFC 3339 timestamp as a local YYYY-MM-DD date (firstmate dates are local). */
export function localDate(
  timestamp: string | null | undefined,
): string | undefined {
  if (!timestamp) return undefined;
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return undefined;
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalDate(value: unknown): string | undefined {
  return typeof value === "string" && DATE_RE.test(value) ? value : undefined;
}

function readHold(value: unknown): Hold | undefined {
  if (!isRecord(value)) return undefined;
  const reason = optionalString(value.reason);
  if (!reason) return undefined;
  const hold: Hold = { reason };
  if (
    typeof value.kind === "string" &&
    (HOLD_KINDS as readonly string[]).includes(value.kind)
  ) {
    hold.kind = value.kind as HoldKind;
  }
  const until = optionalDate(value.until);
  if (until) hold.until = until;
  return hold;
}

function readLinks(value: unknown): TaskLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: TaskLink[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { kind, url } = entry;
    if (
      (kind === "pr" || kind === "report" || kind === "doc") &&
      typeof url === "string" &&
      url !== ""
    ) {
      links.push({ kind, url });
    }
  }
  return links.length > 0 ? links : undefined;
}

function readReasons(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const reasons: Record<string, string> = {};
  for (const [id, reason] of Object.entries(value)) {
    if (typeof reason === "string" && reason !== "") reasons[id] = reason;
  }
  return Object.keys(reasons).length > 0 ? reasons : undefined;
}

/**
 * Read `metadata.tasks_axi`, tolerating a JSON-string value (what
 * `bd update --set-metadata tasks_axi=<json>` stores) and dropping any field
 * whose shape is wrong rather than failing the whole read.
 */
export function readTasksAxiMeta(
  metadata: Record<string, unknown> | null | undefined,
): TasksAxiMeta {
  let raw: unknown = metadata?.[META_KEY];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!isRecord(raw)) return {};
  const ta: TasksAxiMeta = {};
  const kind = optionalString(raw.kind);
  if (kind) ta.kind = kind;
  const repo = optionalString(raw.repo);
  if (repo) ta.repo = repo;
  const hold = readHold(raw.hold);
  if (hold) ta.hold = hold;
  const links = readLinks(raw.links);
  if (links) ta.links = links;
  const reasons = readReasons(raw.dep_reasons);
  if (reasons) ta.dep_reasons = reasons;
  if (raw.default_priority === true) ta.default_priority = true;
  const created = optionalDate(raw.created);
  if (created) ta.created = created;
  const closed = optionalDate(raw.closed);
  if (closed) ta.closed = closed;
  if (isRecord(raw.meta)) ta.meta = raw.meta;
  return ta;
}

/** Drop empty fields so an unused tasks-axi namespace disappears entirely. */
function compactMeta(ta: TasksAxiMeta): TasksAxiMeta {
  const out: TasksAxiMeta = {};
  if (ta.kind) out.kind = ta.kind;
  if (ta.repo) out.repo = ta.repo;
  if (ta.hold) out.hold = ta.hold;
  if (ta.links && ta.links.length > 0) out.links = ta.links;
  if (ta.dep_reasons && Object.keys(ta.dep_reasons).length > 0) {
    out.dep_reasons = ta.dep_reasons;
  }
  if (ta.default_priority) out.default_priority = true;
  if (ta.created) out.created = ta.created;
  if (ta.closed) out.closed = ta.closed;
  if (ta.meta && Object.keys(ta.meta).length > 0) out.meta = ta.meta;
  return out;
}

/**
 * The full metadata object to write back: every foreign key preserved, the
 * tasks-axi namespace replaced (or removed when empty).
 */
export function mergeMetadata(
  existing: Record<string, unknown> | null | undefined,
  ta: TasksAxiMeta,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  const compact = compactMeta(ta);
  if (Object.keys(compact).length > 0) {
    merged[META_KEY] = compact;
  } else {
    delete merged[META_KEY];
  }
  return merged;
}

/** Stable JSON for comparing two metadata objects. */
export function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function readDeps(issue: BdIssue, ta: TasksAxiMeta): Dep[] {
  const deps: Dep[] = [];
  for (const edge of issue.dependencies ?? []) {
    if (edge.issue_id !== issue.id) continue;
    const type = BD_TO_DEP[edge.type];
    if (!type) continue;
    const dep: Dep = { type, id: edge.depends_on_id };
    const reason =
      type === "blocked-by" ? ta.dep_reasons?.[edge.depends_on_id] : undefined;
    if (reason) dep.reason = reason;
    deps.push(dep);
  }
  return deps;
}

function readLinksFor(issue: BdIssue, ta: TasksAxiMeta): TaskLink[] {
  const links: TaskLink[] = [];
  const add = (link: TaskLink) => {
    if (!links.some((existing) => existing.url === link.url)) links.push(link);
  };
  for (const link of ta.links ?? []) add(link);
  for (const link of deriveLinks(issue.title)) add(link);
  const ref = issue.external_ref;
  if (ref && isPrUrl(ref)) add({ kind: "pr", url: ref });
  return links;
}

/**
 * A native `deferred` status with no tasks-axi hold still keeps the issue out
 * of dispatch, so it surfaces as a `future` hold (dated when bd has a
 * `defer_until`). The tasks-axi hold, when recorded, is authoritative.
 */
function readHoldFor(issue: BdIssue, ta: TasksAxiMeta): Hold | undefined {
  if (ta.hold) return ta.hold;
  if (issue.status !== "deferred") return undefined;
  const hold: Hold = { reason: NATIVE_DEFER_REASON, kind: "future" };
  const until = localDate(issue.defer_until);
  if (until) hold.until = until;
  return hold;
}

/** Translate one bd issue into a tasks-axi Task. */
export function issueToTask(issue: BdIssue, state: State): Task {
  const ta = readTasksAxiMeta(issue.metadata);
  const task: Task = {
    id: issue.id,
    title: issue.title,
    state,
    links: readLinksFor(issue, ta),
    deps: readDeps(issue, ta),
  };
  const kind =
    ta.kind ??
    (issue.issue_type && issue.issue_type !== "task"
      ? issue.issue_type
      : undefined);
  if (kind) task.kind = kind;
  if (ta.repo) task.repo = ta.repo;
  if (issue.description) task.body = issue.description;
  const hold = readHoldFor(issue, ta);
  if (hold) task.hold = hold;
  if (!ta.default_priority && typeof issue.priority === "number") {
    task.priority = issue.priority;
  }
  const created = ta.created ?? localDate(issue.created_at);
  if (created) task.created = created;
  const updated = localDate(issue.updated_at);
  if (updated) task.updated = updated;
  if (state === "done") {
    const closed = ta.closed ?? localDate(issue.closed_at);
    if (closed) task.closed = closed;
  }
  if (ta.meta) task.meta = ta.meta;
  return task;
}

/** The `bd close --reason` evidence line for a done transition, if any. */
export function closeReason(evidence: {
  pr?: string;
  report?: string;
}): string | undefined {
  const parts: string[] = [];
  if (evidence.pr) parts.push(`PR ${evidence.pr}`);
  if (evidence.report) parts.push(`report ${evidence.report}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}
