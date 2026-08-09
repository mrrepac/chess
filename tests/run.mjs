import engine from "./engine.test.mjs";
import smoke from "./smoke.test.mjs";
import controller from "./controller.test.mjs";

const suites = [engine, controller, smoke];

let ok = true;
for (const runSuite of suites) {
  try {
    const passed = await runSuite();
    ok = passed && ok;
  } catch (e) {
    console.log(`\n  CRASH  ${e?.stack ?? e}`);
    ok = false;
  }
}

console.log(ok ? "\nall checks passed\n" : "\nsome checks failed\n");
process.exit(ok ? 0 : 1);
