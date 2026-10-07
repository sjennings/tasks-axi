import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfigToml, resolveConfig } from "../src/config.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-cfg-"));
  home = mkdtempSync(join(tmpdir(), "tasks-axi-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("parseConfigToml", () => {
  it("reads backend and the [markdown] table", () => {
    const cfg = parseConfigToml(
      [
        "# a comment",
        'backend = "markdown"',
        "",
        "[markdown]",
        'path = "data/backlog.md"',
        "done_keep = 15",
        'archive = "data/done-archive.md"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("markdown");
    expect(cfg.markdown).toEqual({
      path: "data/backlog.md",
      done_keep: 15,
      archive: "data/done-archive.md",
    });
  });

  it("ignores unknown keys and tables", () => {
    const cfg = parseConfigToml('[sqlite]\npath = ".tasks.db"\npath: broken\n');
    expect(cfg.markdown).toBeUndefined();
  });

  it("keeps # inside quoted values while stripping trailing comments", () => {
    const cfg = parseConfigToml(
      '[markdown]\npath = "data/back#log.md" # keep the hash\n',
    );
    expect(cfg.markdown?.path).toBe("data/back#log.md");
  });

  it("rejects an unquoted known string value", () => {
    expect(() =>
      parseConfigToml("[markdown]\npath = data/backlog.md\n"),
    ).toThrow(/markdown\.path/);
  });

  it("rejects an unterminated quoted value", () => {
    expect(() =>
      parseConfigToml('[markdown]\npath = "data/backlog.md\n'),
    ).toThrow(/unterminated/);
  });

  it("rejects a non-numeric done_keep value", () => {
    expect(() =>
      parseConfigToml("[markdown]\ndone_keep = many\n"),
    ).toThrow(/done_keep/);
  });

  it("rejects malformed assignments in the top-level scope", () => {
    expect(() => parseConfigToml('backend: "markdown"\n')).toThrow(
      /key = value/,
    );
  });

  it("rejects malformed assignments in the markdown table", () => {
    expect(() =>
      parseConfigToml('[markdown]\npath: "data/backlog.md"\n'),
    ).toThrow(/key = value/);
    expect(() => parseConfigToml("[markdown]\ndone_keep 5\n")).toThrow(
      /key = value/,
    );
  });
});

describe("resolveConfig", () => {
  it("defaults to the markdown backend and backlog.md", () => {
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.backend).toBe("markdown");
    expect(cfg.path).toBe(join(dir, "backlog.md"));
    expect(cfg.doneKeep).toBe(10);
  });

  it("prefers data/backlog.md when it exists and backlog.md does not", () => {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "backlog.md"), "# Backlog\n");
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.path).toBe(join(data, "backlog.md"));
  });

  it("honors the override order: flag > env > project toml", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "markdown"\n[markdown]\npath = "from-toml.md"\n',
    );
    const fromToml = resolveConfig({ cwd: dir, home, env: {} });
    expect(fromToml.path).toBe(join(dir, "from-toml.md"));

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
    });
    expect(fromEnv.path).toBe("/abs/from-env.md");

    const fromFlag = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
      file: "/abs/from-flag.md",
    });
    expect(fromFlag.path).toBe("/abs/from-flag.md");
  });

  it("does not validate a lower-priority empty toml path", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[markdown]\npath = ""\n');

    const fromEnv = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
    });
    expect(fromEnv.path).toBe("/abs/from-env.md");

    const fromFlag = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_FILE: "/abs/from-env.md" },
      file: "/abs/from-flag.md",
    });
    expect(fromFlag.path).toBe("/abs/from-flag.md");
  });

  it("reads done_keep from the project toml", () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = 5\n");
    expect(resolveConfig({ cwd: dir, home, env: {} }).doneKeep).toBe(5);
  });

  it("rejects negative done_keep from toml", () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = -1\n");
    expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
      /done_keep/,
    );
  });

  it.each(["", "   "])(
    "rejects an empty TASKS_AXI_FILE value %#",
    (value) => {
      expect(() =>
        resolveConfig({ cwd: dir, home, env: { TASKS_AXI_FILE: value } }),
      ).toThrow(/TASKS_AXI_FILE/);
    },
  );

  it.each(["", "   "])(
    "rejects an empty markdown path from toml %#",
    (value) => {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `[markdown]\npath = "${value}"\n`,
      );
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /markdown\.path/,
      );
    },
  );
});

