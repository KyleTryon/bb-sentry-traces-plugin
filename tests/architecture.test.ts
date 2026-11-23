import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The layering the source is organized by. `core/` is pure event-to-trace
 * logic: it does not know about bb, Sentry, providers or the export loop.
 * `integrations/` reads what other plugins answer or report; `export/` decides what to
 * send and when. Nothing below `export/` depends on `export/`.
 */
const ROOT = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).split(/[\\/]/).join("/");

interface Node {
  /** Files under src this file imports, as paths relative to src. */
  local: string[];
  /** Packages and builtins it imports. */
  packages: string[];
}

const graph = new Map<string, Node>();
for (const path of sourceFiles(ROOT)) {
  const file = rel(path);
  const local: string[] = [];
  const packages: string[] = [];
  for (const match of readFileSync(path, "utf8").matchAll(/(?:from\s+|import\()\s*"([^"]+)"/g)) {
    const spec = match[1];
    if (spec === undefined) continue;
    if (spec.startsWith(".")) local.push(`${posix.join(posix.dirname(file), spec.replace(/\.js$/, ""))}.ts`);
    else packages.push(spec);
  }
  graph.set(file, { local, packages });
}

function cycles(): string[] {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const found: string[] = [];
  const visit = (file: string) => {
    state.set(file, "open");
    stack.push(file);
    for (const dep of graph.get(file)?.local ?? []) {
      if (!graph.has(dep)) throw new Error(`${file} imports ${dep}, which does not exist`);
      if (state.get(dep) === "open") found.push([...stack.slice(stack.indexOf(dep)), dep].join(" -> "));
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(file, "done");
  };
  for (const file of graph.keys()) if (!state.has(file)) visit(file);
  return found;
}

describe("architecture", () => {
  it("has no import cycles", () => {
    expect(cycles()).toEqual([]);
  });

  it("keeps core to itself and to Node's builtins", () => {
    for (const [file, node] of graph) {
      if (!file.startsWith("core/")) continue;
      const outside = node.local.filter((dep) => !dep.startsWith("core/"));
      expect(outside, file).toEqual([]);
      for (const pkg of node.packages) expect(pkg.startsWith("node:"), `${file} imports ${pkg}`).toBe(true);
    }
  });

  it("keeps integrations from depending on export", () => {
    for (const [file, node] of graph) {
      if (!file.startsWith("integrations/")) continue;
      expect(node.local.filter((dep) => dep.startsWith("export/")), file).toEqual([]);
    }
  });

  it("keeps the bb SDK to the modules that talk to bb", () => {
    const allowed = new Set([
      "server.ts",
      "cli.ts",
      "export/read.ts",
      "export/types.ts",
      "integrations/providers/rpc.ts",
      "integrations/workflows/client.ts",
    ]);
    for (const [file, node] of graph) {
      if (node.packages.includes("@get-bb/plugin-sdk")) expect(allowed.has(file), file).toBe(true);
    }
  });
});
