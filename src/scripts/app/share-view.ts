// Am I a share view (/s/<id>, lib/shares.ts)? A leaf like dom.ts: imports nothing
// under scripts/app/. Inside one, the document runs as the OWNER on the server
// side and every same-origin /api request carries ?share=<id> (public/runtime-
// bridge.js); here the role decides what the surfaces let the visitor touch.
const main = document.querySelector<HTMLElement>('main[data-share]');
export const shareView: { id: string; role: 'view' | 'edit' } | null = main ? { id: main.dataset.share!, role: main.dataset.shareRole === 'edit' ? 'edit' : 'view' } : null;
/** A viewer of a share: documents read-only, the browser watched, never driven. */
export const shareReadOnly = !!shareView && shareView.role !== 'edit';
