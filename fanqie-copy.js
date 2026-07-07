(() => {
  const FANQIE_HOST = "fanqienovel.com";
  const CONTENT_SELECTOR = ".muye-reader-content";
  const STYLE_ID = "fanqie-copy-unlock-style";

  if (location.hostname !== FANQIE_HOST) return;

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ${CONTENT_SELECTOR},
      ${CONTENT_SELECTOR} * {
        -webkit-user-select: text !important;
        user-select: text !important;
      }
    `;
    (document.head || document.documentElement)?.append(style);
  };

  const unlockContent = () => {
    injectStyle();
    for (const element of document.querySelectorAll(`${CONTENT_SELECTOR}.noselect`)) {
      element.classList.remove("noselect");
    }
  };

  const asElement = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
  const isReaderNode = (node) => Boolean(asElement(node)?.closest?.(CONTENT_SELECTOR));

  const isReaderSelection = () => {
    const selection = globalThis.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && (isReaderNode(selection.anchorNode) || isReaderNode(selection.focusNode)));
  };

  const stopReaderBlocker = (event) => {
    if (event.type === "copy" || event.type === "cut") {
      if (isReaderSelection()) event.stopImmediatePropagation();
      return;
    }

    if (isReaderNode(event.target)) event.stopImmediatePropagation();
  };

  unlockContent();

  for (const eventName of ["copy", "cut", "contextmenu", "selectstart", "dragstart"]) {
    globalThis.addEventListener?.(eventName, stopReaderBlocker, true);
  }

  new MutationObserver(unlockContent).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"]
  });
})();
