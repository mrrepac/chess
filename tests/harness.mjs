/**
 * A test harness with no test framework in it — same shape as
 * songwriter-player/tests/harness.mjs. Bundles the real source the way it
 * ships (esbuild, `obsidian` external) and runs it, so a test cannot quietly
 * drift from what gets installed.
 */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);

export async function bundle(entry, define = {}) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "cjs",
    // chess.js uses BigInt literals (Zobrist hashing) internally
    target: "es2020",
    external: ["obsidian"],
    logLevel: "warning",
    write: false,
    define
  });
  return result.outputFiles[0].text;
}

export function load(source, { modules = {}, globals = {} } = {}) {
  const names = Object.keys(globals);
  const module = { exports: {} };
  const require = (id) => (id in modules ? modules[id] : nodeRequire(id));
  const run = new Function(
    "require", "module", "exports", ...names,
    `${source}\nreturn module.exports;`
  );
  run(require, module, module.exports, ...names.map((name) => globals[name]));
  return module.exports;
}

export function suite(name) {
  const results = [];
  return {
    check(label, condition, note = "") {
      let pass = false;
      let thrown = "";
      try {
        pass = typeof condition === "function" ? !!condition() : !!condition;
      } catch (e) {
        thrown = `threw: ${e?.message ?? e}`;
      }
      results.push({ label, pass, note: thrown || note });
    },
    report() {
      console.log(`\n${name}`);
      for (const r of results) {
        console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}${r.note ? `  — ${r.note}` : ""}`);
      }
      const failed = results.filter((r) => !r.pass).length;
      if (failed > 0) console.log(`  ${failed} of ${results.length} failed`);
      return failed === 0;
    }
  };
}
