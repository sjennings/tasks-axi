import { describe, expect, it } from "vitest";
import {
  type BdIssue,
  META_KEY,
  NATIVE_DEFER_REASON,
  closeReason,
  holdActiveOn,
  issueToTask,
  localDate,
  mergeMetadata,
  nativeStatus,
  parseStatusCategories,
  readTasksAxiMeta,
  sameJson,
  stateForStatus,
} from "../../src/backends/beads-mapping.js";

function issue(overrides: Partial<BdIssue> = {}): BdIssue {
  return {
    id: "fm-a1",
    title: "Do the thing",
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-07-01T12:00:00Z",
    updated_at: "2026-07-02T12:00:00Z",
    ...overrides,
  };
}

describe("stateForStatus", () => {
  it("maps every built-in bd status onto a tasks-axi state", () => {
    expect(stateForStatus("open")).toBe("queued");
    expect(stateForStatus("blocked")).toBe("queued");
    expect(stateForStatus("deferred")).toBe("queued");
    expect(stateForStatus("pinned")).toBe("queued");
    expect(stateForStatus("in_progress")).toBe("in_flight");
    expect(stateForStatus("hooked")).toBe("in_flight");
    expect(stateForStatus("closed")).toBe("done");
  });

  it("places a custom status by its category, and leaves an unknown one unplaced", () => {
    const categories = new Map([
      ["review", "wip"],
      ["shipped", "done"],
      ["icebox", "frozen"],
      ["triage", "active"],
    ]);
    expect(stateForStatus("review", categories)).toBe("in_flight");
    expect(stateForStatus("shipped", categories)).toBe("done");
    expect(stateForStatus("icebox", categories)).toBe("queued");
    expect(stateForStatus("triage", categories)).toBe("queued");
    expect(stateForStatus("mystery", categories)).toBeUndefined();
  });

  it("reads status categories from every list in `bd statuses --json`", () => {
    const categories = parseStatusCategories({
      built_in_statuses: [{ name: "open", category: "active" }],
      custom_statuses: [{ name: "review", category: "wip" }],
      note: "ignored",
    });
    expect(categories.get("open")).toBe("active");
    expect(categories.get("review")).toBe("wip");
    expect(parseStatusCategories(null).size).toBe(0);
  });
});

describe("nativeStatus", () => {
  it("mirrors an active hold on queued work as deferred", () => {
    const hold = { reason: "captain call", kind: "captain" as const };
    expect(nativeStatus("queued", hold, "2026-07-01")).toBe("deferred");
    expect(nativeStatus("queued", undefined, "2026-07-01")).toBe("open");
    expect(nativeStatus("in_flight", hold, "2026-07-01")).toBe("in_progress");
    expect(nativeStatus("done", hold, "2026-07-01")).toBe("closed");
  });

  it("treats hold-until as exclusive, like the derived held projection", () => {
    const hold = { reason: "later", until: "2026-07-10" };
    expect(holdActiveOn(hold, "2026-07-09")).toBe(true);
    expect(holdActiveOn(hold, "2026-07-10")).toBe(false);
    expect(nativeStatus("queued", hold, "2026-07-10")).toBe("open");
  });
});

