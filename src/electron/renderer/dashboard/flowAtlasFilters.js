// @ts-check
'use strict';

const dashboardFlowAtlasFilters = '<defs>'
  + '<filter id="dashTopoBeamGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4" result="b"></feGaussianBlur><feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter>'
  + '<filter id="dashTopoAmbientGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"></feGaussianBlur></filter>'
  + '</defs>';

Object.assign(window, { dashboardFlowAtlasFilters });
