import { GET as identityCallback } from '../identity/[...action].ts';
import type { APIRoute } from 'astro';

export const prerender = false;

// The registered Google redirect, kept for clients that still hold it: the
// identity callback does the work.
export const GET: APIRoute = async (context) => identityCallback({ ...context, params: { action: 'google/callback' } });
