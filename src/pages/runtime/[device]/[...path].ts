import type { APIRoute } from "astro";
import { relayRequest } from "../../../lib/dev/devices.ts";
import { DevError } from "../../../lib/dev/runtime.ts";
import { sessionId } from '../../../lib/auth.ts';
import { relayAgentCaller } from '../../../lib/dev/tool-routing.ts';
export const ALL: APIRoute = async ({ params, locals, request, url, cookies }) => {
  try {
    if (!locals.user) throw new DevError("Sign in required.", 401);
    return await relayRequest(
      locals.user.userId,
      params.device ?? "",
      // The still-encoded path: Astro decodes params, and a decoded space or non-ASCII char makes
      // http.request throw (502), while a decoded %2F/%3F/%23 would change the path on the next hop.
      (url.pathname.replace(/^\/runtime\/[^/]+/, "") || "/") + url.search,
      request,
      undefined,
      params.path === 'api/dev/agent-tools' ? await relayAgentCaller(locals.user.userId, sessionId(cookies), request.clone()) : undefined,
    );
  } catch (e) {
    // A document always has a way back. API/media callers keep the original error status.
    const status = e instanceof DevError ? e.status : 502;
    // Operators had no evidence of relay failures (nginx keeps these routes out of its logs on
    // purpose). Method, device and outcome only — never the relayed path or payload.
    if (status !== 499) console.warn(`[relay] ${request.method} device ${params.device} → ${status}`);
    if (request.method === "GET" && request.headers.get("accept")?.includes("text/html") && [502, 503, 504].includes(status)) {
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop disconnected · Rimeward</title><style>:root{color-scheme:dark light}body{font:16px/1.6 system-ui;margin:0;min-height:100dvh;display:grid;place-items:center;background:light-dark(#f7f9fb,#0d131b);color:light-dark(#182431,#e6edf5)}main{max-width:32rem;padding:2rem}h1{font-size:1.7rem;line-height:1.2}p{opacity:.75}a,button{display:inline-block;margin:.5rem .5rem .5rem 0;padding:.6rem 1rem;border:1px solid #7b93aa66;border-radius:.65rem;color:inherit;background:transparent;text-decoration:none;font:inherit;cursor:pointer}</style></head><body><main><p>RIMEWARD · LIVE WORKSPACE</p><h1>This computer is disconnected.</h1><p>Your work stays on that computer. Reopen Rimeward there to reconnect. Your server pages are still available.</p><button id="local-workspace" type="button" hidden>Open this computer</button><a href="/dash">Open server dashboard</a><button type="button" onclick="location.reload()">Try reconnecting</button><p>Reconnecting reads the current state. It does not resend commands.</p></main><script>const local=document.getElementById('local-workspace');if(window.__TAURI__?.core){local.hidden=false;local.onclick=async()=>{local.disabled=true;try{await window.__TAURI__.core.invoke('open_workspace',{runtime:'local'})}catch{local.textContent='Use Open this desktop in the app menu';local.disabled=false}}}</script></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }
    // JSON like every other API error: a desktop forwards this verbatim and its clients read {error}.
    return Response.json(
      { error: e instanceof DevError ? e.message : "Desktop unavailable." },
      { status, headers: { "cache-control": "no-store", "x-accel-buffering": "no" } },
    );
  }
};