describe("[beads] config", () => {
  it("parses binary, path, and prefix from the [beads] table", () => {
    const cfg = parseConfigToml(
      [
        'backend = "beads"',
        "[beads]",
        'binary = "bd"',
        'path = "graph/.beads" # the workspace',
        'prefix = "fm"',
        "[markdown]",
        'path = "data/backlog.md"',
      ].join("\n"),
    );
    expect(cfg.backend).toBe("beads");
    expect(cfg.beads).toEqual({
      binary: "bd",
      path: "graph/.beads",
      prefix: "fm",
    });
    expect(cfg.markdown?.path).toBe("data/backlog.md");
  });

  it("resolves a relative project path against the backlog root", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[beads]\npath = "graph/.beads"\nprefix = "fm-"\n',
    );
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.backend).toBe("beads");
    expect(cfg.beads).toEqual({
      binary: "bd",
      path: join(dir, "graph/.beads"),
      prefix: "fm",
    });
  });

  it("falls back key by key to the user-level table, resolving against its dir", () => {
    mkdirSync(join(home, ".tasks-axi"), { recursive: true });
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      'backend = "beads"\n[beads]\npath = "graph/.beads"\nbinary = "tools/bd"\nprefix = "home"\n',
    );
    writeFileSync(join(dir, ".tasks.toml"), '[beads]\nprefix = "fm"\n');
    const cfg = resolveConfig({ cwd: dir, home, env: {} });
    expect(cfg.beads).toEqual({
      binary: join(home, ".tasks-axi", "tools/bd"),
      path: join(home, ".tasks-axi", "graph/.beads"),
      prefix: "fm",
    });
  });

  it("selects beads through every documented layer", () => {
    expect(
      resolveConfig({ cwd: dir, home, env: {}, backend: "beads" }).backend,
    ).toBe("beads");
    expect(
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_BACKEND: "beads" } })
        .backend,
    ).toBe("beads");
    mkdirSync(join(home, ".tasks-axi"), { recursive: true });
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      'backend = "beads"\n',
    );
    expect(resolveConfig({ cwd: dir, home, env: {} }).backend).toBe("beads");
    writeFileSync(join(dir, ".tasks.toml"), 'backend = "markdown"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).backend).toBe(
      "markdown",
    );
  });

  it("leaves the workspace to bd's own discovery when no path is set", () => {
    const cfg = resolveConfig({
      cwd: dir,
      home,
      env: { TASKS_AXI_BACKEND: "beads" },
    });
    expect(cfg.beads).toEqual({ binary: "bd" });
  });

  it("rejects a malformed prefix only when beads is selected", () => {
    writeFileSync(join(dir, ".tasks.toml"), '[beads]\nprefix = "f m"\n');
    expect(resolveConfig({ cwd: dir, home, env: {} }).backend).toBe(
      "markdown",
    );
    expect(() =>
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_BACKEND: "beads" } }),
    ).toThrow(/beads\.prefix/);
  });

  it("records which override named the markdown file", () => {
    expect(
      resolveConfig({ cwd: dir, home, env: {}, file: "/abs/x.md" }).fileSource,
    ).toBe("--file");
    expect(
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_FILE: "/abs/x.md" } })
        .fileSource,
    ).toBe("TASKS_AXI_FILE");
    expect(resolveConfig({ cwd: dir, home, env: {} }).fileSource).toBeUndefined();
  });
});
