/** What this server's Rime contract supports, advertised on the device harness and read by a paired
 *  desktop (agent/sync.ts, agent/route.ts). A desktop that needs a guarantee this server does not
 *  advertise refuses the operation rather than degrading it silently.
 *
 *  providerScope 1 - /api/account/provider: destination-bound status and credential writes.
 *  routePin      1 - a relayed compat call honours an attested backend constraint at dispatch.
 */
export const PROVIDER_CONTRACT = { providerScope: 2, routePin: 2 } as const;
