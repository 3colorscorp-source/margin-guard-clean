/**
 * Margin Guard smoke harness — visible/reachable DOM control helpers.
 * Test-only; not loaded by production pages.
 */

function isInsideClosedContainer(el) {
  let node = el;
  while (node && node !== document.documentElement) {
    if (node.nodeType !== 1) {
      node = node.parentElement;
      continue;
    }
    if (node.hasAttribute('hidden')) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    node = node.parentElement;
  }
  return false;
}

function isVisibleReachableControl(el) {
  if (!el) return false;
  if (el.disabled) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (Number(style.opacity) === 0) return false;
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (isInsideClosedContainer(el)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  const horizontallyReachable = rect.right > 0 && rect.left < viewportWidth;
  const verticallyReachable = rect.bottom > 0 && rect.top < viewportHeight * 2;

  if (!horizontallyReachable || !verticallyReachable) return false;

  return true;
}

function getVisibleReachableControls(selector, root) {
  const scope = root || document;
  const candidates = [...scope.querySelectorAll(selector)];
  return candidates.filter(isVisibleReachableControl);
}

function assertVisibleReachableControls(selector, root, minCount) {
  const visible = getVisibleReachableControls(selector, root);
  const required = typeof minCount === 'number' ? minCount : 1;
  return {
    ok: visible.length >= required,
    count: visible.length,
    required,
    samples: visible.slice(0, 5).map((el) => ({
      id: el.id || null,
      tag: el.tagName,
      className: el.className || '',
      width: Math.round(el.getBoundingClientRect().width),
      height: Math.round(el.getBoundingClientRect().height),
    })),
  };
}

function getVisibleReachableHelperSource() {
  return `(${function helperBundle() {
    function isInsideClosedContainer(el) {
      let node = el;
      while (node && node !== document.documentElement) {
        if (node.nodeType !== 1) {
          node = node.parentElement;
          continue;
        }
        if (node.hasAttribute('hidden')) return true;
        if (node.getAttribute('aria-hidden') === 'true') return true;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        node = node.parentElement;
      }
      return false;
    }

    function isVisibleReachableControl(el) {
      if (!el) return false;
      if (el.disabled) return false;

      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (Number(style.opacity) === 0) return false;
      if (el.hidden) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (isInsideClosedContainer(el)) return false;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

      const horizontallyReachable = rect.right > 0 && rect.left < viewportWidth;
      const verticallyReachable = rect.bottom > 0 && rect.top < viewportHeight * 2;

      if (!horizontallyReachable || !verticallyReachable) return false;

      return true;
    }

    return isVisibleReachableControl;
  }.toString()})()`;
}

module.exports = {
  isInsideClosedContainer,
  isVisibleReachableControl,
  getVisibleReachableControls,
  assertVisibleReachableControls,
  getVisibleReachableHelperSource,
};
