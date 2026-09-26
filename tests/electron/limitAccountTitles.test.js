'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const {
  accountEmailLabel,
  accountTitleLabel,
  codexAccountDisplayLabel,
  maskEmailAddress
} = require('../../src/electron/renderer/accountIdentity');
const limitWindowLabels = require('../../src/shared/limitWindowLabels');

const TITLE_FUNCTIONS = [
  'limitAccountTitle',
  'limitAccountEmailsMasked',
  'limitAccountDefaultTitle',
  'codexAccountTitle',
  'opencodeAccountTitle',
  'namedApiAccountTitle',
  'planAccountTitle',
  'mimoAccountTitle'
];

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

// Brace-matches a declaration out of the renderer script. Parameter lists can
// hold braces of their own (`colors = {}`), so the body starts after the
// signature's closing parenthesis.
function balancedBlock(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} should exist`);
  let bodyStart = start;
  if (header.endsWith('(')) {
    let parens = 1;
    let i = start + header.length;
    for (; i < source.length && parens > 0; i += 1) {
      if (source[i] === '(') parens += 1;
      if (source[i] === ')') parens -= 1;
    }
    bodyStart = i;
  }
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${header} should close`);
}

// The title resolver is the shared view's, because the limits panel, the Home
// cards and the Edge Dock card all render through it. It is a plain browser
// script, so run the title functions (plus the provider table they dispatch
// through) in a sandbox instead of loading the DOM.
function runTitle(source, expression, context = {}) {
  const snippets = TITLE_FUNCTIONS.map((name) => balancedBlock(source, `function ${name}(`));
  snippets.unshift(balancedBlock(source, 'const LIMIT_ACCOUNT_TITLES = {'));
  return vm.runInNewContext(`${snippets.join('\n')}\n${expression}`, context);
}

function titleContext(maskLimitAccountEmails) {
  return {
    accountIdentity: { accountEmailLabel, accountTitleLabel, codexAccountDisplayLabel, maskEmailAddress },
    // MiMo's title path takes the product words from the shared display
    // vocabulary, the way the view receives them from its host.
    mimoProductLabel: limitWindowLabels.mimoProductLabel,
    isMimoMembershipProduct: limitWindowLabels.isMimoMembershipProduct,
    settings: () => ({ maskLimitAccountEmails }),
    t: (key) => (key === 'settings.codex.personalWorkspace' ? 'Personal' : key)
  };
}

test('account email masking is applied by the shared limits title resolver', () => {
  const view = readRendererFile('limits/windowsView.js');

  assert.equal(maskEmailAddress('primary.user@example.com'), 'p***r@example.com');
  assert.equal(maskEmailAddress('secondary.user@example.com'), 's***r@example.com');
  assert.equal(maskEmailAddress('ab@example.com'), 'a***b@example.com');

  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('claude', { accountEmail: 'primary.user@example.com' }, 0)",
      titleContext(false)
    ),
    'primary.user@example.com'
  );
  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('claude', { accountEmail: 'primary.user@example.com' }, 0)",
      titleContext(true)
    ),
    'p***r@example.com'
  );
  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('codex', { accountEmail: 'primary.user@example.com' }, 0)",
      titleContext(true)
    ),
    'p***r@example.com'
  );
  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('future-provider', { accountEmail: 'secondary.user@example.com' }, 0)",
      titleContext(true)
    ),
    's***r@example.com'
  );
});

// The Home cards used to keep their own provider branches and leaked raw Claude
// addresses while the limits panel masked them. Every provider now resolves
// through one table, and a provider that is missing from it must still mask.
test('no limits provider can render a raw account email while masking is on', () => {
  const view = readRendererFile('limits/windowsView.js');
  const providers = [...LIMIT_PROVIDER_IDS, 'future-provider'];

  for (const id of providers) {
    for (const account of [
      { accountEmail: 'primary.user@example.com' },
      { accountEmail: 'primary.user@example.com', accountName: 'Acme Team' },
      { accountEmail: 'primary.user@example.com', accountLabel: 'Pro' }
    ]) {
      const title = runTitle(
        view,
        `limitAccountTitle('${id}', ${JSON.stringify(account)}, 0)`,
        titleContext(true)
      );
      assert.doesNotMatch(
        title,
        /primary\.user/,
        `${id} should not render a raw account email`
      );
    }
  }
});

