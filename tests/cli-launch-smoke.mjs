// Optional local acceptance check; requires installed CLIs. It opens their
// interactive interfaces, sends no task/input, and makes no model requests.
import "./_setup.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.RIMEWARD_DESKTOP = "1";
process.env.RIMEWARD_NATIVE_TOKEN = "test-only";
const { addProject } = await import("../src/lib/dev/projects.ts");
const { startSession, readSession, closeSession, terminalCapabilities } =
  await import("../src/lib/dev/terminals.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-cli-test-"));
const project = addProject(1, root);
const caps = terminalCapabilities();
let failures = 0;
try {
  for (const kind of ["codex", "claude"]) {
    if (!caps.agents[kind]) {
      console.log(
        kind +
          ": missing; install and authenticate locally before release validation.",
      );
      failures++;
      continue;
    }
    for (const mode of ["human", "rimeward", "yolo"]) {
      const session = await startSession(1, {
        project: project.id,
        kind,
        mode,
      });
      try {
        await new Promise((r) => setTimeout(r, 3500));
        const result = readSession(1, session.id);
        const rendered = result.screen.trim().length > 0;
        console.log(
          `${kind} ${mode}: ${result.session.state}, interactive screen ${rendered ? "rendered" : "empty"}`,
        );
        if (result.session.state !== "running" || !rendered) failures++;
      } finally {
        try {
          await closeSession(1, session.id);
        } catch {}
      }
    }
  }
} finally {
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
