import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import {
  addCommand,
  listCommand,
  rmCommand,
  showCommand,
  updateCommand,
} from "../../src/commands/crud.js";
import { pruneCommand, renderCommand } from "../../src/commands/maintain.js";
import { publicFollowupCommand } from "../../src/commands/public-followup.js";
import {
  blockCommand,
  doneCommand,
  holdCommand,
  mvCommand,
  readyCommand,
  reopenCommand,
  startCommand,
  unblockCommand,
  unholdCommand,
} from "../../src/commands/state.js";
import type { TasksContext } from "../../src/context.js";

/**
 * Runs the beads backend against a real `bd` in a scratch workspace. bd is an
 * optional system tool, so the whole suite skips cleanly when it is absent.
 */
const HAS_BD = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const TODAY = "2026-07-01";
const BD_TIMEOUT = 120_000;

let root: string;
let beadsDir: string;
let ctx: TasksContext;

/** Raw `bd list --json` record for one id, read straight from bd. */
function bdIssue(id: string): Record<string, any> {
  const result = spawnSync(
    "bd",
    ["list", "--all", "--flat", "--limit", "0", `--id=${id}`, "--json"],
    {
      cwd: root,
      env: { ...process.env, BEADS_DIR: beadsDir },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(0);
  const [issue] = JSON.parse(result.stdout) as Record<string, any>[];
  return issue;
}

function bd(args: string[]): void {
  const result = spawnSync("bd", args, {
    cwd: root,
    env: { ...process.env, BEADS_DIR: beadsDir },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
}

function json(out: string): Record<string, any> {
  return JSON.parse(out) as Record<string, any>;
}

describe.skipIf(!HAS_BD)("beads backend against a real bd", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tasks-axi-beads-"));
    const init = spawnSync(
      "bd",
      [
        "init",
        "--quiet",
        "--non-interactive",
        "--skip-agents",
        "--skip-hooks",
        "--prefix",
        "fm",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(init.status, init.stderr).toBe(0);
    beadsDir = join(root, ".beads");
    const store = new BeadsStore({
      path: beadsDir,
      prefix: "fm",
      now: () => TODAY,
    });
    ctx = {
      store,
      config: {
        backend: "beads",
        path: join(root, "backlog.md"),
        doneKeep: 10,
        beads: { binary: "bd", path: beadsDir, prefix: "fm" },
      },
    };
  }, BD_TIMEOUT);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "adds a captain row as native type task with its fields in metadata",
    async () => {
      const out = json(
        await addCommand(
          [
            "fm-add-captain",
            "Choose the route",
            "--kind",
            "captain",
            "--repo",
            "firstmate",
            "--body",
            "Origin: fm-origin\nsecond line",
            "--priority",
            "1",
            "--json",
          ],
          ctx,
        ),
      );
      expect(out.task).toMatchObject({
        id: "fm-add-captain",
        state: "queued",
        kind: "captain",
        repo: "firstmate",
        body: "Origin: fm-origin\nsecond line",
        priority: 1,
      });
      const issue = bdIssue("fm-add-captain");
      expect(issue.issue_type).toBe("task");
      expect(issue.status).toBe("open");
      expect(issue.priority).toBe(1);
      expect(issue.description).toBe("Origin: fm-origin\nsecond line");
      expect(issue.metadata).toEqual({
        tasks_axi: { kind: "captain", repo: "firstmate" },
      });

      const again = json(
        await addCommand(["fm-add-captain", "Choose the route", "--json"], ctx),
      );
      expect(again.already).toBe(true);
    },
    BD_TIMEOUT,
  );

  it(
    "leaves an unset priority unset while bd keeps its default",
    async () => {
      const out = json(
        await addCommand(["fm-add-plain", "Plain task", "--json"], ctx),
      );
      expect(out.task.priority).toBeNull();
      expect(bdIssue("fm-add-plain").priority).toBe(2);
    },
    BD_TIMEOUT,
  );

  it(
    "mirrors holds onto native deferred status and keeps held work out of ready",
    async () => {
      await addCommand(["fm-hold-a", "Held work"], ctx);
      await addCommand(["fm-hold-b", "Dated hold"], ctx);
      await holdCommand(
        ["fm-hold-a", "--reason", "captain must decide", "--kind", "captain"],
        ctx,
      );
      await holdCommand(
        ["fm-hold-b", "--reason", "after launch", "--until", "2099-01-01"],
        ctx,
      );

      expect(bdIssue("fm-hold-a")).toMatchObject({ status: "deferred" });
      expect(bdIssue("fm-hold-a").defer_until).toBeFalsy();
      expect(bdIssue("fm-hold-b").status).toBe("deferred");
      expect(bdIssue("fm-hold-b").defer_until).toMatch(/^2099-01-0[12]/);

      const show = await showCommand(["fm-hold-a"], ctx);
      expect(show).toContain("held: yes");
      expect(show).toContain("hold_kind: captain");
      const ready = await readyCommand([], ctx);
      expect(ready).not.toContain("fm-hold-a");
      expect(ready).not.toContain("fm-hold-b");
      const held = await listCommand(["--state", "held"], ctx);
      expect(held).toContain("fm-hold-a");
      expect(held).toContain("fm-hold-b");

      const unheld = json(await unholdCommand(["fm-hold-b", "--json"], ctx));
      expect(unheld.task.held).toBe(false);
      expect(bdIssue("fm-hold-b").status).toBe("open");
      expect(bdIssue("fm-hold-b").defer_until).toBeFalsy();
      expect(await readyCommand([], ctx)).toContain("fm-hold-b");
    },
    BD_TIMEOUT,
  );

  it(
    "maps start and evidence-bearing done onto native status and evidence fields",
    async () => {
      await addCommand(["fm-ship-a", "Ship it", "--kind", "ship"], ctx);
      await startCommand(["fm-ship-a"], ctx);
      expect(bdIssue("fm-ship-a").status).toBe("in_progress");

      const pr = "https://github.com/o/r/pull/7";
      const done = json(
        await doneCommand(
          [
            "fm-ship-a",
            "--pr",
            pr,
            "--report",
            "data/fm-ship-a/report.md",
            "--note",
            "landed cleanly",
            "--json",
          ],
          ctx,
        ),
      );
      expect(done.task).toMatchObject({
        state: "done",
        closed: TODAY,
        body: "landed cleanly",
        links: [
          { kind: "pr", url: pr },
          { kind: "report", url: "data/fm-ship-a/report.md" },
        ],
      });
      const issue = bdIssue("fm-ship-a");
      expect(issue.status).toBe("closed");
      expect(issue.close_reason).toBe(
        `PR ${pr}; report data/fm-ship-a/report.md`,
      );
      expect(issue.external_ref).toBe(pr);

      const again = json(
        await doneCommand(
          ["fm-ship-a", "--pr", "https://github.com/o/r/pull/8", "--json"],
          ctx,
        ),
      );
      expect(again.already).toBe(true);
      expect(again.task.closed).toBe(TODAY);
      expect(again.task.links).toContainEqual({
        kind: "pr",
        url: "https://github.com/o/r/pull/8",
      });
    },
    BD_TIMEOUT,
  );

  it(
    "keeps a captain hold kind through a close and restores deferral on reopen",
    async () => {
      await addCommand(["fm-call-a", "Captain call", "--kind", "captain"], ctx);
      await holdCommand(
        ["fm-call-a", "--reason", "captain must decide", "--kind", "captain"],
        ctx,
      );
      await doneCommand(["fm-call-a"], ctx);
      const closed = await showCommand(["fm-call-a"], ctx);
      expect(closed).toContain("state: done");
      expect(closed).toContain("hold_kind: captain");
      expect(closed).toContain("held: no");

      await reopenCommand(["fm-call-a"], ctx);
      expect(bdIssue("fm-call-a").status).toBe("deferred");
      expect(await showCommand(["fm-call-a"], ctx)).toContain("held: yes");
    },
    BD_TIMEOUT,
  );

  it(
    "archives a replaced body as a bd comment and stays idempotent",
    async () => {
      await addCommand(["fm-notes-a", "Notes", "--body", "old notes"], ctx);
      const out = json(
        await updateCommand(
          ["fm-notes-a", "--body", "new notes", "--archive-body", "--json"],
          ctx,
        ),
      );
      expect(out.changed).toEqual(["body", "archive"]);
      expect(out.task.body).toBe("new notes");
      const comments = spawnSync("bd", ["comments", "fm-notes-a", "--json"], {
        cwd: root,
        env: { ...process.env, BEADS_DIR: beadsDir },
        encoding: "utf8",
      });
      expect(comments.stdout).toContain("old notes");

      const again = json(
        await updateCommand(
          ["fm-notes-a", "--body", "new notes", "--json"],
          ctx,
        ),
      );
      expect(again.already).toBe(true);
    },
    BD_TIMEOUT,
  );

  it(
    "records blocked-by edges natively and refuses to close or remove across them",
    async () => {
      await addCommand(["fm-dep-blocker", "Blocker"], ctx);
      await addCommand(
        ["fm-dep-dependent", "Dependent", "--blocked-by", "fm-dep-blocker"],
        ctx,
      );
      expect(bdIssue("fm-dep-dependent").dependencies).toEqual([
        expect.objectContaining({
          issue_id: "fm-dep-dependent",
          depends_on_id: "fm-dep-blocker",
          type: "blocks",
        }),
      ]);
      expect(await showCommand(["fm-dep-dependent"], ctx)).toContain(
        "blocked: yes",
      );

      await expect(
        doneCommand(["fm-dep-dependent"], ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(rmCommand(["fm-dep-blocker"], ctx)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });

      await unblockCommand(["fm-dep-dependent", "--by", "fm-dep-blocker"], ctx);
      expect(bdIssue("fm-dep-dependent").dependencies ?? []).toEqual([]);
      await blockCommand(["fm-dep-dependent", "--by", "fm-dep-blocker"], ctx);
      expect(await showCommand(["fm-dep-dependent"], ctx)).toContain(
        "blocked_by: fm-dep-blocker",
      );
    },
    BD_TIMEOUT,
  );

  it(
    "round-trips a dependency reason through the store",
    async () => {
      await addCommand(["fm-reason-blocker", "Blocker"], ctx);
      await addCommand(["fm-reason-dependent", "Dependent"], ctx);
      expect(
        await ctx.store.addDep("fm-reason-dependent", {
          type: "blocked-by",
          id: "fm-reason-blocker",
          reason: "waits on the login refactor",
        }),
      ).toBe(true);
      expect((await ctx.store.get("fm-reason-dependent"))?.deps).toEqual([
        {
          type: "blocked-by",
          id: "fm-reason-blocker",
          reason: "waits on the login refactor",
        },
      ]);
      expect(
        await ctx.store.removeDep("fm-reason-dependent", {
          type: "blocked-by",
          id: "fm-reason-blocker",
        }),
      ).toBe(true);
      expect(
        bdIssue("fm-reason-dependent").metadata?.tasks_axi?.dep_reasons,
      ).toBeUndefined();
    },
    BD_TIMEOUT,
  );

  it(
    "resolves ids exactly, never by bd's partial-id matching",
    async () => {
      await addCommand(["fm-exact-match-one", "Exact"], ctx);
      expect(await ctx.store.get("fm-exact-match")).toBeNull();
      await expect(showCommand(["fm-exact-match"], ctx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    },
    BD_TIMEOUT,
  );

  it(
    "reads issues created natively in bd",
    async () => {
      bd([
        "create",
        "--id=fm-native-bug",
        "--title=Native bug",
        "--type=bug",
        "--priority=1",
        "--status=in_progress",
        '--metadata={"team":"platform"}',
        "--json",
      ]);
      // A fresh store, like the next CLI invocation, sees the external write.
      ctx = {
        ...ctx,
        store: new BeadsStore({
          path: beadsDir,
          prefix: "fm",
          now: () => TODAY,
        }),
      };
      const task = await ctx.store.get("fm-native-bug");
      expect(task).toMatchObject({
        state: "in_flight",
        kind: "bug",
        priority: 1,
      });
      await updateCommand(["fm-native-bug", "--repo", "firstmate"], ctx);
      expect(bdIssue("fm-native-bug").metadata).toEqual({
        team: "platform",
        tasks_axi: { repo: "firstmate" },
      });
      expect(bdIssue("fm-native-bug").issue_type).toBe("bug");
    },
    BD_TIMEOUT,
  );

  it(
    "removes an unblocking task with bd delete",
    async () => {
      await addCommand(["fm-remove-me", "Stale"], ctx);
      await rmCommand(["fm-remove-me"], ctx);
      expect(await ctx.store.get("fm-remove-me")).toBeNull();
    },
    BD_TIMEOUT,
  );

  it(
    "refuses an id outside the configured prefix",
    async () => {
      await expect(
        addCommand(["other-thing", "Wrong prefix"], ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    },
    BD_TIMEOUT,
  );

  it(
    "refuses commands Beads has no faithful mapping for, naming each one",
    async () => {
      await addCommand(["fm-refuse-a", "Refusals"], ctx);
      const cases: [string, () => Promise<string>][] = [
        ["prune", () => pruneCommand([], ctx)],
        ["render", () => renderCommand([], ctx)],
        [
          "mv",
          () => mvCommand(["fm-refuse-a", "--to", join(root, "x.md")], ctx),
        ],
        ["public-followup", () => publicFollowupCommand(["list"], ctx)],
      ];
      for (const [command, run] of cases) {
        await expect(run()).rejects.toMatchObject({
          code: "UNSUPPORTED",
          message: `The beads backend does not support ${command}`,
        });
      }
    },
    BD_TIMEOUT,
  );

  it(
    "skips done's auto-prune because Beads keeps closed issues",
    async () => {
      await addCommand(["fm-noprune-a", "No prune"], ctx);
      const out = json(
        await doneCommand(["fm-noprune-a", "--keep", "0", "--json"], ctx),
      );
      expect(out.pruned).toBe(0);
      expect(bdIssue("fm-noprune-a").status).toBe("closed");
    },
    BD_TIMEOUT,
  );
});
