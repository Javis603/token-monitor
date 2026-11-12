'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHomeDom = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  // Remember renderer output, not live attributes: event handlers own additions
  // such as hover classes, popover placement, marquee transforms and drag state.
  function create({ nodesFor = () => [] } = {}) {
    const rendered = new WeakMap();
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
      return `${node.namespaceURI}:${node.localName}:${node.dataset.key ?? node.dataset.d ?? node.id ?? ''}:${node.classList[0] || ''}`;
    }
    function patch(current, next) {
      if (current.nodeType !== 1) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return current;
      }
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
      const available = new Map();
      for (const child of previous.children) {
        const id = key(child);
        if (!available.has(id)) available.set(id, []);
        available.get(id).push(child);
      }
      const children = [...next.childNodes].map(child => {
        const retained = available.get(key(child))?.shift();
        return retained ? patch(retained, child) : remember(child);
      });
      const ordered = children.flatMap(child => [child, ...nodesFor(child)]);
      ordered.forEach((child, index) => {
        const before = current.childNodes[index] || null;
        if (before === child) return;
        if (child.parentNode === current && current.moveBefore) current.moveBefore(child, before);
        else current.insertBefore(child, before);
      });
      // Only remove renderer-owned nodes, never plugin siblings.
      for (const child of previous.children) if (!children.includes(child)) child.remove();
      rendered.set(current, { attributes: nextAttributes, styles: nextStyles, children });
      return current;
    }
    function reconcile(current, next) {
      return current ? patch(current, next) : remember(next);
    }
    return { reconcile };
  }
  return { create };
});
