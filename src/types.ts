// Shared types mirroring Roo's actual on-wire shapes (per roo-openapi.json + SPEC-NOTES.md).
// Roo's read responses use PascalCase (CustomDomain, Attributes.TargetUrl), while writes use
// camelCase (customDomain). The normalization layer in tools/shortlinks.ts hides that from callers.

// ── /v1/me ───────────────────────────────────────────────────────────────
export interface RooMeResponse {
  email?: string;
  createdDate?: number;
  subscription?: RooSubscription;
  featuresStatus?: RooFeaturesStatus;
  [k: string]: unknown;
}

export interface RooSubscription {
  status?: string;
  startDate?: number;
  endDate?: number;
  nextBillingDate?: number;
  paymentGateway?: string;
  subscriptionInfo?: RooSubscriptionInfo;
  [k: string]: unknown;
}

export interface RooSubscriptionInfo {
  plan?: RooPlan;
  [k: string]: unknown;
}

export interface RooPlan {
  name?: string;
  description?: string;
  features?: RooPlanFeatures;
  [k: string]: unknown;
}

export interface RooPlanFeatures {
  shortlinks?: {
    monthly?: number;
    monthlyAddonsExtra?: number;
    permanentShortlinks?: { limit?: number; enabled?: boolean };
    forceLifetime?: { enabled?: boolean; expiration?: number; delete?: number };
    extraShortlinks?: { enabled?: boolean; cost?: number };
  };
  scheduledRedirects?: RooAddOnLimit;
  clickCountRedirects?: RooAddOnLimit;
  webhooks?: RooAddOnLimit;
  previewLinks?: RooAddOnLimit;
  qrCodes?: RooAddOnLimit;
  customDomains?: { limit?: number; enabled?: boolean };
  api?: { rateLimit?: number };
  users?: { limit?: number; enabled?: boolean };
  support?: string;
  planChecklist?: Record<string, boolean>;
  [k: string]: unknown;
}

export interface RooAddOnLimit {
  limit?: number;
  type?: string;
  enabled?: boolean;
}

export interface RooFeaturesStatus {
  shortlinks?: boolean;
  webhooks?: boolean;
  previewLinks?: boolean;
  qrCodes?: boolean;
  scheduledRedirects?: boolean;
  dynamicQs?: boolean;
  monitoring?: boolean;
  disclaimers?: boolean;
  isMonthlyExtraShortlink?: boolean;
  extraShortlinkBy?: string;
  [k: string]: unknown;
}

// ── /v1/urls (shortlinks) ────────────────────────────────────────────────

export type RooAddOnType =
  | 'scheduledRedirect'
  | 'clickCountRedirect'
  | 'webhook'
  | 'previewLink'
  | 'qrCode';

export interface RooAddOn {
  addOn: RooAddOnType;
  enabled: boolean;
  data: unknown;
}

export interface RooCustomDomainWrite {
  domain?: string;
  slug?: string;
  alternativeSlug?: boolean;
}

/** Roo returns CustomDomain PascalCase on reads, but same field shape. */
export interface RooCustomDomainRead {
  domain?: string;
  slug?: string;
  alternativeSlug?: boolean;
}

export interface RooFolderPath {
  id: string;
  name: string;
}

/**
 * POST /v1/urls response. Note: spec claims `message` but reality has slug + shortUrlNoProtocol.
 * When the request's `addOns[]` included a `qrCode` entry, Roo also pre-renders the QR image and
 * returns it inline as `qrCode`, matching the shape of RooQrCodeResponse.data. Confirmed via HAR
 * capture of the Roo web app creating a shortlink with all five add-ons. Absent when qrCode was
 * not requested.
 */
export interface RooShortlinkCreated {
  id: string;
  shortUrl?: string;
  shortUrlNoProtocol?: string;
  slug?: string;
  message?: string;
  qrCode?: {
    mimeType: string;
    base64: string; // full data URI (e.g. "data:image/png;base64,...")
  };
}

/** PATCH /v1/urls/{id} response. */
export interface RooShortlinkUpdated {
  id?: string;
  message?: string;
}

/** GET /v1/urls/{id} response. List items match this shape MINUS shortUrl / shortUrlNoProtocol / slug. */
export interface RooShortlinkRecord {
  PK?: string;
  CreatedDate?: number;
  UpdatedDate?: number;
  Attributes?: {
    TargetUrl?: string;
    Permanent?: boolean;
    UserId?: string;
    [k: string]: unknown;
  };
  Counter?: number;
  FolderId?: string | null;
  FolderPaths?: RooFolderPath[];
  Description?: string | null;
  CustomDomain?: RooCustomDomainRead;
  addOns?: RooAddOn[];
  shortUrl?: string;
  shortUrlNoProtocol?: string;
  slug?: string;
  [k: string]: unknown;
}

/** GET /v1/urls response. */
export interface RooShortlinkList {
  items?: RooShortlinkRecord[];
  nextKey?: string;
}

// ── Write bodies ─────────────────────────────────────────────────────────
/** POST /v1/urls body. */
export interface RooShortlinkCreateBody {
  url: string;
  customDomain?: RooCustomDomainWrite;
  addOns?: RooAddOn[];
}

/** PATCH /v1/urls/{id} body. */
export interface RooShortlinkPatchBody {
  url?: string;
  customDomain?: RooCustomDomainWrite;
}

/** PATCH /v1/urls/{id}/permanent-shortlink body. Full schema unknown; `permanent` is the only field we've verified. */
export interface RooPermanentSettingsPatchBody {
  permanent?: boolean;
  [k: string]: unknown;
}

// ── Custom domains ───────────────────────────────────────────────────────
/** One record in GET /v1/account/custom-domains. Undocumented endpoint. */
export interface RooCustomDomainRecord {
  PK?: string;
  CreatedDate?: number;
  UpdatedDate?: number;
  Attributes?: {
    domain?: string;
    subdomain?: string;
    acm?: { cname?: Array<{ name?: string; type?: string; value?: string }> };
    cloudfront?: { cname?: string };
    [k: string]: unknown;
  };
  Status?: string;
  [k: string]: unknown;
}

/** GET /v1/account/custom-domains response. Accepts optional ?filter=<Status> query. */
export interface RooCustomDomainsResponse {
  domains?: RooCustomDomainRecord[];
}

// ── QR code ──────────────────────────────────────────────────────────────
/** GET /v1/urls/{id}/qr-code response. On qrCode-not-enabled, Roo returns HTTP 404 with `{success:false, message}` — handled by errors.ts. */
export interface RooQrCodeResponse {
  success: boolean;
  data?: {
    mimeType: string;
    base64: string; // full data URI (e.g. "data:image/png;base64,...")
  };
  message?: string;
}