test('title resolution matches between the limits panel and Home', () => {
  const app = readRendererFile('app.js');
  const view = readRendererFile('limits/windowsView.js');
  const dock = readRendererFile('edgeDock/dock.js');
  // Every surface resolves account titles through the one function, and it is
  // called from exactly one place per surface: the view's own group builder,
  // the page's Home/tray path, and the card's card builder. No provider branch
  // is left to disagree with another.
  assert.match(view, /limitAccountTitle\(providerId, provider, index, providers\)/);
  assert.match(app, /limitAccountTitle\(id, provider, index, providerEntries\)/);
  assert.equal(dock.match(/limitAccountTitle/g), null, 'the card titles accounts through the view');
  for (const name of ['codexAccountTitle', 'opencodeAccountTitle', 'namedApiAccountTitle', 'planAccountTitle']) {
    assert.doesNotMatch(app, new RegExp(`${name}\\(provider, index`), `${name} should not be called from the page`);
  }
  // The tray renders account text outside the title resolver, so it reads the
  // same setting rather than its own.
  const customTrayLayout = balancedBlock(app, 'function renderCustomTrayLayout(');
  assert.match(customTrayLayout, /item\.metric === 'account'\s*&& state\.settings\?\.maskLimitAccountEmails === true/);
  assert.match(customTrayLayout, /state\.codexActiveAccount\?\.accountKey/);
  assert.match(customTrayLayout, /\[selectedCodexKey, detectedCodexKey\]\.find/);
  assert.match(customTrayLayout, /activeAccountKeys: activeCodexKey \? \{ codex: activeCodexKey \} : \{\}/);

  // Named-API providers keep their profile name on both surfaces.
  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('openrouter', { accountName: 'Team key' }, 0)",
      titleContext(true)
    ),
    'Team key'
  );
  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('thirdparty', { accountName: 'environment' }, 0)",
      titleContext(true)
    ),
    'settings.thirdparty.environment'
  );
  assert.equal(
    runTitle(
      view,
      "limitAccountTitle('opencode', { accountLabel: 'Zen' }, 1)",
      titleContext(true)
    ),
    'Account 2'
  );
});

