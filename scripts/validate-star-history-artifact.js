'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_FILES = ['star-history-dark.svg', 'star-history.svg', 'stars.json'];
const OFFICIAL_RENDERER_REPOSITORY = 'star-history/star-history';
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const XML_NAME_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const XML_NAME_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const XML_POLICY_XPATH = `concat(
  count(/*[local-name() = 'svg' and namespace-uri() = 'http://www.w3.org/2000/svg']),
  '|',
  count(//*[
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'script' or
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'foreignobject' or
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'iframe' or
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'object' or
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'embed' or
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'audio' or
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}') = 'video'
  ]),
  '|',
  count(//@*[starts-with(
    translate(local-name(), '${XML_NAME_UPPER}', '${XML_NAME_LOWER}'),
    'on'
  )]),
  '|',
  count(//processing-instruction()),
  '|',
  count(//*[local-name() = 'text' and normalize-space(.) = 'star-history.com'])
)`.replace(/\s+/g, ' ');

const fail = (message) => {
  throw new Error(`Invalid Star History artifact: ${message}`);
};

const exactKeys = (value, keys, context) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${context} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${context} has unexpected fields`);
  }
};

const canonicalTimestamp = (value) => {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const validateSnapshot = (filename, { repository, rendererCommit }) => {
  const size = fs.statSync(filename).size;
  if (size < 100 || size > MAX_JSON_BYTES) fail(`stars.json size ${size} is outside the allowed range`);

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    fail(`stars.json is not valid JSON: ${error.message}`);
  }

  exactKeys(snapshot, ['repository', 'renderer', 'stars'], 'stars.json');
  if (snapshot.repository !== repository) fail(`stars.json repository is ${snapshot.repository}`);
  exactKeys(snapshot.renderer, ['commit', 'repository'], 'stars.json renderer');
  if (snapshot.renderer.repository !== OFFICIAL_RENDERER_REPOSITORY) {
    fail(`stars.json renderer repository is ${snapshot.renderer.repository}`);
  }
  if (snapshot.renderer.commit !== rendererCommit) {
    fail(`stars.json renderer commit is ${snapshot.renderer.commit}`);
  }
  if (!Array.isArray(snapshot.stars) || snapshot.stars.length === 0 || snapshot.stars.length > 100_000) {
    fail('stars.json stars must be a non-empty bounded array');
  }

  let previousTime = -Infinity;
  snapshot.stars.forEach((star, index) => {
    exactKeys(star, ['count', 'starredAt'], `stars.json star ${index + 1}`);
    if (!canonicalTimestamp(star.starredAt)) fail(`star ${index + 1} has a non-canonical timestamp`);
    const timestamp = Date.parse(star.starredAt);
    if (timestamp < previousTime) fail(`star ${index + 1} moves backwards in time`);

    const isLast = index === snapshot.stars.length - 1;
    const isAnchor = isLast && index > 0 && star.count === snapshot.stars[index - 1].count;
    if (isAnchor && timestamp <= previousTime) fail('the current-day anchor must advance time');
    const expectedCount = isAnchor ? index : index + 1;
    if (!Number.isInteger(star.count) || star.count !== expectedCount) {
      fail(`star ${index + 1} has invalid cumulative count ${star.count}`);
    }
    previousTime = timestamp;
  });

  return snapshot;
};

const validateXmlWithXmllint = (filename) => {
  const result = spawnSync('xmllint', ['--nonet', '--xpath', XML_POLICY_XPATH, filename], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) fail(`xmllint could not run: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(filename)} is not well-formed XML: ${(result.stderr || '').trim()}`);

  const policy = (result.stdout || '').trim().split('|').map(Number);
  if (policy.length !== 5 || policy.some((value) => !Number.isInteger(value) || value < 0)) {
    fail(`${path.basename(filename)} produced an invalid XML policy result`);
  }
  if (policy[0] !== 1) fail(`${path.basename(filename)} does not have an SVG namespace root`);
  if (policy[1] !== 0) fail(`${path.basename(filename)} contains active content`);
  if (policy[2] !== 0) fail(`${path.basename(filename)} contains an event handler`);
  if (policy[3] !== 0) fail(`${path.basename(filename)} contains a processing instruction`);
  if (policy[4] !== 0) fail(`${path.basename(filename)} contains the renderer watermark`);
};

const validateSvg = (filename, { repository, validateXml = validateXmlWithXmllint }) => {
  const size = fs.statSync(filename).size;
  if (size < 100 || size > MAX_SVG_BYTES) fail(`${path.basename(filename)} size ${size} is outside the allowed range`);
  const svg = fs.readFileSync(filename, 'utf8');

  if (!/^<svg\b[\s\S]*<\/svg>\s*$/.test(svg)) fail(`${path.basename(filename)} does not have one SVG document root`);
  if (!svg.includes('Star History') || !svg.includes('GitHub Stars') || !svg.includes(repository)) {
    fail(`${path.basename(filename)} is missing expected chart identity`);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) fail(`${path.basename(filename)} contains a document type or entity declaration`);
  if (/<\/?(?:script|foreignObject|iframe|object|embed|audio|video)\b/i.test(svg)) {
    fail(`${path.basename(filename)} contains active content`);
  }
  if (/\son[a-z][a-z0-9:_-]*\s*=/i.test(svg)) fail(`${path.basename(filename)} contains an event handler`);
  if (/javascript\s*:|@import\b|expression\s*\(|-moz-binding\b/i.test(svg)) {
    fail(`${path.basename(filename)} contains executable CSS or a javascript URL`);
  }
  if (/&#(?:x[0-9a-f]+|\d+);/i.test(svg)) fail(`${path.basename(filename)} contains encoded character references`);

  for (const match of svg.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
    const target = match[2];
    if (target.startsWith('#')) continue;
    if (/^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(target)) continue;
    fail(`${path.basename(filename)} contains a disallowed linked resource`);
  }

  for (const match of svg.matchAll(/url\(([^)]+)\)/gi)) {
    const target = match[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    if (target.startsWith('#')) continue;
    if (/^data:application\/font-woff;charset=utf-8;base64,[a-z0-9+/]+=*$/i.test(target)) continue;
    fail(`${path.basename(filename)} contains a disallowed CSS resource`);
  }

  const externalUrls = svg.match(/https?:\/\/[^\s"')<]+/gi) || [];
  if (externalUrls.some((url) => url !== 'http://www.w3.org/2000/svg')) {
    fail(`${path.basename(filename)} contains an external URL`);
  }

  const embeddedImages = [...svg.matchAll(/<image\b[^>]*>/gi)];
  const titleLogos = embeddedImages.filter((match) => {
    const element = match[0];
    const attribute = (name) => element.match(new RegExp('\\b' + name + '="([^"]*)"', 'i'))?.[1];
    return attribute('width') === '22'
      && attribute('height') === '22'
      && attribute('y') === '12'
      && attribute('clip-path') === 'url(#clip-circle-title)'
      && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(attribute('href') || '');
  });
  if (titleLogos.length !== 1) {
    fail(path.basename(filename) + ' must contain exactly one embedded owner title icon');
  }
  if (embeddedImages.length !== 1) {
    fail(`${path.basename(filename)} must not contain the renderer watermark`);
  }

  const renderedDots = (svg.match(/class="chart-tooltip-dot"/g) || []).length;
  if (renderedDots !== 0) {
    fail(`${path.basename(filename)} must not contain rendered chart dots`);
  }

  validateXml(filename);
};

const validateArtifact = (directory, expected, options = {}) => {
  const resolved = path.resolve(directory);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== EXPECTED_FILES.length || names.some((name, index) => name !== EXPECTED_FILES[index])) {
    fail(`expected exactly ${EXPECTED_FILES.join(', ')}`);
  }
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail('all entries must be regular files');
  }

  const snapshot = validateSnapshot(path.join(resolved, 'stars.json'), expected);
  validateSvg(path.join(resolved, 'star-history.svg'), { ...expected, ...options });
  validateSvg(path.join(resolved, 'star-history-dark.svg'), { ...expected, ...options });
  return { starCount: snapshot.stars.at(-1).count };
};

const parseCli = (args) => {
  const options = { directory: '', repository: '', rendererCommit: '' };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === '--directory') options.directory = value;
    else if (args[index] === '--repository') options.repository = value;
    else if (args[index] === '--renderer-commit') options.rendererCommit = value;
    else fail(`unknown argument ${args[index]}`);
    index += 1;
  }
  if (!options.directory || !options.repository || !/^[0-9a-f]{40}$/.test(options.rendererCommit)) {
    fail('required arguments are --directory, --repository, and a full --renderer-commit SHA');
  }
  return options;
};

if (require.main === module) {
  try {
    const options = parseCli(process.argv.slice(2));
    const result = validateArtifact(options.directory, options);
    console.log(`Validated Star History artifact for ${result.starCount} stargazers.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_FILES,
  validateArtifact,
  validateSnapshot,
  validateSvg,
  validateXmlWithXmllint,
};
