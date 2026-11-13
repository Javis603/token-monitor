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
    function describe(node) {
      let record = rendered.get(node);
      if (record) return record;
      const attrs = attributes(node);
      // Read identity from the same renderer snapshot as the diff, rather than
      // repeatedly crossing into live dataset/classList getters for each child.
      const identity = attrs.get('data-key') ?? attrs.get('data-exchange-key') ?? attrs.get('data-focus-key') ?? attrs.get('data-limit-motion-key') ?? attrs.get('data-usage-item') ?? attrs.get('data-d') ?? (attrs.get('id') || undefined);
      const slot = (attrs.get('class') || '').trim().split(/\s+/, 1)[0];
      const key = `${node.namespaceURI}:${node.localName}:${identity === undefined ? `slot:${slot}` : `key:${identity}`}:${attrs.get('data-dom-kind') || ''}:${attrs.get('data-limit-history') || ''}:${attrs.get('data-dom-island') || ''}`;
      record = { attributes: attrs, styles: styles(node), children: [...node.childNodes], key };
      rendered.set(node, record);
      return record;
    }
    function remember(node) {
      if (node.nodeType === 1) describe(node);
      node.childNodes.forEach(remember);
      return node;
    }
    function key(node) {
      if (node.nodeType !== 1) return `#${node.nodeType}`;
      return describe(node).key;
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
      const nextRecord = describe(next);
      const nextAttributes = nextRecord.attributes, nextStyles = nextRecord.styles;
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
      // An island owns its asynchronous children and their listeners. Its
      // identity must include every input: changed inputs replace the island.
      const children = nextAttributes.has('data-dom-island')
        ? previous.children : reconcileChildren(current, nextRecord.children);
      rendered.set(current, { ...nextRecord, children });
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
      // Scalar native writers can populate an empty node or replace its text
      // children. Adopt live output without disturbing structured controls.
      let owned = previous.children;
      if (nodes.every(child => child.nodeType === 3) && (
        (!previous.children.length && current.firstChild)
        || previous.children.some(child => child.parentNode !== current)
      )) {
        const outlets = new Set(previous.children.flatMap(child => nodesFor(child)));
        owned = [...current.childNodes].filter(child => !outlets.has(child));
      }
      const available = new Map();
      for (const child of owned) {
        const id = key(child);
        if (!available.has(id)) available.set(id, []);
        available.get(id).push(child);
      }
      const children = nodes.map(child => {
        const retained = available.get(key(child))?.shift();
        return retained ? patch(retained, child) : remember(child);
      });
      // Only remove renderer-owned nodes, never plugin siblings.
      placeChildren(current, children, owned);
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
