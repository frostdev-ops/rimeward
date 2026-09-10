/** A top-layer popup keeps modal ancestry for focus without inheriting clipping/transforms. */
export function popupLayer(host: HTMLElement): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'fd-popup-layer';
  layer.setAttribute('popover', 'manual');
  host.append(layer);
  if (typeof layer.showPopover === 'function') layer.showPopover();
  return layer;
}
export function popupViewport() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
  return { left, top, width, height, right: left + width, bottom: top + height };
}
export function popupFrame(host: HTMLElement) {
  if (typeof host.showPopover === 'function' && host.matches(':popover-open')) return { x: 0, y: 0, scale: 1 };
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;';
  host.append(probe); const rect = probe.getBoundingClientRect(); probe.remove();
  return { x: rect.left, y: rect.top, scale: rect.width ? rect.width / 100 : 1 };
}
