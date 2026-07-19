// End-to-end smoke test. Spawns the built roo-mcp server over stdio,
// calls tools/list and then exercises every implemented tool.
// Loads ROO_API_KEY from the project's .env and passes it via env.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT = 'C:\\Users\\User\\Roo MCP';

function loadEnv() {
  const raw = readFileSync(join(PROJECT, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

const projectEnv = loadEnv();
if (!projectEnv.ROO_API_KEY) {
  console.error('ROO_API_KEY missing in .env');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(PROJECT, 'dist', 'index.js')],
  env: { ...process.env, ROO_API_KEY: projectEnv.ROO_API_KEY },
});

const client = new Client({ name: 'roo-mcp-smoke-test', version: '0.0.1' });

console.log('connecting...');
await client.connect(transport);

async function call(name, args = {}) {
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) console.log('TOOL RETURNED ERROR:');
  for (const block of result.content ?? []) {
    if (block.type === 'text') console.log(block.text);
    else console.log(`(non-text block: ${block.type})`);
  }
  return result;
}

function firstJsonBlock(result) {
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    const m = block.text.match(/```json\n([\s\S]*?)\n```/);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}

console.log('\n=== tools/list ===');
const tools = await client.listTools();
for (const t of tools.tools) console.log(`- ${t.name}: ${t.description ?? '(no description)'}`);

// 1. whoami
await call('roo_whoami');

// 2. list a short page
const listRes = await call('roo_list_shortlinks', { limit: 3 });
const listPayload = firstJsonBlock(listRes);
if (listPayload?.items?.length) {
  const anyCustom = listPayload.items.some((it) => it.is_custom_domain);
  console.log(`  -> is_custom_domain surfaced on items; any custom in this page: ${anyCustom}`);
}

// 2b. list custom domains (authoritative — one API call to /v1/account/custom-domains)
await call('roo_list_custom_domains', {});
await call('roo_list_custom_domains', { status_filter: 'Issued' });

// 3. create a disposable shortlink
const createRes = await call('roo_create_shortlink', {
  url: 'https://example.com/smoke-test-' + process.hrtime.bigint().toString(36),
});
const created = firstJsonBlock(createRes);
if (!created?.id) {
  console.error('create did not return an id — aborting further probes.');
  await client.close();
  process.exit(1);
}
const newId = created.id;

// 4. get the fresh shortlink
await call('roo_get_shortlink', { id: newId });

// 5. update its destination
await call('roo_update_shortlink', {
  id: newId,
  url: 'https://example.com/smoke-test-updated',
});

// 6. get again to confirm the update stuck
await call('roo_get_shortlink', { id: newId });

// 7. update with empty body (should error at the tool boundary, not hit Roo)
console.log('\n=== error path: update with no fields ===');
try {
  const errRes = await client.callTool({ name: 'roo_update_shortlink', arguments: { id: newId } });
  if (errRes.isError) {
    console.log('caught (tool-error):');
    for (const b of errRes.content ?? []) if (b.type === 'text') console.log('  ' + b.text);
  } else {
    console.log('(no error surfaced — expected one)');
  }
} catch (e) {
  console.log(`caught (thrown): ${e.message}`);
}

// 8. make it permanent, then confirm via get
await call('roo_make_permanent', { id: newId });
const getAfterPerm = await call('roo_get_shortlink', { id: newId });
const parsedPerm = firstJsonBlock(getAfterPerm);
console.log(`  -> Attributes.Permanent (from GET): ${parsedPerm?.permanent}`);

// 9. un-make permanent via update_permanent_settings, confirm via get
await call('roo_update_permanent_settings', { id: newId, permanent: false });
const getAfterUnperm = await call('roo_get_shortlink', { id: newId });
const parsedUnperm = firstJsonBlock(getAfterUnperm);
console.log(`  -> Attributes.Permanent (after un-make): ${parsedUnperm?.permanent}`);

// 10. QR on the new link (no qrCode add-on set) → expect qr_not_enabled error
console.log('\n=== error path: QR before add-on set ===');
const noQrRes = await client.callTool({ name: 'roo_get_qr_code', arguments: { id: newId } });
if (noQrRes.isError) {
  console.log('caught (tool-error):');
  for (const b of noQrRes.content ?? []) if (b.type === 'text') console.log('  ' + b.text);
} else {
  console.log('(no error surfaced — expected qr_not_enabled)');
}