// Masking collapses distinct addresses into one label, so rows that share a
// visible email must stay distinguishable without revealing what is hidden.
test('accounts sharing a visible email are disambiguated', () => {
  const view = readRendererFile('limits/windowsView.js');
  const titlesFor = (peers, mask) => peers.map((peer, index) => runTitle(
    view,
    `limitAccountTitle('claude', ${JSON.stringify(peer)}, ${index}, ${JSON.stringify(peers)})`,
    titleContext(mask)
  ));

  const named = [
    { accountEmail: 'javis@example.com', accountName: 'Personal' },
    { accountEmail: 'jonas@example.com' }
  ];
  assert.deepEqual(titlesFor(named, true), ['j***s@example.com · Personal', 'j***s@example.com']);
  // Unmasked those addresses already differ, so no suffix is added.
  assert.deepEqual(titlesFor(named, false), ['javis@example.com', 'jonas@example.com']);

  // The account name is not unique on its own: two masked addresses in the same
  // organization need the stable fingerprint on top of it.
  const sameOrg = [
    { accountEmail: 'javis@example.com', accountName: 'Acme', accountKey: 'sha256:abcdef123456' },
    { accountEmail: 'jonas@example.com', accountName: 'Acme', accountKey: 'sha256:abcdef654321' }
  ];
  assert.deepEqual(titlesFor(sameOrg, true), [
    'j***s@example.com · Acme · #abcdef1',
    'j***s@example.com · Acme · #abcdef6'
  ]);

  // A CLI-sourced key embeds the address, so the fingerprint hashes it instead of
  // echoing what masking just hid.
  const cliKeyed = [
    { accountEmail: 'javis@example.com', accountName: 'Acme', accountKey: 'javis@example.com|Acme' },
    { accountEmail: 'jonas@example.com', accountName: 'Acme', accountKey: 'jonas@example.com|Acme' }
  ];
  const cliTitles = titlesFor(cliKeyed, true);
  assert.notEqual(cliTitles[0], cliTitles[1]);
  for (const title of cliTitles) {
    assert.match(title, /^j\*\*\*s@example\.com · Acme · #[0-9a-f]{6}$/);
  }

  // Fingerprints follow the account, so reordering providers cannot swap suffixes.
  const reversed = titlesFor([...cliKeyed].reverse(), true);
  assert.deepEqual(reversed, [cliTitles[1], cliTitles[0]]);

  // Without any stable key the row index is the last resort.
  const keyless = [
    { accountEmail: 'javis@example.com', accountName: 'Acme' },
    { accountEmail: 'jonas@example.com', accountName: 'Acme' }
  ];
  assert.deepEqual(titlesFor(keyless, true), [
    'j***s@example.com · Acme · #1',
    'j***s@example.com · Acme · #2'
  ]);

  // A key that cannot separate the rows is no better than no key at all.
  const sharedKey = [
    { accountEmail: 'javis@example.com', accountName: 'Acme', accountKey: 'sha256:abcdef123456' },
    { accountEmail: 'jonas@example.com', accountName: 'Acme', accountKey: 'sha256:abcdef123456' }
  ];
  assert.deepEqual(titlesFor(sharedKey, true), [
    'j***s@example.com · Acme · #1',
    'j***s@example.com · Acme · #2'
  ]);
});

test('MiMo products keep their shared account identity in the title', () => {
  const view = readRendererFile('limitWindowsView.js');
  const peers = [
    { provider: 'mimo', accountName: 'MiMo account', accountLabel: 'Console', accountKey: 'sha256:abcdef123456' },
    { provider: 'mimo', accountName: 'MiMo account', accountLabel: 'Desktop Membership', accountKey: 'sha256:abcdef654321' }
  ];
  assert.deepEqual(peers.map((peer, index) => runTitle(
    view,
    `limitAccountTitle('mimo', ${JSON.stringify(peer)}, ${index}, ${JSON.stringify(peers)})`,
    titleContext(true)
  )), ['MiMo account · Console', 'MiMo account · Desktop Membership']);
  assert.equal(runTitle(
    view,
    `limitAccountTitle('mimo', ${JSON.stringify(peers[0])}, 0)`,
    titleContext(true)
  ), 'MiMo account · Console');
  assert.equal(runTitle(
    view,
    "limitAccountTitle('mimo', { accountName: 'Membership', accountLabel: 'Pro', accountKey: 'sha256:abcdef123456' }, 0)",
    titleContext(true)
  ), 'Membership');
});

test('accountEmailLabel keeps duplicate addresses apart regardless of masking', () => {
  const peers = [
    { accountEmail: 'member@example.com', accountName: 'Personal' },
    { accountEmail: 'member@example.com', accountName: 'Acme Team' }
  ];

  assert.equal(
    accountEmailLabel(peers[1], peers, { maskEmail: false, suffix: 'Acme Team' }),
    'member@example.com · Acme Team'
  );
  assert.equal(
    accountEmailLabel(peers[1], peers, { maskEmail: true, suffix: 'Acme Team' }),
    'm***r@example.com · Acme Team'
  );
  assert.equal(accountEmailLabel({ accountName: 'No email' }, peers, { maskEmail: true }), '');
  // Codex builds its workspace-aware label on the same primitive.
  assert.equal(
    codexAccountDisplayLabel(
      { accountEmail: 'member@example.com', workspaceKind: 'personal' },
      [
        { accountEmail: 'member@example.com', workspaceKind: 'personal' },
        { accountEmail: 'member@example.com', accountName: 'Acme Team' }
      ],
      { maskEmail: false, personalWorkspaceLabel: 'Personal' }
    ),
    'member@example.com · Personal'
  );
  assert.equal(
    accountEmailLabel({ accountEmail: 'solo@example.com' }, [{ accountEmail: 'solo@example.com' }], {
      maskEmail: false,
      suffix: 'Unused'
    }),
    'solo@example.com'
  );
});
