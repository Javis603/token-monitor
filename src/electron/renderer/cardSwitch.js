'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCardSwitch = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createCardSwitch({ contentLayer, scrollSelector, enabled = () => true, reducedMotion,
    isHidden = () => document.visibilityState === 'hidden', readOpacity = node => getComputedStyle(node).opacity }) {
    let cardSwitchMotion = null;

    function clearCardSwitch() {
      const motion = cardSwitchMotion;
      cardSwitchMotion = null;
      if (!motion) return;
      motion.incoming.cancel();
      motion.outgoing.cancel();
      motion.ghost.remove();
    }

    function captureCardSwitch(previous, sameCard, opening = false) {
      if (!enabled() || !previous || opening || reducedMotion() || isHidden()) {
        clearCardSwitch();
        return null;
      }
      if (sameCard) {
        if (!cardSwitchMotion) return null;
        // A live reading can rebuild this card halfway through the switch. Carry
        // the existing timeline onto its replacement instead of snapping/restarting.
        cardSwitchMotion.elapsed = cardSwitchMotion.incoming.currentTime;
        cardSwitchMotion.incoming.cancel();
        return cardSwitchMotion;
      }
      if (cardSwitchMotion) {
        // A rapid selection takes over immediately. Restarting from the partially
        // transparent incoming card would discard the still-visible outgoing one.
        clearCardSwitch();
        return null;
      }
      const ghost = previous.cloneNode(true);
      const opacity = readOpacity(previous);
      const scrollTops = [...previous.querySelectorAll(scrollSelector)].map(list => list.scrollTop);
      clearCardSwitch();
      ghost.inert = true;
      ghost.setAttribute('aria-hidden', 'true');
      ghost.removeAttribute('id');
      for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
      // offsetLeft/Top already include layout margins; do not apply them twice.
      Object.assign(ghost.style, { position: 'absolute', top: `${previous.offsetTop || 0}px`, left: `${previous.offsetLeft || 0}px`, margin: '0', pointerEvents: 'none' });
      return { ghost, opacity, scrollTops, elapsed: 0 };
    }

    function animateCardSwitch(card, motion) {
      if (!motion) return;
      // Both readings travel together with the painted frame.
      // Crossfade the content without scaling its text.
      contentLayer.append(motion.ghost);
      [...motion.ghost.querySelectorAll(scrollSelector)].forEach((list, index) => {
        list.scrollTop = motion.scrollTops[index];
      });
      const timing = { duration: 160, easing: 'ease-in-out', fill: 'both' };
      motion.incoming = card.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      motion.incoming.currentTime = motion.elapsed;
      if (!motion.outgoing) {
        motion.outgoing = motion.ghost.animate([{ opacity: motion.opacity }, { opacity: 0 }], timing);
        motion.outgoing.finished.then(() => {
          if (cardSwitchMotion === motion) clearCardSwitch();
        }, () => {});
      }
      cardSwitchMotion = motion;
    }

    return { capture: captureCardSwitch, play: animateCardSwitch, cancel: clearCardSwitch };
  }
  return { createCardSwitch };
});
