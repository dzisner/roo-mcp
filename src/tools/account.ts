// Account tools: roo_whoami.
// GET /v1/me returns ~52 KB. This tool projects it down to what a caller actually needs:
// email, plan name, subscription dates, effective limits.
// The API values are the source of truth per account — new-signup limits and legacy-grandfathered
// limits can differ (e.g. legacy Hop is 200+300 shortlinks/mo; new Hop is 100+100).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RooClient } from '../roo-client.js';
import type { RooMeResponse } from '../types.js';

export function registerAccountTools(server: McpServer, client: RooClient): void {
  server.registerTool(
    'roo_whoami',
    {
      title: 'Roo — who am I',
      description:
        'Verify the Roo API key and return a compact account summary (email, plan, limits, subscription dates). Use to check that Roo access is working before other operations.',
      inputSchema: {},
    },
    async () => {
      const me = await client.get<RooMeResponse>('/v1/me');
      const projected = projectMe(me);
      return {
        content: [
          { type: 'text', text: renderMeSummary(projected) },
          { type: 'text', text: '```json\n' + JSON.stringify(projected, null, 2) + '\n```' },
        ],
      };
    },
  );
}

interface ProjectedMe {
  email: string | null;
  accountCreated: string | null;
  subscription: {
    status: string | null;
    planName: string | null;
    startDate: string | null;
    endDate: string | null;
    nextBillingDate: string | null;
  };
  effectiveLimits: {
    shortlinks: {
      monthly: number | null;
      monthlyAddonsExtra: number | null;
      permanentLimit: number | null;
      expiresAfterDays: number | null;
      hardDeleteAfterDays: number | null;
    };
    addOns: {
      perTypeLimit: number | null;
      note: string;
      scheduledRedirects: number | null;
      clickCountRedirects: number | null;
      webhooks: number | null;
      previewLinks: number | null;
      qrCodes: number | null;
    };
    customDomains: number | null;
    apiRateLimit: number | null;
  };
  features: {
    shortlinks: boolean | null;
    scheduledRedirects: boolean | null;
    clickCountRedirects: boolean | null;
    webhooks: boolean | null;
    previewLinks: boolean | null;
    qrCodes: boolean | null;
    dynamicQuerystring: boolean | null;
    monitoring: boolean | null;
  };
}

function projectMe(me: RooMeResponse): ProjectedMe {
  const sub = me.subscription;
  const plan = sub?.subscriptionInfo?.plan;
  const f = plan?.features;
  const fs = me.featuresStatus;
  const planName = plan?.name ?? null;

  const shortlinks = f?.shortlinks;
  const sched = f?.scheduledRedirects;
  const clickCount = f?.clickCountRedirects;
  const webhooks = f?.webhooks;
  const previewLinks = f?.previewLinks;
  const qrCodes = f?.qrCodes;

  // Every type has its own limit in the schema (Hop = 50 each), but the enforced behavior
  // is a shared ceiling: first type to hit its cap blocks all types. Surface both.
  const perTypeLimits = [
    sched?.limit,
    clickCount?.limit,
    webhooks?.limit,
    previewLinks?.limit,
    qrCodes?.limit,
  ].filter((n): n is number => typeof n === 'number');
  const allSame = perTypeLimits.length > 0 && perTypeLimits.every((n) => n === perTypeLimits[0]);
  const perTypeLimit = allSame ? perTypeLimits[0]! : null;

  return {
    email: me.email ?? null,
    accountCreated: toIsoOrNull(me.createdDate, true),
    subscription: {
      status: sub?.status ?? null,
      planName,
      startDate: toIsoOrNull(sub?.startDate),
      endDate: toIsoOrNull(sub?.endDate),
      nextBillingDate: toIsoOrNull(sub?.nextBillingDate),
    },
    effectiveLimits: {
      shortlinks: {
        monthly: shortlinks?.monthly ?? null,
        monthlyAddonsExtra: shortlinks?.monthlyAddonsExtra ?? null,
        permanentLimit: shortlinks?.permanentShortlinks?.limit ?? null,
        expiresAfterDays: shortlinks?.forceLifetime?.expiration ?? null,
        hardDeleteAfterDays: shortlinks?.forceLifetime?.delete ?? null,
      },
      addOns: {
        perTypeLimit,
        note:
          'Add-on limits are per-type in the schema, but the first type to reach its cap blocks all other types on the same account.',
        scheduledRedirects: sched?.limit ?? null,
        clickCountRedirects: clickCount?.limit ?? null,
        webhooks: webhooks?.limit ?? null,
        previewLinks: previewLinks?.limit ?? null,
        qrCodes: qrCodes?.limit ?? null,
      },
      customDomains: f?.customDomains?.limit ?? null,
      apiRateLimit: f?.api?.rateLimit ?? null,
    },
    features: {
      shortlinks: fs?.shortlinks ?? null,
      scheduledRedirects: fs?.scheduledRedirects ?? null,
      clickCountRedirects: null, // /v1/me's featuresStatus does not expose this separately today
      webhooks: fs?.webhooks ?? null,
      previewLinks: fs?.previewLinks ?? null,
      qrCodes: fs?.qrCodes ?? null,
      dynamicQuerystring: fs?.dynamicQs ?? null,
      monitoring: fs?.monitoring ?? null,
    },
  };
}

function toIsoOrNull(v: number | undefined, ms = false): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Roo uses epoch seconds for most timestamps, but createdDate is epoch milliseconds.
  const millis = ms || v > 1e12 ? v : v * 1000;
  try {
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

function renderMeSummary(p: ProjectedMe): string {
  const lines: string[] = [];
  lines.push(`Roo account: ${p.email ?? '(unknown email)'} — plan ${p.subscription.planName ?? '(unknown)'} (${p.subscription.status ?? 'unknown status'})`);
  if (p.subscription.nextBillingDate) lines.push(`Next billing: ${p.subscription.nextBillingDate}`);
  const shortMonthly = p.effectiveLimits.shortlinks.monthly;
  const shortExtra = p.effectiveLimits.shortlinks.monthlyAddonsExtra;
  if (shortMonthly != null) {
    lines.push(`Shortlinks / month: ${shortMonthly}${shortExtra != null ? ` (+${shortExtra} add-on bonus)` : ''}`);
  }
  if (p.effectiveLimits.addOns.perTypeLimit != null) {
    lines.push(`Add-on limit: ${p.effectiveLimits.addOns.perTypeLimit} per type — first to reach cap blocks all types.`);
  }
  const perm = p.effectiveLimits.shortlinks.permanentLimit;
  const exp = p.effectiveLimits.shortlinks.expiresAfterDays;
  if (perm != null || exp != null) {
    lines.push(`Permanent links: ${perm ?? '?'}${exp != null ? ` — non-permanent links expire after ${exp} days` : ''}`);
  }
  return lines.join('\n');
}

// Re-export for tests
export const _internal = { projectMe, renderMeSummary };
