// Installed before any desktop application script, only inside a relayed document.
// Every same-origin application request stays on the selected runtime.
(() => {
  const base = document.querySelector(
    'meta[name="rimeward-runtime-base"]',
  )?.content;
  if (!base) return;
  const map = (value) => {
    if (typeof value !== "string") value = String(value);
    if (
      value.startsWith("#") ||
      value.startsWith("data:") ||
      value.startsWith("blob:")
    )
      return value;
    const u = new URL(value, location.href);
    if (u.origin !== location.origin || u.pathname.startsWith("/runtime/") || u.pathname.startsWith("/api/remote-desktop/"))
      return value;
    return base + u.pathname + u.search + u.hash;
  };
  const srcset = (value) =>
    String(value)
      .split(",")
      .map((part) => {
        const [url, ...size] = part.trim().split(/\s+/);
        return [map(url), ...size].join(" ");
      })
      .join(", ");
  const originalFetch = window.fetch.bind(window);
  window.rimewardServerFetch = originalFetch;
  window.fetch = (resource, options) =>
    originalFetch(
      resource instanceof Request
        ? new Request(map(resource.url), resource)
        : map(resource),
      options,
    );
  const OriginalEvents = window.EventSource;
  window.EventSource = class extends OriginalEvents {
    constructor(url, options) {
      super(map(url), options);
    }
  };
  // Media, module-preload links and navigation do not use fetch(). Keep their
  // native setters, changing only the selected-runtime URL before loading.
  for (const [type, properties] of [
    [HTMLImageElement, ["src", "srcset"]],
    [HTMLScriptElement, ["src"]],
    [HTMLLinkElement, ["href"]],
    [HTMLAnchorElement, ["href"]],
    [HTMLIFrameElement, ["src"]],
    [HTMLMediaElement, ["src"]],
    [HTMLSourceElement, ["src"]],
    [HTMLFormElement, ["action"]],
  ])
    for (const prop of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(type.prototype, prop);
      if (!descriptor?.set) continue;
      Object.defineProperty(type.prototype, prop, {
        ...descriptor,
        set(value) {
          descriptor.set.call(
            this,
            prop === "srcset" ? srcset(value) : map(value),
          );
        },
      });
    }
  const css = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
    return css.call(
      this,
      name,
      typeof value === "string"
        ? value.replace(
            /url\(["']?(\/[^)"']+)["']?\)/g,
            (_, url) => `url(${JSON.stringify(map(url))})`,
          )
        : value,
      priority,
    );
  };
  const attr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return attr.call(
      this,
      name,
      name.toLowerCase() === "srcset"
        ? srcset(value)
        : /^(?:src|href|action|poster)$/i.test(name)
          ? map(value)
          : value,
    );
  };
  document.addEventListener(
    "click",
    (event) => {
      const a = event.target?.closest?.("a[href]");
      if (a && !a.hasAttribute("data-server-link")) {
        const value = a.getAttribute("href");
        if (value) a.href = map(value);
      }
    },
    true,
  );
  window.rimewardRuntimeUrl = map;
})();
