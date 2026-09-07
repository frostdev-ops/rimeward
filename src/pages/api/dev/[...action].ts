import type { APIRoute } from "astro";
import {
  DevError,
  requireDesktop,
  subscribeDev,
  workDb,
} from "../../../lib/dev/runtime.ts";
import {
  getDashboard,
  getPages,
  saveDashboard,
} from "../../../lib/dashboard.ts";
import { validateLayout, validatePages } from "../../../lib/wards.ts";
import {
  remotePairs,
  desktopNavigation,
  navigateWorkspace,
  previewPair,
  pairDesktop,
  unpairDesktop,
  beginSignIn,
  pollSignIn,
  cancelSignIn,
  openSignIn,
  openServer,
  onboarding,
  completeOnboarding,
  nativeDesktop,
  rimeConnection,
} from "../../../lib/dev/remote.ts";
import crypto from "node:crypto";
import { serveDeviceTool } from '../../../lib/dev/tool-routing.ts';
import { controlSettings, configureControl } from '../../../lib/dev/computer.ts';
import { analyzeFile } from "../../../lib/dev/lint.ts";
import {
  addProject,
  createProject,
  defaultProjectParent,
  projectOf,
  listProjects,
  tree,
  createFile,
  renameFile,
  searchFiles,
  readBuffer,
  editBuffer,
  bufferCopies,
  keepBufferCopy,
  gitView,
  worktreeOp,
} from "../../../lib/dev/projects.ts";
import {
  restartSession,
  releaseControl,
  terminalCapabilities,
  listSessions,
  startSession,
  readSession,
  controlSession,
  writeSession,
  resizeSession,
  interruptSession,
  closeSession,
  configureSession,
} from "../../../lib/dev/terminals.ts";

export const prerender = false;
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "cache-control": "no-store", "x-rimeward-private": "1" },
  });