describe("issueToTask", () => {
  it("round-trips every tasks-axi field stored under metadata.tasks_axi", () => {
    const task = issueToTask(
      issue({
        description: "line one\nline two",
        priority: 1,
        metadata: {
          other_tool: { keep: true },
          [META_KEY]: {
            kind: "captain",
            repo: "firstmate",
            hold: {
              reason: "captain must decide",
              kind: "captain",
              until: "2026-08-01",
            },
            links: [{ kind: "report", url: "data/fm-a1/report.md" }],
            dep_reasons: { "fm-b2": "waits on the login refactor" },
            created: "2026-06-30",
            meta: { harness: "codex" },
          },
        },
        dependencies: [
          { issue_id: "fm-a1", depends_on_id: "fm-b2", type: "blocks" },
          { issue_id: "fm-a1", depends_on_id: "fm-p0", type: "parent-child" },
          {
            issue_id: "fm-a1",
            depends_on_id: "fm-d9",
            type: "discovered-from",
          },
          { issue_id: "fm-a1", depends_on_id: "fm-r1", type: "related" },
          { issue_id: "fm-other", depends_on_id: "fm-a1", type: "blocks" },
        ],
      }),
      "queued",
    );
    expect(task).toEqual({
      id: "fm-a1",
      title: "Do the thing",
      state: "queued",
      kind: "captain",
      repo: "firstmate",
      body: "line one\nline two",
      links: [{ kind: "report", url: "data/fm-a1/report.md" }],
      deps: [
        {
          type: "blocked-by",
          id: "fm-b2",
          reason: "waits on the login refactor",
        },
        { type: "parent", id: "fm-p0" },
        { type: "discovered-from", id: "fm-d9" },
      ],
      hold: {
        reason: "captain must decide",
        kind: "captain",
        until: "2026-08-01",
      },
      priority: 1,
      created: "2026-06-30",
      updated: localDate("2026-07-02T12:00:00Z"),
      meta: { harness: "codex" },
    });
  });

  it("hides bd's default priority when tasks-axi never set one", () => {
    const task = issueToTask(
      issue({ metadata: { [META_KEY]: { default_priority: true } } }),
      "queued",
    );
    expect(task.priority).toBeUndefined();
    expect(issueToTask(issue(), "queued").priority).toBe(2);
  });

  it("uses a native issue type as the kind only when no tasks-axi kind is set", () => {
    expect(issueToTask(issue(), "queued").kind).toBeUndefined();
    expect(issueToTask(issue({ issue_type: "bug" }), "queued").kind).toBe(
      "bug",
    );
    expect(
      issueToTask(
        issue({
          issue_type: "bug",
          metadata: { [META_KEY]: { kind: "ship" } },
        }),
        "queued",
      ).kind,
    ).toBe("ship");
  });

  it("surfaces a native deferral with no tasks-axi hold as a future hold", () => {
    const task = issueToTask(
      issue({ status: "deferred", defer_until: "2026-09-01T12:00:00Z" }),
      "queued",
    );
    expect(task.hold).toEqual({
      reason: NATIVE_DEFER_REASON,
      kind: "future",
      until: localDate("2026-09-01T12:00:00Z"),
    });
  });

  it("collects PR evidence from external_ref and links in the title", () => {
    const task = issueToTask(
      issue({
        title: "Fix it https://github.com/o/r/pull/9",
        external_ref: "https://github.com/o/r/pull/7",
        metadata: {
          [META_KEY]: {
            links: [{ kind: "pr", url: "https://github.com/o/r/pull/7" }],
          },
        },
      }),
      "done",
    );
    expect(task.links).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/7" },
      { kind: "pr", url: "https://github.com/o/r/pull/9" },
    ]);
  });

  it("stamps closed only on done tasks, preferring the recorded done date", () => {
    const closedAt = "2026-07-03T12:00:00Z";
    expect(
      issueToTask(issue({ status: "closed", closed_at: closedAt }), "done")
        .closed,
    ).toBe(localDate(closedAt));
    expect(
      issueToTask(
        issue({
          status: "closed",
          closed_at: closedAt,
          metadata: { [META_KEY]: { closed: "2026-07-01" } },
        }),
        "done",
      ).closed,
    ).toBe("2026-07-01");
    expect(
      issueToTask(
        issue({ metadata: { [META_KEY]: { closed: "2026-07-01" } } }),
        "queued",
      ).closed,
    ).toBeUndefined();
  });
});

describe("readTasksAxiMeta", () => {
  it("accepts the JSON-string form `bd --set-metadata` writes", () => {
    expect(
      readTasksAxiMeta({ [META_KEY]: JSON.stringify({ repo: "firstmate" }) }),
    ).toEqual({ repo: "firstmate" });
  });

  it("drops malformed fields instead of failing the read", () => {
    expect(
      readTasksAxiMeta({
        [META_KEY]: {
          repo: 7,
          hold: { kind: "captain" },
          links: [{ kind: "nope", url: "x" }],
          created: "yesterday",
          kind: "ship",
        },
      }),
    ).toEqual({ kind: "ship" });
    expect(readTasksAxiMeta({ [META_KEY]: "{not json" })).toEqual({});
    expect(readTasksAxiMeta(null)).toEqual({});
  });

  it("keeps an unknown hold kind out but keeps the hold itself", () => {
    expect(
      readTasksAxiMeta({
        [META_KEY]: { hold: { reason: "wait", kind: "someday" } },
      }).hold,
    ).toEqual({ reason: "wait" });
  });
});

describe("mergeMetadata", () => {
  it("preserves foreign metadata keys and replaces only the tasks-axi namespace", () => {
    const merged = mergeMetadata(
      { team: "platform", [META_KEY]: { repo: "old", kind: "ship" } },
      { repo: "new" },
    );
    expect(merged).toEqual({ team: "platform", [META_KEY]: { repo: "new" } });
  });

  it("removes the namespace entirely once every tasks-axi field is cleared", () => {
    expect(
      mergeMetadata(
        { team: "platform", [META_KEY]: { repo: "old" } },
        { links: [], dep_reasons: {} },
      ),
    ).toEqual({ team: "platform" });
  });

  it("compares metadata independent of key order", () => {
    expect(
      sameJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }),
    ).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("closeReason", () => {
  it("records PR and report evidence, or nothing when there is none", () => {
    expect(
      closeReason({
        pr: "https://github.com/o/r/pull/7",
        report: "data/fm-a1/report.md",
      }),
    ).toBe("PR https://github.com/o/r/pull/7; report data/fm-a1/report.md");
    expect(closeReason({})).toBeUndefined();
  });
});

describe("localDate", () => {
  it("renders a bd timestamp as a local calendar date and ignores junk", () => {
    expect(localDate("2026-07-01T12:00:00Z")).toMatch(/^2026-07-0[12]$/);
    expect(localDate("not a date")).toBeUndefined();
    expect(localDate(null)).toBeUndefined();
  });
});
