'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDomReconcile = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  // Remember renderer output, not live attributes: event handlers own additions
  // such as hover classes, popover placement, marquee transforms and drag state.
  // Event handlers may read current render data without capturing an old DTO.
  const renderData = new WeakMap();
  function data(node, value) {
    if (arguments.length > 1) renderData.set(node, value);
    return renderData.get(node);
  }
  function create({ nodesFor = () => [] } = {}) {
    // This reconciles renderer-owned reading surfaces. Key lists by logical
    // identity and change data-dom-kind when listener capability changes.
    // Retained listeners must read current data() or the live DOM. Resolve
    // staged references before post-commit layout work; clear stable hosts on exit.
    const rendered = new WeakMap();
    const retainedNodes = new WeakMap();
    const resolve = node => retainedNodes.get(node) || node;
    const attributes = node => new Map(Array.from(node.attributes, attr => [attr.name, attr.value]));
    const styles = node => new Map(Array.from(node.style || [], name => [name, [node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]]));
    function remember(node) {
      if (node.nodeType === 1) rendered.set(node, { attributes: attributes(node), styles: styles(node), children: [...node.childNodes] });
      node.childNodes.forEach(remember);
      return node;
    }
    function key(node) {
      if (node.nodeType !== 1) return `#${node.nodeType}`;
      // Explicit keys identify changing lists; the first class identifies fixed
      // structural slots, independently of optional siblings or runtime classes.
      const identity = node.dataset.key ?? node.dataset.exchangeKey ?? node.dataset.focusKey ?? node.dataset.limitMotionKey ?? node.dataset.usageItem ?? node.dataset.d ?? (node.id || undefined);
      return `${node.namespaceURI}:${node.localName}:${identity === undefined ? `slot:${node.classList[0] || ''}` : `key:${identity}`}:${node.dataset.domKind || ''}:${node.dataset.limitHistory || ''}`;
    }
    function patch(current, next) {
      if (current === next) return current;
      if (current.nodeType !== 1) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return current;
      }
      retainedNodes.set(next, current);
      if (renderData.has(next)) renderData.set(current, renderData.get(next));
      const previous = rendered.get(current);
      const nextAttributes = attributes(next), nextStyles = styles(next);
      for (const name of new Set([...previous.attributes.keys(), ...nextAttributes.keys()])) {
        const before = previous.attributes.get(name), after = nextAttributes.get(name);
        if (before === after || name === 'style') continue;
        if (name === 'class') {
          const oldTokens = new Set((before || '').split(/\s+/).filter(Boolean));
          const newTokens = new Set((after || '').split(/\s+/).filter(Boolean));
          for (const token of oldTokens) if (!newTokens.has(token)) current.classList.remove(token);
          for (const token of newTokens) if (!oldTokens.has(token)) current.classList.add(token);
        } else if (after === undefined) current.removeAttribute(name);
        else current.setAttribute(name, after);
      }
      for (const name of new Set([...previous.styles.keys(), ...nextStyles.keys()])) {
        const before = previous.styles.get(name), after = nextStyles.get(name);
        if (before?.[0] === after?.[0] && before?.[1] === after?.[1]) continue;
        if (after) current.style.setProperty(name, ...after);
        else current.style.removeProperty(name);
      }
      const children = reconcileChildren(current, [...next.childNodes]);
      rendered.set(current, { attributes: nextAttributes, styles: nextStyles, children });
      return current;
    }
    function placeChildren(current, children, previous = [...current.childNodes]) {
      const ordered = children.flatMap(child => [child, ...nodesFor(child)]);
      ordered.forEach((child, index) => {
        const before = current.childNodes[index] || null;
        if (before === child) return;
        if (child.parentNode === current && current.moveBefore) current.moveBefore(child, before);
        else current.insertBefore(child, before);
      });
      for (const child of previous) if (!ordered.includes(child)) child.remove();
      const record = rendered.get(current);
      if (record) {
        for (const child of children) if (child.nodeType === 1 && !rendered.has(child)) remember(child);
        rendered.set(current, { ...record, children });
      }
    }
    function reconcileChildren(current, nodes) {
      if (!rendered.has(current)) remember(current);
      const previous = rendered.get(current);
      const available = new Map();
      for (const child of previous.children) {
        const id = key(child);
        if (!available.has(id)) available.set(id, []);
        available.get(id).push(child);
      }
      const children = nodes.map(child => {
        const retained = available.get(key(child))?.shift();
        return retained ? patch(retained, child) : remember(child);
      });
      // Only remove renderer-owned nodes, never plugin siblings.
      placeChildren(current, children, previous.children);
      rendered.set(current, { ...previous, children });
      return children;
    }
    function reconcile(current, next) {
      return current ? patch(current, next) : remember(next);
    }
    // Call when a view is retired, so a stable host does not retain its old tree.
    function clear(current) { current.replaceChildren(); rendered.delete(current); }
    return { reconcile, reconcileChildren, placeChildren, resolve, clear };
  }
  return { create, data };
});