// 11. QR on the earlier probe link (cm9vLndzLzBNSWtBbE9a) which already has qrCode enabled → expect image block
const QR_ENABLED_ID = 'cm9vLndzLzBNSWtBbE9a';
console.log(`\n=== roo_get_qr_code {id: ${QR_ENABLED_ID}} (no save_to → image block) ===`);
const qrInlineRes = await client.callTool({ name: 'roo_get_qr_code', arguments: { id: QR_ENABLED_ID } });
for (const b of qrInlineRes.content ?? []) {
  if (b.type === 'text') console.log(b.text);
  else if (b.type === 'image') console.log(`(image block: ${b.mimeType}, ${b.data.length} b64 chars)`);
  else console.log(`(other block: ${b.type})`);
}

// 12. QR with save_to → verify file appears on disk
const outPath = 'C:\\Users\\User\\AppData\\Local\\Temp\\claude\\C--Users-User-Roo-MCP\\bb39d305-91d1-4ae6-98b9-11f8eb38ebeb\\scratchpad\\smoke-qr.png';
await call('roo_get_qr_code', { id: QR_ENABLED_ID, save_to: outPath });
try {
  const { statSync } = await import('node:fs');
  const st = statSync(outPath);
  console.log(`  -> file on disk: ${st.size} bytes at ${outPath}`);
} catch (e) {
  console.log(`  -> stat failed: ${e.message}`);
}

// 13. QR with a RELATIVE save_to → expect tool-side validation error
console.log('\n=== error path: QR save_to with a relative path ===');
const relErr = await client.callTool({ name: 'roo_get_qr_code', arguments: { id: QR_ENABLED_ID, save_to: 'relative-path.png' } });
if (relErr.isError) {
  console.log('caught (tool-error):');
  for (const b of relErr.content ?? []) if (b.type === 'text') console.log('  ' + b.text);
} else {
  console.log('(no error surfaced — expected validation error)');
}

// ── Add-on tools on the fresh test link ────────────────────────────
// 14. Scheduled redirect: 2 waypoints, mix ISO + epoch to prove both paths
const nowSec = Math.floor(Date.now() / 1000);
await call('roo_set_scheduled_redirect', {
  id: newId,
  waypoints: [
    { url: 'https://example.com/phase-A', at: new Date((nowSec + 3600) * 1000).toISOString() },
    { url: 'https://example.com/phase-B', at: nowSec + 7200 },
  ],
});

// 15. Click-count redirect: 2 thresholds
await call('roo_set_click_count_redirect', {
  id: newId,
  thresholds: [
    { url: 'https://example.com/first-50', click_count: 50 },
    { url: 'https://example.com/next-100', click_count: 150 },
  ],
});

// 16. Webhook with just endpoint (tool fills all defaults)
await call('roo_set_webhook', {
  id: newId,
  endpoint: 'https://example.com/webhook-target',
});

// 17. Preview link (title/description only, no image)
await call('roo_set_preview_link', {
  id: newId,
  title: 'Roo MCP smoke test',
  description: 'A disposable link created by the roo-mcp smoke test to exercise add-on tools.',
});

// 18. QR add-on (defaults for all 6 fields)
await call('roo_set_qr_addon', { id: newId });

// 19. GET the shortlink and confirm all 5 add-ons are present
const afterAllAddons = await call('roo_get_shortlink', { id: newId });
const parsedAll = firstJsonBlock(afterAllAddons);
console.log(`  -> add-on types set: ${parsedAll?.add_ons?.map((a) => a.type).join(', ')}`);

// 20. QR on the fresh link (now that qrCode is enabled) → prove the chain
const newQrPath = 'C:\\Users\\User\\AppData\\Local\\Temp\\claude\\C--Users-User-Roo-MCP\\bb39d305-91d1-4ae6-98b9-11f8eb38ebeb\\scratchpad\\smoke-qr-newlink.png';
await call('roo_get_qr_code', { id: newId, save_to: newQrPath });
try {
  const { statSync } = await import('node:fs');
  const st = statSync(newQrPath);
  console.log(`  -> QR file for fresh link: ${st.size} bytes at ${newQrPath}`);
} catch (e) {
  console.log(`  -> stat failed: ${e.message}`);
}