export const ALL: APIRoute = async ({ params, request, locals, url }) => {
  try {
    if (!locals.user) throw new DevError("Sign in required.", 401);
    requireDesktop();
    const user = locals.user.userId,
      action = params.action ?? "";
    if (action === 'agent-tools' && request.method === 'POST') return await serveDeviceTool(user, request);
    if (action === 'control-settings') {
      if (request.headers.has('x-rimeward-native-token')) throw new DevError('Change control permissions in the local desktop window.', 403);
      if (request.method === 'GET') return json(await controlSettings(user));
      if (request.method === 'POST') return json(await configureControl(user, await request.json()));
    }
    const body =
      request.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : await request.json();
    const project = String(body.project ?? ""),
      file = String(body.path ?? ""),
      id = String(body.id ?? "");
    const owner =
      typeof body.owner === "string" && body.owner.startsWith("client:")
        ? body.owner
        : "";
    if (action === "events" && request.method === "GET") {
      let stop: () => void = () => {};
      let timer: ReturnType<typeof setInterval>;
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          let ended = false;
          const end = () => {
            if (ended) return;
            ended = true;
            stop();
            clearInterval(timer);
            try {
              controller.close();
            } catch {}
          };
          const send = (text: string) => {
            if (ended) return;
            // A slow/offline reader reconnects to a snapshot instead of growing
            // an unbounded queue or blocking every other terminal.
            if ((controller.desiredSize ?? 0) <= 0) { end(); return; }
            try {
              controller.enqueue(enc.encode(text));
            } catch {
              end();
            }
          };
          stop = subscribeDev(user, (event) =>
            send(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`),
          );
          timer = setInterval(() => send(": heartbeat\n\n"), 15_000);
          request.signal.addEventListener("abort", end, { once: true });
          if (request.signal.aborted) end();
        },
        cancel() {
          stop();
          clearInterval(timer);
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: 512 * 1024 }));
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        },
      });
    }
    if (request.method === "GET") {
      if (action === "navigation") return json(await desktopNavigation(user));
      if (action === "onboarding") return json(await onboarding(user));
      if (action === "project-defaults")
        return json({ parent: defaultProjectParent() });
      if (action === "view")
        return json(
          JSON.parse(
            (
              workDb()
                .prepare(
                  "SELECT json FROM ward_state WHERE user_id=? AND ward=?",
                )
                .get(user, id) as { json: string } | undefined
            )?.json ?? "{}",
          ),
        );
      if (action === "pairings") return json(await remotePairs(user));
      if (action === "capabilities") return json(terminalCapabilities());
      if (action === "projects") return json(listProjects(user));
      if (action === "files") return json(tree(user, project, file));
      if (action === "search")
        return json(await searchFiles(user, project, String(body.q ?? "")));
      if (action === "buffer") return json(readBuffer(user, project, file));
      if (action === "copies") return json(bufferCopies(user, project, file));
      if (action === "git") return json(await gitView(user, project));
      if (action === "sessions")
        return json(
          id
            ? readSession(
                user,
                id,
                body.after === undefined ? undefined : Number(body.after),
              )
            : listSessions(user, project || undefined),
        );
    }
    if (request.method === "POST") {
      if (action === "navigate") return json(await navigateWorkspace(user, String(body.runtime ?? ""), body.page ?? undefined, body.screen ?? undefined));
      if (action === "sign-in-start")
        return json(await beginSignIn(user, body.server));
      if (action === "sign-in-poll") return json(await pollSignIn(user, id));
      if (action === "sign-in-open") return json(await openSignIn(user, id));
      if (action === "sign-in-cancel") return json(cancelSignIn(user, id));
      if (action === "open-server") return json(await openServer(user, id));
      if (action === "onboard")
        return json(
          await completeOnboarding(user, String(body.home ?? "local")),
        );
      if (action === "folder")
        return json({ path: await nativeDesktop("folder") });
      if (action === "pair-preview")
        return json(await previewPair(user, body.server, body.code));
      if (action === "pair")
        return json(await pairDesktop(user, body.server, body.code, body.name));
      if (action === "unpair") return json(await unpairDesktop(user, body.id));
      if (action === "view") {
        if (!getDashboard(user).some((w) => w.i === id))
          throw new DevError("Ward not found.", 404);
        const value = JSON.stringify(body.value);
        if (value.length > 16_384)
          throw new DevError("View state is too large.");
        workDb()
          .prepare(
            "INSERT INTO ward_state VALUES(?,?,?) ON CONFLICT(user_id,ward) DO UPDATE SET json=excluded.json",
          )
          .run(user, id, value);
        return json({ ok: true });
      }
      if (action === "preset" || action === "open-project") {
        const p = project
          ? projectOf(user, project)
          : addProject(user, String(body.root ?? ""));
        const existing = getPages(user).find((page) => page.project === p.id && getDashboard(user).some((w) => w.type === "editor" && w.page === page.id));
        if (existing) return json({ page: existing.id });
        const page = `p${crypto.randomBytes(4).toString("hex")}`;
        const device = (await rimeConnection(user))?.id;
        const pages = validatePages([
          ...getPages(user),
          { id: page, title: p.name, project: p.id, device },
        ]);
        const types = [
          "editor",
          "agent",
          "terminal",
          "changes",
        ];
        const layout = validateLayout(
          [
            ...getDashboard(user),
            ...types.map((type) => ({
              i: `w${crypto.randomBytes(4).toString("hex")}`,
              type,
              page,
              device,
              size: type === "editor" ? "4x4" : type === "agent" ? "2x4" : "3x2",
            })),
          ],
          pages ?? undefined,
        );
        if (!pages || !layout)
          throw new DevError(
            "The dashboard is full. Remove a page or ward first.",
          );
        saveDashboard(user, layout, pages);
        return json({ page });
      }
      if (action === "projects")
        return json(
          body.create === true
            ? createProject(
                user,
                String(body.parent ?? ""),
                String(body.name ?? ""),
              )
            : addProject(user, String(body.root ?? ""), body.name),
          201,
        );
      if (action === "files") {
        createFile(user, project, file, body.directory === true);
        return json({ ok: true });
      }
      if (action === "rename") {
        renameFile(user, project, file, String(body.to ?? ""));
        return json({ ok: true });
      }
      if (action === "buffer")
        return json(editBuffer(user, project, file, owner, body));
      if (action === "copies")
        return json(keepBufferCopy(user, project, file, body.text));
      if (action === "lint" || action === "format")
        return json(await analyzeFile(user, project, file, body.text, action === "format"));
      if (action === "worktree")
        return json(
          await worktreeOp(
            user,
            project,
            body.op === "remove" ? "remove" : "add",
            String(body.name ?? ""),
          ),
        );
      if (action === "sessions")
        return json(await startSession(user, body), 201);
      if (action === "restart") return json(await restartSession(user, id));
      if (action === "release") return json(releaseControl(user, id, owner));
      if (action === "control")
        return json(controlSession(user, id, owner, body.takeover === true));
      if (action === "input") {
        writeSession(user, id, owner, String(body.data ?? ""), body.binary === true);
        return json({ ok: true });
      }
      if (action === "resize") {
        resizeSession(user, id, owner, Number(body.cols), Number(body.rows));
        return json({ ok: true });
      }
      if (action === "interrupt") {
        interruptSession(user, id, owner);
        return json({ ok: true });
      }
      if (action === "configure") return json(configureSession(user, id, body));
    }
    if (request.method === "DELETE" && action === "sessions") {
      closeSession(user, id);
      return json({ ok: true });
    }
    return json({ error: "Unknown workspace operation." }, 404);
  } catch (err) {
    return json(
      {
        error:
          err instanceof DevError
            ? err.message
            : "The workspace operation failed.",
      },
      err instanceof DevError ? err.status : 400,
    );
  }
};
