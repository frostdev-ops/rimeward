import type { APIRoute } from 'astro';
export const prerender = false;
export const GET: APIRoute = async ({ redirect }) => redirect('/api/auth/identity/google',303);