// ── Padded-id regression: the well-known l.davidzisner.pro/switcheroo shortlink
// has id `bC5kYXZpZHppc25lci5wcm8vc3dpdGNoZXJvbw==` — trailing `==`. Before the
// encodeRooId fix, every call on this id 404'd because encodeURIComponent turned
// the `==` into `%3D%3D` which Roo can't route. If either of these fails, the
// encoding regression is back.
console.log('\n=== padded-id regression: get + non-mutating permanent-settings ===');
const PADDED_ID = 'bC5kYXZpZHppc25lci5wcm8vc3dpdGNoZXJvbw==';
const paddedGet = await client.callTool({ name: 'roo_get_shortlink', arguments: { id: PADDED_ID } });
if (paddedGet.isError) {
  console.log('  ✗ roo_get_shortlink on padded id FAILED — encoding regression!');
  for (const b of paddedGet.content ?? []) if (b.type === 'text') console.log('    ' + b.text);
} else {
  const paddedInfo = firstJsonBlock(paddedGet);
  console.log(`  ✓ roo_get_shortlink on padded id: slug=${paddedInfo?.slug}, domain=${paddedInfo?.domain}, permanent=${paddedInfo?.permanent}`);
}
// Non-mutating: assert current permanent state stays whatever it is. We use update_permanent_settings
// (rather than make_permanent) so we can pass through the current value idempotently.
const paddedPermInfo = firstJsonBlock(paddedGet);
if (paddedPermInfo) {
  const paddedPermSet = await client.callTool({
    name: 'roo_update_permanent_settings',
    arguments: { id: PADDED_ID, permanent: paddedPermInfo.permanent },
  });
  if (paddedPermSet.isError) {
    console.log('  ✗ roo_update_permanent_settings on padded id FAILED — encoding regression on the permanent-shortlink route!');
    for (const b of paddedPermSet.content ?? []) if (b.type === 'text') console.log('    ' + b.text);
  } else {
    console.log('  ✓ roo_update_permanent_settings on padded id succeeded (idempotent).');
  }
}

// ── Phase 7: batch-create scenarios ────────────────────────────────────
// Roo requires preview link images to be at least 100 KB — a 1×1 PNG is
// rejected. For this test we reuse the ~470 KB JPEG captured in the HAR,
// which Roo already accepted, so the smoke test doesn't have to embed or
// generate a large image itself.
const HAR_PATH_FOR_SMOKE =
  'C:\\Users\\User\\AppData\\Local\\Temp\\claude\\C--Users-User-Roo-MCP\\bb39d305-91d1-4ae6-98b9-11f8eb38ebeb\\scratchpad\\all-addons.har';
let LARGE_PREVIEW_IMAGE = null;
try {
  const { readFileSync } = await import('node:fs');
  const har = JSON.parse(readFileSync(HAR_PATH_FOR_SMOKE, 'utf8'));
  const post = har.log.entries.find(
    (e) => e.request.method === 'POST' && new URL(e.request.url).pathname === '/v1/urls',
  );
  const harPreview = JSON.parse(post.request.postData.text).addOns.find(
    (a) => a.addOn === 'previewLink',
  );
  LARGE_PREVIEW_IMAGE = harPreview?.data?.image ?? null;
} catch (e) {
  console.log(`(couldn't load HAR image for preview test: ${e.message} — skipping preview_link in batch)`);
}


// 20a. Create with a single add-on (webhook only)
const createWithWebhook = await call('roo_create_shortlink', {
  url: 'https://example.com/batch-webhook-' + process.hrtime.bigint().toString(36),
  add_ons: {
    webhook: {
      endpoint: 'https://example.com/webhook-target-batch',
    },
  },
});
const webhookLink = firstJsonBlock(createWithWebhook);
if (!webhookLink?.id) {
  console.error('batch-with-webhook create did not return an id — aborting.');
  await client.close();
  process.exit(1);
}
const webhookGet = await call('roo_get_shortlink', { id: webhookLink.id });
const webhookAddOns = (firstJsonBlock(webhookGet)?.add_ons ?? []).map((a) => a.type).sort();
console.log(`  -> add-ons present on batch-webhook link: ${webhookAddOns.join(', ') || '(none)'}`);
if (webhookAddOns.join(',') !== 'webhook') {
  console.log(`  ✗ expected only "webhook", got: ${webhookAddOns.join(', ')}`);
}

