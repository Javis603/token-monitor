'use strict';

// Sanitized markup shapes from CodexBar's OllamaUsageParserTests and
// OllamaCreditWalletTests at d34fbb47afe73f81dd591bae28a60f72c39a9fe4.
// Values and identities below are fixtures, not account captures.
const monthly = `
<section>
  <h2><span>Included usage</span><span class="badge">pro</span
  ></h2>
  <h2 id="header-email">FIXTURE@example.com</h2>
  <div><span>Monthly usage</span><span>$7.50 of $60 used</span
  >
    <div data-usage-track aria-label="Monthly usage $7.50 of $60 used">
      <div style="width: 12.5%;"></div>
    </div>
    <p>Free usage credits can be used with the following cloud models:</p>
    <div data-time="2026-11-25T12:00:00Z">Resets in 4 weeks.</div>
  </div>
</section>`;

const free = monthly.replace('>pro</span', '>free</span')
  .replaceAll('Monthly usage', 'Free usage')
  .replaceAll('$7.50 of $60 used', '69.5% used').replace('12.5%', '69.5%');

const wallet = `
<section>
  <div><h2>Usage credits<span>pro</span></h2>
    <span>$18.25</span>
    <p>Refills to $30 in 3 weeks.</p>
  </div>
  <div><span>Monthly credits used</span><span>$4.50</span></div>
</section>`;

module.exports = { monthly, free, wallet };
