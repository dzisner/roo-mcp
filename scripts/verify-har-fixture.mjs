// Phase 6 confidence lever: prove buildAddOnEntries produces a body that is a
// wire-format SUPERSET of the one Roo's own web app sent for the same intent.
//
// The HAR was captured by David logging into a real Roo account and using the
// web UI to create a shortlink with all 5 add-ons. That request succeeded
// (HTTP 200 + the fully-created shortlink was returned). If our reverse-mapped
// version of the same request contains every field the HAR request contained
// with identical values (allowing extra defaulted fields on our side that Roo
// silently accepts), we can be confident our wire format is correct.
//
// This test is intentionally SUBSET-strict, not EQUAL-strict. Two reasons:
//   1. The HAR omits some fields our builder always emits (e.g. webhook
//      headers/queryString, previewLink title/description) — Roo happily
//      accepts either. Our test tolerates this by checking HAR ⊆ ours.
//   2. Our extra fields are the defaults that the individual roo_set_* tools
//      also emit — already smoke-tested end-to-end and known-good.
//
// If the diff finds any HAR field missing from our output OR with a different
// value, the test fails.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAddOnEntries } from '../dist/tools/shortlinks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HAR = 'C:\\Users\\User\\AppData\\Local\\Temp\\claude\\C--Users-User-Roo-MCP\\bb39d305-91d1-4ae6-98b9-11f8eb38ebeb\\scratchpad\\all-addons.har';

if (!existsSync(HAR)) {
  console.error('HAR fixture not found:', HAR);
  console.error('Expected the file to have been copied into scratchpad earlier in this project.');
  process.exit(2);
}

const har = JSON.parse(readFileSync(HAR, 'utf8'));
const post = har.log.entries.find(
  (e) => e.request.method === 'POST' && new URL(e.request.url).pathname === '/v1/urls',
);
if (!post) {
  console.error('No POST /v1/urls entry found in HAR.');
  process.exit(2);
}
const harBody = JSON.parse(post.request.postData.text);

console.log('HAR request body summary:');
console.log(`  url: ${harBody.url}`);
console.log(`  addOns: ${harBody.addOns.map((a) => a.addOn).join(', ')}`);
console.log(`  request size: ${post.request.postData.text.length} bytes\n`);

// ── Reverse-map HAR's top-level customDomain into our tool's custom_domain input ──
let customDomainInput;
if (harBody.customDomain) {
  customDomainInput = {
    ...(harBody.customDomain.domain !== undefined ? { domain: harBody.customDomain.domain } : {}),
    ...(harBody.customDomain.slug !== undefined && harBody.customDomain.slug !== ''
      ? { slug: harBody.customDomain.slug }
      : {}),
    ...(harBody.customDomain.alternativeSlug !== undefined
      ? { alternative_slug: harBody.customDomain.alternativeSlug }
      : {}),
  };
}

// ── Reverse-map HAR's wire-format addOns[] into our tool's nested add_ons input ──
const input = {};
for (const entry of harBody.addOns) {
  const d = entry.data ?? {};
  switch (entry.addOn) {
    case 'scheduledRedirect':
      input.scheduled_redirect = {
        waypoints: (d.schedule ?? []).map((s) => ({ url: s.url, at: s.timestamp })),
      };
      break;
    case 'clickCountRedirect':
      input.click_count_redirect = {
        thresholds: (d.schedule ?? []).map((s) => ({ url: s.url, click_count: s.clickCount })),
      };
      break;
    case 'webhook':
      input.webhook = {
        endpoint: d.endpoint,
        // Only pass fields the HAR actually set — undefined lets our defaulter apply.
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.method !== undefined ? { method: d.method } : {}),
        ...(d.contentType !== undefined ? { content_type: d.contentType } : {}),
        ...(d.body !== undefined ? { body: d.body } : {}),
        ...(d.headers !== undefined ? { headers: d.headers } : {}),
        ...(d.queryString !== undefined ? { query_string: d.queryString } : {}),
        ...(d.addMetadata !== undefined ? { add_metadata: d.addMetadata } : {}),
      };
      break;
    case 'previewLink':
      // HAR only had `image`; synthesize title/description since the current builder
      // requires them. This means the test's previewLink SUBSET assertion only
      // meaningfully checks the image (and image_kind selection) — which is fine.
      input.preview_link = {
        title: d.title ?? '<har-omitted>',
        description: d.description ?? '<har-omitted>',
        ...(d.image !== undefined ? { image: d.image } : {}),
        ...(d.image_url !== undefined ? { image: d.image_url } : {}),
      };
      break;
    case 'qrCode':
      input.qr = {
        code_color: d.codeColor,
        background_color: d.backgroundColor,
        style: d.qtType,
        scale: d.scale,
        logo: d.logo,
        display_roo_logo: d.displayRooLogo,
      };
      break;
    default:
      console.error('Unknown addOn type in HAR:', entry.addOn);
      process.exit(2);
  }
}

// ── Build our body ────────────────────────────────────────────────────
// Mirror the same body composition roo_create_shortlink does internally.
const myAddOns = buildAddOnEntries(input);
const myBody = { url: harBody.url };
if (customDomainInput) {
  const cd = {};
  if (customDomainInput.domain !== undefined) cd.domain = customDomainInput.domain;
  if (customDomainInput.slug !== undefined) cd.slug = customDomainInput.slug;
  if (customDomainInput.alternative_slug !== undefined) cd.alternativeSlug = customDomainInput.alternative_slug;
  if (Object.keys(cd).length > 0) myBody.customDomain = cd;
}
if (myAddOns.length > 0) myBody.addOns = myAddOns;