// 20b. Create with ALL 5 add-ons in one call (or 4 if we couldn't load a big-enough preview image)
const nowSecBatch = Math.floor(Date.now() / 1000);
const batchAllAddOns = {
  scheduled_redirect: {
    waypoints: [{ url: 'https://example.com/phase-A', at: nowSecBatch + 3600 }],
  },
  click_count_redirect: {
    thresholds: [{ url: 'https://example.com/after-10', click_count: 10 }],
  },
  webhook: {
    endpoint: 'https://example.com/batch-webhook',
  },
  qr: {},
};
if (LARGE_PREVIEW_IMAGE) {
  batchAllAddOns.preview_link = {
    title: 'Batch test preview',
    description: 'Created via roo_create_shortlink with add_ons',
    image: LARGE_PREVIEW_IMAGE,
  };
}
const createAll = await call('roo_create_shortlink', {
  url: 'https://example.com/batch-all-' + process.hrtime.bigint().toString(36),
  add_ons: batchAllAddOns,
});
const allLink = firstJsonBlock(createAll);
if (!allLink?.id) {
  console.error('batch-with-all create did not return an id — aborting.');
  await client.close();
  process.exit(1);
}
console.log(`  -> add_ons_attached (from tool payload): ${(allLink.add_ons_attached ?? []).join(', ')}`);
const inlineImageBlock = createAll.content?.find((c) => c.type === 'image');
console.log(`  -> MCP image block returned inline: ${inlineImageBlock ? `yes (${inlineImageBlock.mimeType}, ${inlineImageBlock.data.length} b64 chars)` : 'no'}`);

// Follow-up GET — confirm all 5 add-ons landed server-side
const allGet = await call('roo_get_shortlink', { id: allLink.id });
const allAddOns = (firstJsonBlock(allGet)?.add_ons ?? []).map((a) => a.type).sort();
console.log(`  -> add-ons present on batch-all link (via follow-up GET): ${allAddOns.join(', ')}`);
const expectedAll = LARGE_PREVIEW_IMAGE
  ? ['clickCountRedirect', 'previewLink', 'qrCode', 'scheduledRedirect', 'webhook']
  : ['clickCountRedirect', 'qrCode', 'scheduledRedirect', 'webhook'];
if (allAddOns.join(',') !== expectedAll.join(',')) {
  console.log(`  ✗ expected: ${expectedAll.join(', ')}`);
  console.log(`  ✗ got:      ${allAddOns.join(', ')}`);
}

// 20c. Round-trip QR bytes: inline-in-create vs standalone get
if (inlineImageBlock) {
  const followupQr = await client.callTool({ name: 'roo_get_qr_code', arguments: { id: allLink.id } });
  const followupImageBlock = followupQr.content?.find((c) => c.type === 'image');
  if (followupImageBlock) {
    const matches = inlineImageBlock.data === followupImageBlock.data;
    console.log(`  -> QR bytes round-trip (inline vs standalone GET): ${matches ? '✓ identical' : `✗ differ (${inlineImageBlock.data.length} vs ${followupImageBlock.data.length} b64 chars)`}`);
  } else {
    console.log('  -> follow-up QR fetch returned no image block');
  }
}

// 21. Error path: scheduled redirect with 0 waypoints (zod validation)
console.log('\n=== error path: scheduled redirect with 0 waypoints ===');
const zeroWp = await client.callTool({ name: 'roo_set_scheduled_redirect', arguments: { id: newId, waypoints: [] } });
if (zeroWp.isError) {
  console.log('caught (tool-error):');
  for (const b of zeroWp.content ?? []) if (b.type === 'text') console.log('  ' + b.text);
} else {
  console.log('(no error surfaced — expected validation error)');
}

// 22. Error path: scheduled redirect with an unparseable datetime
console.log('\n=== error path: scheduled redirect with bad datetime ===');
const badAt = await client.callTool({
  name: 'roo_set_scheduled_redirect',
  arguments: { id: newId, waypoints: [{ url: 'https://example.com/bad', at: 'not-a-date' }] },
});
if (badAt.isError) {
  console.log('caught (tool-error):');
  for (const b of badAt.content ?? []) if (b.type === 'text') console.log('  ' + b.text);
} else {
  console.log('(no error surfaced — expected validation error)');
}

await client.close();
console.log('\nsmoke test complete.');
