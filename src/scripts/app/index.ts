import { bootStatus } from './status.ts';
import { bootWards } from './wards.ts';
import { bootPages } from './pages.ts';
import './mail.ts';
import './charts.ts';
import { ensureStream } from './logic.ts';
import './notion.ts';
import './agent.ts';
import './browser.ts';
import './remote-desktop.ts';
import './workspace.ts';
import './note.ts';
import './notebook.ts';
import './store.ts';
import './lens.ts';
import './mcp.ts';
import './chat.ts';
import { RENDERERS, body } from './wards.ts';
import { DEV_WARDS } from '../../lib/dev/types.ts';
for(const type of DEV_WARDS)RENDERERS[type]={render:async w=>{const target=body(w.i);await import('./development.ts');if(target?.isConnected && body(w.i)===target)return RENDERERS[type]!.render(w);}};
import { bootEdit } from './edit.ts';
import { bootLogicEdit } from './logic-edit.ts';
import './ward-window.ts';
import './presence.ts';
import { popoutWard } from './ward-view.ts';
import { shareView } from './share-view.ts';

// The entrance cascade is pure CSS (.wd-enter in frost.css, staggered via an
// inline animation-delay per shell). Never animate cards with WAAPI here: a
// lingering fill phase overrides every inline style.transform write and
// silently kills the drag engine's follow/FLIP/spring rendering.

// A share view without a status ward may not read the status stream (lib/shares.ts): asking would only loop on 403.
if ((!shareView && !popoutWard) || document.querySelector('[data-wd-type="service-group"], [data-wd-type="incidents"], [data-wd-type="chart"]')) bootStatus();
bootPages(); // stages the current page before any ward boots
ensureStream(); // layout and theme updates also reach pages with only development wards
bootWards();
// A share view is the owner's wards as a visitor sees them: nothing to arrange or wire.
if (!shareView) {
  bootEdit();
  if (!popoutWard) bootLogicEdit();
  if (new URL(location.href).searchParams.has('add-workspace')) {
    const url = new URL(location.href); url.searchParams.delete('add-workspace'); history.replaceState(null, '', url);
    void import('./workspace.ts').then(m => m.configureWorkspace());
  }
}