console.log('Our reverse-mapped body summary:');
console.log(`  url: ${myBody.url}`);
if (myBody.customDomain) console.log(`  customDomain: ${JSON.stringify(myBody.customDomain)}`);
console.log(`  addOns: ${myBody.addOns.map((a) => a.addOn).join(', ')}\n`);

// ── Fields Roo's web app sends at top level that we don't (yet) support in create ──
// These are known scope for a future extension of roo_create_shortlink; the tool
// currently expects the caller to use dedicated tools for them (e.g. roo_make_permanent).
const KNOWN_UNSUPPORTED_TOPLEVEL = ['description', 'permanent'];

// ── SUBSET diff: every HAR field must be in ours with matching value ──
function subsetDiff(harNode, mineNode, path) {
  const problems = [];
  if (harNode === null || typeof harNode !== 'object') {
    if (harNode !== mineNode) {
      problems.push(`${path}: HAR=${JSON.stringify(harNode)} vs mine=${JSON.stringify(mineNode)}`);
    }
    return problems;
  }
  if (Array.isArray(harNode)) {
    if (!Array.isArray(mineNode)) {
      problems.push(`${path}: HAR is array, mine is ${typeof mineNode}`);
      return problems;
    }
    // For the top-level addOns array, match by discriminator (`addOn`) since order may differ.
    if (path === '.addOns') {
      for (const harEntry of harNode) {
        const myEntry = mineNode.find((m) => m.addOn === harEntry.addOn);
        if (!myEntry) {
          problems.push(`${path}: mine is missing addOn "${harEntry.addOn}"`);
          continue;
        }
        problems.push(...subsetDiff(harEntry, myEntry, `${path}[${harEntry.addOn}]`));
      }
    } else {
      // Positional match for schedule arrays (they should be same length + our sort is stable
      // when the input already matches sort order — the HAR's schedules are single-element here).
      if (mineNode.length < harNode.length) {
        problems.push(`${path}: length mismatch — HAR has ${harNode.length}, mine has ${mineNode.length}`);
      }
      for (let i = 0; i < harNode.length; i++) {
        problems.push(...subsetDiff(harNode[i], mineNode[i], `${path}[${i}]`));
      }
    }
    return problems;
  }
  // Object: every HAR key must exist in mine with matching value.
  for (const [k, v] of Object.entries(harNode)) {
    // Ignore top-level fields our create tool doesn't currently expose. Report them
    // separately as "known unsupported" so they can't silently drift into a real failure.
    if (path === '' && KNOWN_UNSUPPORTED_TOPLEVEL.includes(k)) continue;

    // Known equivalent-wire-representation: HAR's customDomain.slug: "" (user didn't
    // supply a slug via the web-UI text field) is semantically identical to our tool
    // omitting the field entirely (user didn't include it in the tool input).
    if (path === '.customDomain' && k === 'slug' && v === '' && !(k in mineNode)) continue;

    if (!(k in mineNode)) {
      problems.push(`${path}.${k}: missing in mine (HAR had ${JSON.stringify(v).slice(0, 80)})`);
      continue;
    }
    problems.push(...subsetDiff(v, mineNode[k], `${path}.${k}`));
  }
  return problems;
}

const problems = subsetDiff(harBody, myBody, '');

// Also record the intentionally-ignored top-level fields for the report.
const unsupportedFound = KNOWN_UNSUPPORTED_TOPLEVEL.filter((k) => k in harBody);

if (problems.length === 0) {
  console.log('✓ SUBSET PASS — every field Roo\'s web app sent that our tool exposes, we emit with an identical value.');
} else {
  console.log('✗ SUBSET FAIL — the following fields diverge:');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}

if (unsupportedFound.length > 0) {
  console.log(`\nInformational — top-level fields Roo's web app sent but our create tool does not currently expose:`);
  for (const k of unsupportedFound) {
    console.log(`  • ${k} = ${JSON.stringify(harBody[k])}   (handled by separate tools today — e.g. permanent via roo_make_permanent)`);
  }
}

// ── Bonus: report our "extras" — fields we emit that HAR didn't ──
function extrasReport(mine, har, path, out) {
  if (mine === null || typeof mine !== 'object') return;
  if (Array.isArray(mine)) {
    if (path === '.addOns') {
      for (const myEntry of mine) {
        const harEntry = har?.find?.((h) => h.addOn === myEntry.addOn);
        if (harEntry) extrasReport(myEntry, harEntry, `${path}[${myEntry.addOn}]`, out);
      }
    } else if (Array.isArray(har)) {
      for (let i = 0; i < mine.length; i++) extrasReport(mine[i], har[i], `${path}[${i}]`, out);
    }
    return;
  }
  const harObj = har && typeof har === 'object' && !Array.isArray(har) ? har : {};
  for (const [k, v] of Object.entries(mine)) {
    if (!(k in harObj)) {
      out.push(`${path}.${k} = ${JSON.stringify(v).slice(0, 100)}`);
    } else {
      extrasReport(v, harObj[k], `${path}.${k}`, out);
    }
  }
}

const extras = [];
extrasReport(myBody, harBody, '', extras);
if (extras.length > 0) {
  console.log(`\nInformational — our body has ${extras.length} extra field${extras.length === 1 ? '' : 's'} that Roo\'s web app omitted (defaults):`);
  for (const e of extras) console.log('  + ' + e);
  console.log('\nThese are known-safe: Roo accepted the HAR request without them, meaning they are either optional or defaulted server-side. Our builder emits them because the individual roo_set_* tools always do (smoke-tested).');
}
