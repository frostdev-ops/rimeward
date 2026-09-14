import type { APIRoute } from "astro";
import {
  listDevices,
  enroll,
  enrollment,
  claimEnrollment,
  revoke,
} from "../../../lib/dev/devices.ts";
import { DevError, isDesktop } from "../../../lib/dev/runtime.ts";
import {
  beginDeviceAuth,
  pollDeviceAuth,
  deviceServerSession,
  authenticatedDevice,
  limitDeviceAuth,
} from "../../../lib/dev/device-auth.ts";
import { runtimeNavigation } from "../../../lib/dev/navigation.ts";
import { clientIp } from "../../../lib/net-guard.ts";
export const ALL: APIRoute = async ({
  params,
  request,
  locals,
  clientAddress,
}) => {
  try {
    if (isDesktop())
      throw new DevError("Pairing is managed on the remote server.", 403);
    const action = params.action ?? "";
    const body = request.method === "GET" ? {} : await request.json();
    let value: unknown;
    if (request.method === "POST" && action === "authorize") {
      limitDeviceAuth(`start:${clientIp(request, clientAddress)}`, 10);
      value = beginDeviceAuth(body.name, body.platform, body.protocol);
    } else if (request.method === "POST" && action === "token") {
      value = pollDeviceAuth(body.device_code);
    } else if (request.method === "GET" && action === "navigation") {
      if (request.headers.has("origin")) throw new DevError("Native connection required.", 403);
      const device = authenticatedDevice(request.headers.get("authorization")?.replace(/^Bearer /, ""));
      value = { ...runtimeNavigation(device.user_id), devices: listDevices(device.user_id) };
    } else if (request.method === "POST" && action === "session") {
      if (request.headers.has("origin"))
        throw new DevError("Native connection required.", 403);
      value = deviceServerSession(
        request.headers.get("authorization")?.replace(/^Bearer /, ""),
      );
    } else if (request.method === "POST" && action === "preview")
      value = { email: enrollment(body.code).email };
    else if (request.method === "POST" && action === "claim")
      value = claimEnrollment(
        body.code,
        body.name,
        body.platform,
        body.protocol,
      );
    else if (!locals.user)
      throw new DevError("Sign in to manage desktops.", 401);
    else if (request.method === "GET" && action === "list")
      value = listDevices(locals.user.userId);
    else if (request.method === "POST" && action === "enroll")
      value = enroll(locals.user.userId);
    else if (request.method === "DELETE" && action === "revoke") {
      revoke(locals.user.userId, body.id);
      value = { ok: true };
    } else throw new DevError("Unknown device operation.", 404);
    return Response.json(value, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json(
      { error: e instanceof DevError ? e.message : "Device operation failed." },
      {
        status: e instanceof DevError ? e.status : 400,
        headers: { "cache-control": "no-store" },
      },
    );
  }
};
