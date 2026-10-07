import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BdResult,
  BeadsStore,
  bdError,
  bdFailureDetail,
  spawnRunner,
} from "../../src/backends/beads.js";
import { resolveTasksContext } from "../../src/context.js";

/** No-bd tests: error mapping, process plumbing, and backend selection. */

function result(overrides: Partial<BdResult>): BdResult {
  return { code: 1, stdout: "", stderr: "", ...overrides };
}

describe("bd failure mapping", () => {
  it("prefers bd's JSON error payload, including per-issue failures", () => {
    expect(
      bdFailureDetail(
        result({
          stdout: JSON.stringify({
            error: "1 of 1 issues failed to update",
            failed: [{ id: "fm-a", error: "cannot close blocked issue" }],
          }),
        }),
      ),
    ).toBe("1 of 1 issues failed to update; cannot close blocked issue");
  });

  it("falls back to stderr without bd's advisory noise", () => {
    expect(
      bdFailureDetail(
        result({
          stderr: [
            "warning: beads.role not configured (GH#2950).",
            "  Fix: git config beads.role maintainer",
            "  Or:  git config beads.role contributor",
            "Error: prefix mismatch: database uses 'fm-'",
            "Hint: try something",
          ].join("\n"),
        }),
      ),
    ).toBe("Error: prefix mismatch: database uses 'fm-'");
    expect(bdFailureDetail(result({ code: 3 }))).toBe("exit 3");
  });

  it("bounds and de-controls the detail", () => {
    const detail = bdFailureDetail(
      result({ stderr: `bad\u001b[31m ${"x".repeat(400)}` }),
    );
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.includes("\u001b")).toBe(false);
  });

  it("maps bd failures onto structured error codes", () => {
    const code = (stderr: string) => bdError("update", result({ stderr })).code;
    expect(code("Issue fm-x not found")).toBe("NOT_FOUND");
    expect(code("issue fm-x already exists")).toBe("CONFLICT");
    expect(code("cannot close blocked issue: fm-a is blocked by [fm-b]")).toBe(
      "VALIDATION_ERROR",
    );
    expect(code("Error: prefix mismatch")).toBe("VALIDATION_ERROR");
    expect(code("database is locked")).toBe("UNKNOWN");
    expect(bdError("close", result({ stderr: "boom" })).message).toBe(
      "bd close failed: boom",
    );
  });
});

describe("BeadsStore plumbing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-run-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing bd binary as an actionable validation error", async () => {
    const run = spawnRunner(join(dir, "no-such-bd"), undefined, dir);
    await expect(run(["list"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("was not found"),
    });
  });

  it("refuses a configured workspace that does not exist before running bd", async () => {
    let calls = 0;
    const store = new BeadsStore({
      path: join(dir, "missing", ".beads"),
      runner: async () => {
        calls++;
        return result({ code: 0, stdout: "[]" });
      },
    });
    await expect(store.get("fm-a")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(calls).toBe(0);
  });

  // A shebang script stands in for bd, which Windows cannot execute directly.
  it.skipIf(process.platform === "win32")(
    "passes BEADS_DIR and stdin through to bd and runs it from the graph repo",
    async () => {
      const script = join(dir, "fake-bd");
      writeFileSync(
        script,
        '#!/bin/sh\nprintf \'%s|%s|%s\' "$BEADS_DIR" "$(pwd -P)" "$(cat)"\n',
        { mode: 0o755 },
      );
      const beads = join(dir, ".beads");
      const run = spawnRunner(script, beads, "/");
      const out = await run(["comment"], "archived");
      expect(out.code).toBe(0);
      const [beadsDir, cwd, stdin] = out.stdout.split("|");
      expect(beadsDir).toBe(beads);
      expect(cwd.endsWith(dir.split("/").pop() ?? "")).toBe(true);
      expect(stdin).toBe("archived");
    },
  );

  it("rejects bd output that is not JSON", async () => {
    const store = new BeadsStore({
      runner: async () => result({ code: 0, stdout: "not json" }),
    });
    await expect(store.list({})).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("refuses public-followup data at the store seam", async () => {
    const store = new BeadsStore({
      runner: async () => result({ code: 0, stdout: "[]" }),
    });
    await expect(
      store.create({ id: "fm-pf", title: "x", kind: "public-followup" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(store.updatePublicFollowup()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

describe("backend selection", () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-"));
    home = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-home-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("builds a beads store from .tasks.toml without running bd", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[beads]\npath = ".beads"\n',
    );
    const ctx = resolveTasksContext({ cwd: dir, home, env: {} });
    expect(ctx.store).toBeInstanceOf(BeadsStore);
    expect(ctx.store.capabilities()).toMatchObject({
      backend: "beads",
      prune: false,
      publicFollowups: false,
    });
  });

  it("refuses --file on beads but ignores a markdown-only TASKS_AXI_FILE", () => {
    expect(() =>
      resolveTasksContext({
        cwd: dir,
        home,
        env: {},
        backend: "beads",
        file: "data/backlog.md",
      }),
    ).toThrow(/--file addresses a markdown backlog/);
    const ctx = resolveTasksContext({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "data/backlog.md" },
      backend: "beads",
    });
    expect(ctx.store).toBeInstanceOf(BeadsStore);
  });

  it("names both supported backends when given an unknown one", () => {
    expect(() =>
      resolveTasksContext({ cwd: dir, home, env: {}, backend: "sqlite" }),
    ).toThrow(/expected markdown or beads/);
  });
});
