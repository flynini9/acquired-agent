// Actions for this artifact: route library + test-session persistence.
//
// Routes (schema "acquired-route/2") live in the `routes` table as verbatim
// JSON. The table is seeded from ./seedRoutes on first use; importing and
// deleting routes at runtime never requires a rebuild.
//
// A session's full answer state lives as a JSON string in `sessions.data`
// (shape owned by the client). New sessions bind `routeId` and embed a
// `routeData` snapshot of their route, so results stay readable even if the
// route is later deleted from the library. Legacy sessions (v1, no routeId)
// resolve only through an embedded snapshot or exact owned route ID.
// Public requests supply server-authenticated ownership through Ctx.

import {englishConceptAliases,englishKeywordIndex,englishAvoidance,englishNegatedInterest} from "./english-intent";
import {rerouteMotivationMeta,rerouteQueryCoverage} from "./route-reports";
import {catalogEntrySeries, entrySeriesReason, routeSeriesConflict, seriesOrderConflict, type EntrySeries, type EntryWork} from "./entry-series";
import {identityTitleKey, identityChoices} from "./identity-candidates";
import { defineAction, z, type ActionsModule, type Ctx } from "./action-runtime";
import { and, asc, desc, eq, or, isNull } from "drizzle-orm";
import * as schema from "./upstream-schema";
import { env } from "cloudflare:workers";
import { trackedFetch, traceStorage, newTrace, runExplanation, currentPhase, rejectionHeader } from "./telemetry";
import { seedRouteData } from "./seedRoutes";

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

type RouteRow = { routeId: string; title: string; destination: string; data: string };

// Unscoped contexts are retained for offline core fixtures only. Every HTTP
// execution supplies authenticated ownerId; no request field controls Ctx.
function routeScope(ctx: Ctx) {
 return ctx.ownerId ? or(eq(schema.routes.ownerId,ctx.ownerId),ctx.isOwner?isNull(schema.routes.ownerId):undefined) : undefined;
}
function sessionScope(ctx: Ctx) {
 return ctx.ownerId ? or(eq(schema.sessions.ownerId,ctx.ownerId),ctx.isOwner?isNull(schema.sessions.ownerId):undefined) : undefined;
}


function parseRouteRow(data: string): RouteRow | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed == null || typeof parsed !== "object") return null;
    const r = parsed as Record<string, unknown>;
    const meta =
      r.meta != null && typeof r.meta === "object"
        ? (r.meta as Record<string, unknown>)
        : {};
    const routeId = typeof r.route_id === "string" ? r.route_id : null;
    if (!routeId) return null;
    return {
      routeId,
      title: typeof meta.title === "string" ? meta.title : routeId,
      destination: typeof meta.destination === "string" ? meta.destination : "",
      data,
    };
  } catch {
    return null;
  }
}

function seedRows(): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const data of seedRouteData) {
    const row = parseRouteRow(data);
    if (row) rows.push(row);
  }
  return rows;
}

async function ensureSeeded(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({ routeId: schema.routes.routeId })
    .from(schema.routes).where(routeScope(ctx));
  const have = new Set(existing.map((r) => r.routeId));
  for (const row of seedRows()) {
    if (have.has(row.routeId)) continue;
    await db
      .insert(schema.routes)
      .values({
        routeId: row.routeId,
        ownerId: ctx.ownerId ?? null,
        title: row.title,
        destination: row.destination,
        data: row.data,
      })
      .onConflictDoNothing();
  }
}

/** Resolve the route JSON for a stored session, for legacy sessions that
 * carry no embedded snapshot. Returns null when nothing matches. */
async function resolveRouteData(ctx: Ctx, sessionData: string): Promise<string | null> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(sessionData);
    if (raw != null && typeof raw === "object") parsed = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (typeof parsed.routeData === "string" && parsed.routeData.length > 0) {
    return parsed.routeData;
  }
  const seeds = seedRows();
  const routeId = typeof parsed.routeId === "string" ? parsed.routeId : null;
  if (routeId) {
    const db = ctx.db<typeof schema>();
    const rows = await db
      .select()
      .from(schema.routes)
      .where(and(eq(schema.routes.routeId, routeId),routeScope(ctx)))
      .limit(1);
    if (rows[0]) return rows[0].data;
    const seed = seeds.find((s) => s.routeId === routeId);
    if (seed) return seed.data;
    return null;
  }
  // A display title is not a stable route identity. Missing/ambiguous
  // legacy associations must be surfaced instead of guessed.
  return null;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

const sessionSummary = z.object({
  id: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  finished: z.boolean(),
  verdict: z.string().nullable(),
  route_title: z.string().nullable(),
  route_id: z.string().nullable(),
});

type SessionSummary = z.infer<typeof sessionSummary>;

function stringFieldOf(data: string, field: string): string | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed != null && typeof parsed === "object" && field in parsed) {
      const v = (parsed as Record<string, unknown>)[field];
      if (typeof v === "string") return v;
    }
  } catch {
    // Unparsable data simply has no such field; the row still lists fine.
  }
  return null;
}

function toSummary(row: typeof schema.sessions.$inferSelect): SessionSummary {
  return {
    id: row.id,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    finished: row.finished,
    verdict: stringFieldOf(row.data, "verdict"),
    route_title: stringFieldOf(row.data, "routeTitle"),
    route_id: stringFieldOf(row.data, "routeId"),
  };
}

// ---------------------------------------------------------------------------
// Qloo key storage + product router (ported from app-standalone/server.py)
// ---------------------------------------------------------------------------

const QLOO_BASE = "https://hackathon.api.qloo.com";
const QLOO_KEY_SETTING = "qloo_api_key";

const ROUTER_CONFIG = {
  baseline_metrics: ["好感", "压迫感", "想听完"],
  baseline_scale: 10,
  step_metrics: ["熟悉", "陌生", "好感"],
  step_scale: 5,
  primary_metric: "好感",
  max_skip_per_step: 1,
  pass: { delta_min: 2, max_cliff_steps: 1, require_no_full_step_dropout: true },
} as const;

const SEARCH_TYPES = [
  "artist",
  "movie",
  "tv_show",
  "book",
  "person",
  "place",
  "podcast",
  "videogame",
  "brand",
  "album",
  "author",
]
  .map((t) => `urn:entity:${t}`)
  .join(",");

/** Scope of the auto-router (owner decision 2026-10-18): routes are built
 * only between entertainment-taste entities. `place` and `brand` are out
 * of scope for destinations and for every hop candidate. Seeds are the
 * user's home and stay unrestricted. */
const ALLOWED_TYPES = [
  "artist",
  "album",
  "book",
  "author",
  "movie",
  "tv_show",
  "videogame",
  "podcast",
  "person",
];

const ALLOWED_SEARCH_TYPES = ALLOWED_TYPES
  .map((t) => `urn:entity:${t}`)
  .join(",");

const TYPE_LABEL_ZH: Record<string, string> = {
  artist: "艺人",
  album: "专辑",
  book: "书",
  author: "作者",
  movie: "电影",
  tv_show: "剧集",
  videogame: "游戏",
  video_game: "游戏",
  podcast: "播客",
  person: "人物",
  place: "地点",
  brand: "品牌",
};

function isAllowedType(type_: string): boolean {
  const normalized = type_ === "video_game" ? "videogame" : type_;
  return ALLOWED_TYPES.includes(normalized);
}

class QlooAuthError extends Error {
  stage: string;
  constructor(message = "Qloo auth failed", stage = "other") {
    super(message);
    this.name = "QlooAuthError";
    this.stage = stage;
  }
}

class QlooRateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number | null;
  stage: string;
  constructor(retryAfterSeconds: number | null, stage = "other") {
    super("Qloo rate limited");
    this.name = "QlooRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.stage = stage;
  }
}

type QlooFailureReason =
  | "rate_limited"
  | "upstream_5xx"
  | "network"
  | "signal_unavailable"
  | "measurement_incomplete"
  | "request_rejected" | "forward_link_unverified";

type MeasurementCounts = {
  ring: number;
  eligible: number;
  hop_measured: number;
  home_measured: number;
  complete: number;
};

class QlooUpstreamError extends Error {
  status: number | null;
  reason: "upstream_5xx" | "network" | "signal_unavailable" | "measurement_incomplete" | "request_rejected" | "forward_link_unverified";
  stage: string;
  /** Rate-limit / 5xx / network failures may succeed on a later retry;
   * signal, measurement and request-rejection failures describe the
   * request itself and are NOT retryable as-is. */
  retryable: boolean;
  constructor(
    status: number | null,
    reason: "upstream_5xx" | "network" | "signal_unavailable" | "measurement_incomplete" | "request_rejected" | "forward_link_unverified",
    stage = "other",
    retryable = true,
  ) {
    super("Qloo upstream unavailable");
    this.name = "QlooUpstreamError";
    this.status = status;
    this.reason = reason;
    this.stage = stage;
    this.retryable = retryable;
  }
}

/** The entity is searchable, but Qloo cannot use it as a taste signal
 * (a 200 response whose warnings name one of THIS request's signal
 * entities as not_found). Carries the intersecting entity ids. */
class QlooSignalError extends QlooUpstreamError {
  entityIds: string[];
  constructor(entityIds: string[], stage = "other") {
    super(200, "signal_unavailable", stage, false);
    this.name = "QlooSignalError";
    this.entityIds = entityIds;
  }
}

/** The neighborhood existed but not enough affinities came back to
 * judge the route — distinct from "measured and genuinely far". */
class QlooMeasurementError extends QlooUpstreamError {
  counts: MeasurementCounts;
  constructor(counts: MeasurementCounts, stage = "other") {
    super(200, "measurement_incomplete", stage, false);
    this.name = "QlooMeasurementError";
    this.counts = counts;
  }
}

/** Qloo rejected the request itself (400/404/422). A 400 does NOT
 * prove the entity id is permanently invalid. */
class QlooRequestError extends QlooUpstreamError {
  constructor(status: number, stage = "other") {
    super(status, "request_rejected", stage, false);
    this.name = "QlooRequestError";
  }
}

// A verified provider reply for one signal/result-type pairing, not a
// global statement that the entity or every cross-media query is invalid.
class QlooSignalTypeError extends QlooRequestError {}

type CandidateNode={id:string;name:string;type:string};
type ReverseLink=ForwardLink & {signal_entity_ids:string[];basis:"entity"|"pack"};
type CandidateCheck={from_entity_id:string;to_entity_id:string;from_name:string;to_name:string;affinity:number|null;minimum:number};
type ForwardLink={from_entity_id:string;to_entity_id:string;from_name:string;to_name:string;affinity:number;minimum:number};
class QlooForwardLinkError extends QlooUpstreamError {
 constructor(readonly link:{from_entity_id:string;to_entity_id:string;from_name:string;to_name:string;affinity:number|null;minimum:number},stage:string,readonly candidateChain:CandidateNode[]=[],readonly verifiedLinks:ForwardLink[]=[],readonly candidateChecks:CandidateCheck[]=[],readonly candidateChainComplete=true){super(200,'forward_link_unverified',stage,false);this.name='QlooForwardLinkError';}
}

/** Any typed Qloo failure that must never be swallowed as "no data":
 * auth, rate-limit and upstream outages all abort the current build
 * instead of degrading into an empty result. */
function isQlooTypedError(
  e: unknown,
): e is QlooAuthError | QlooRateLimitError | QlooUpstreamError {
  return (
    e instanceof QlooAuthError ||
    e instanceof QlooRateLimitError ||
    e instanceof QlooUpstreamError
  );
}

type UpstreamErrorDetail = {
  reason: QlooFailureReason;
  status: number | null;
  stage: string;
  retry_after_seconds: number | null;
  retryable: boolean;
  /** Set on signal_unavailable (and on a rejected signal check): the
   * entity ids Qloo refused to compute with. */
  signal_entity_ids?: string[];
  /** Set on measurement_incomplete: what was actually measured. */
  link_check?: {from_entity_id:string;to_entity_id:string;from_name:string;to_name:string;affinity:number|null;minimum:number};
  candidate_chain?: CandidateNode[];
  candidate_chain_complete?: boolean;
  candidate_checks?: CandidateCheck[];
  verified_links?: ForwardLink[];
  measurement_counts?: MeasurementCounts;
};

const UPSTREAM_FRIENDLY_ERROR = "上游服务暂时不可用，请稍后再试。";
const SIGNAL_FRIENDLY_ERROR =
  "选中的一个条目虽然搜得到，但 Qloo 目前无法用它计算品味关联。尚不能判断路线是否走得通；请重新确认具体条目，目标和条件会保留。";
const MEASUREMENT_FRIENDLY_ERROR =
  "本次没有取得足够的关联数值，尚不能判断路线是否走得通。已保留目标与条件，请先核查具体条目。";
const REQUEST_REJECTED_FRIENDLY_ERROR =
  "Qloo 没有接受这次关联查询，暂时无法确认条目可用于计算。目标和条件已保留，请先重新核对具体条目。";

/** The single error-code mapping every Qloo-facing action uses:
 * signal_unavailable / measurement_incomplete / query_rejected for
 * the new typed failures, upstream_unavailable for rate-limit, 5xx
 * and network failures, auth for credential failures. */
function qlooFailureCode(e: unknown): string {
  if (e instanceof QlooForwardLinkError) return "forward_link_unverified";
  if (e instanceof QlooSignalError) return "signal_unavailable";
  if (e instanceof QlooMeasurementError) return "measurement_incomplete";
  if (e instanceof QlooRequestError) return "query_rejected";
  if (e instanceof QlooAuthError) return "auth";
  return "upstream_unavailable";
}

/** User-facing copy for a failure code from qlooFailureCode. */
function qlooFailureMessage(value: unknown): string {
  const code = typeof value === "string" ? value : qlooFailureCode(value);
  switch (code) {
    case "forward_link_unverified":
      return "本次核查的候选未通过正向连接验证，未保存路线。目标与条件已保留；这次检查范围有限，尚不能判断所有路线都走不通。";
    case "signal_unavailable":
      return SIGNAL_FRIENDLY_ERROR;
    case "measurement_incomplete":
      return MEASUREMENT_FRIENDLY_ERROR;
    case "query_rejected":
    case "signal_check_rejected":
      return REQUEST_REJECTED_FRIENDLY_ERROR;
    case "auth":
      return "密钥不对或已失效，请检查后重新保存";
    default:
      return UPSTREAM_FRIENDLY_ERROR;
  }
}

/** The entity ids a typed failure rejected, for audit/report use:
 * a signal error carries its intersecting ids; anything else has
 * none to name. */
function rejectedSignalIds(e: unknown, params?: Record<string,string>): string[] {
  if (params) return warningSignalIds(asObj(e), params);
  if (e instanceof QlooSignalError) return [...e.entityIds];
  return [];
}

function upstreamDetailFor(
  e: QlooRateLimitError | QlooUpstreamError,
): UpstreamErrorDetail {
  if (e instanceof QlooRateLimitError) {
    return {
      reason: "rate_limited",
      status: 429,
      stage: e.stage || "other",
      retry_after_seconds: e.retryAfterSeconds,
      retryable: true,
    };
  }
  const detail: UpstreamErrorDetail = {
    reason: e.reason,
    status: e.status,
    stage: e.stage || "other",
    retry_after_seconds: null,
    retryable: e.retryable,
  };
  if (e instanceof QlooForwardLinkError) {
   detail.link_check = {...e.link};
   detail.candidate_chain=e.candidateChain.map(({id,name,type})=>({id,name,type}));
   detail.verified_links=e.verifiedLinks.map(link=>({...link}));
   detail.candidate_chain_complete=e.candidateChainComplete;
   detail.candidate_checks=e.candidateChecks.map(link=>({...link}));
  }
  if (e instanceof QlooSignalError) detail.signal_entity_ids = [...e.entityIds];
  if (e instanceof QlooMeasurementError) detail.measurement_counts = { ...e.counts };
  return detail;
}

/** Retry-After per RFC 9110: either delta-seconds or an HTTP-date.
 * A date is converted to the remaining seconds until it (rounded up);
 * a date already in the past means "retry now" → 0. Unparseable
 * values stay null (no hint), never a guessed number. */
function parseRetryAfter(resp: Response): number | null {
  const raw = resp.headers.get("retry-after");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  const remaining = Math.ceil((when - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

function asObj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function qlooGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  stage = "other",
): Promise<Record<string, unknown>> {
  // Signal-failure guard: once this request has seen a signal
  // failure, no later send goes out at all.
  const qs = new URLSearchParams(params).toString();
  const url = `${QLOO_BASE}${path}?${qs}`;
  let resp: Response;
  try {
    resp = await trackedFetch(url, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (traceStorage.getStore()?.exhausted) throw e;
    const failed = traceStorage.getStore()?.signalFailure;
    if (failed) throw new QlooSignalError(failed.entityIds, failed.stage);
    throw new QlooUpstreamError(null, "network", stage);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new QlooAuthError("Qloo auth failed", stage);
  }
  if (resp.status === 429) {
    await resp.body?.cancel().catch(() => {});
    throw new QlooRateLimitError(parseRetryAfter(resp), stage);
  }
  // A rejected request (400/404/422) is its own typed failure, ahead
  // of the generic non-OK error; the upstream body is never echoed.
  if (resp.status === 400 || resp.status === 404 || resp.status === 422) {
    if(resp.status===400&&resp.headers.get(rejectionHeader)==='invalid_entity_signals')throw new QlooSignalTypeError(resp.status,stage);
    throw new QlooRequestError(resp.status, stage);
  }
  if (resp.status >= 500 && resp.status < 600) {
    await resp.body?.cancel().catch(() => {});
    throw new QlooUpstreamError(resp.status, "upstream_5xx", stage);
  }
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error("Qloo 请求被重定向，请核对端点");
  }
  if (!resp.ok) {
    if ([400,404,422].includes(resp.status)) throw new QlooRequestError(resp.status, stage);
    throw new Error(`Qloo 请求失败（HTTP ${resp.status}）`);
  }
  const data: unknown = await resp.json().catch(() => null);
  const obj = asObj(data);
  const rejected = warningSignalIds(obj, params);
  if (rejected.length) {
    const trace = traceStorage.getStore();
    if (trace) trace.signalFailure ??= {entityIds: rejected, stage, phase: currentPhase()};
    throw new QlooSignalError(rejected, stage);
  }
  return obj;
}

function warningSignalIds(data: Record<string, unknown>, params: Record<string, string>): string[] {
  const requested = (params["signal.interests.entities"] ?? "").split(",").filter(Boolean);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const rejected = new Set<string>();
  for (const value of warnings) {
    const w = asObj(value);
    if (w.type !== "not_found") continue;
    const ids = w["signal.interests.entities"] ?? asObj(asObj(w.signal).interests).entities;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") rejected.add(id.toLowerCase());
  }
  return requested.filter(id => rejected.has(id.toLowerCase()));
}

type EntBrief = {
  id: string;
  name: string;
  type: string;
  desc: string;
  website: string;
  address: string;
  year: number | null;
  /** One-line creator credit taken from the entity's own payload
   * (album artist, book author, movie director/cast, game developer…);
   * "" when the payload carries nothing usable. Display aid for
   * disambiguation candidates only — never invented. */
  byline: string;
  /** The entity's own cover/image URL from the payload; "" when none. */
  image: string;
  catalogHorror?: string[];
  catalogTags?: {id:string;name:string}[];
  entrySeries?: EntrySeries;
};

/** Qloo returns place addresses either as a plain string or as an object
 * with formatted_address; accept both shapes. */
function addrOf(props: Record<string, unknown>): string {
  const a = props.address;
  if (typeof a === "string") return a;
  return asStr(asObj(a).formatted_address);
}

/** Strip markup (book descriptions carry <b>/<br/> HTML) and collapse
 * whitespace so payload text can be shown as plain copy. */
function plainText(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Short description from the payload, in the order the catalog offers
 * it: the singular field, then the English entry of the plural list
 * (movies/TV often carry only the plural), then the long description. */
function shortDescOf(props: Record<string, unknown>): string {
  const single = asStr(props.short_description);
  if (single) return single;
  const list = props.short_descriptions;
  if (Array.isArray(list)) {
    const entries = list
      .map((x) => asObj(x))
      .filter((x) => typeof x.value === "string" && asStr(x.value).length > 0);
    const en = entries.find((x) => asStr(x.language) === "en") ?? entries[0];
    if (en) return asStr(en.value);
  }
  return asStr(props.description);
}

/** Release/publication year from the payload's year-ish fields:
 * dedicated year fields first (numeric or numeric-string), then the
 * year part of a date field. Null when the payload states no year. */
function yearOf(props: Record<string, unknown>): number | null {
  for (const key of ["release_year", "publication_year", "year"]) {
    const v = props[key];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d{4}$/.test(v.trim())) return Number(v.trim());
  }
  for (const key of ["release_date", "publication_date"]) {
    const v = props[key];
    if (typeof v === "string") {
      const m = v.match(/^(\d{4})/);
      if (m?.[1]) return Number(m[1]);
    }
  }
  return null;
}

/** Cover/image URL from the payload (`properties.image.url`); the image
 * field is sometimes an empty object, which yields "". */
function imageOf(props: Record<string, unknown>): string {
  return asStr(asObj(props.image).url);
}

/** First usable string among the given property keys: a plain string, or
 * the string elements of an array joined with ", " (max 2). */
function creditOf(props: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const parts = v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 2);
      if (parts.length > 0) return parts.join(", ");
    }
  }
  return "";
}

/** Qloo's own `disambiguation` string often reads "year, Name" for books
 * ("1980, Charlotte Lamb") and games ("2025-01-07, spektor"). Return the
 * trailing name when the head is a year/date and the tail is not itself
 * numeric ("2023,2023" for TV shows yields ""); "" otherwise. */
function disambTail(disambiguation: string): string {
  const m = disambiguation.match(/^\s*\d{4}(?:-\d{2}-\d{2})?\s*,\s*(.+)$/);
  const tail = (m?.[1] ?? "").trim();
  if (!tail || tail.length > 60) return "";
  if (/^[\d\s,./-]+$/.test(tail)) return "";
  return tail;
}

/** Director / lead-cast credits for movies and TV shows. The payload has
 * no structured credit fields, but its own description text is formulaic
 * ("…, directed by Brian De Palma and featuring Cliff Robertson, …");
 * extract from that text only, with tight delimiters, else "". */
function creditFromDescription(type_: string, description: string): string {
  if (type_ !== "movie" && type_ !== "tv_show") return "";
  const text = plainText(description);
  if (!text) return "";
  const dir = text.match(
    /directed by\s+(.+?)(?=\s+and\s+(?:starring|featuring)|,\s+is\s|\s+is\s+(?:a|an)\s|\.\s|\.$)/i,
  );
  const dirName = (dir?.[1] ?? "").trim();
  if (dirName.length >= 2 && dirName.length <= 70 && !/https?/i.test(dirName)) {
    return `导演 ${dirName}`;
  }
  const cast = text.match(
    /(?:starring|featuring)\s+(.+?)(?=\s+alongside\s|,\s+is\s|\s+is\s+(?:a|an)\s|\.\s|\.$)/i,
  );
  const firstCast = (cast?.[1] ?? "").split(/\s*,\s*|\s+and\s+/)[0]?.trim() ?? "";
  if (firstCast.length >= 2 && firstCast.length <= 60 && !/https?/i.test(firstCast)) {
    return `主演 ${firstCast}`;
  }
  return "";
}

/** One-line creator credit for a candidate card, taken only from fields
 * the entity's own payload carries; "" when it carries none. Priority
 * follows the type: album→artist, book→author, movie/TV→director or
 * lead cast, game→developer/publisher, podcast→host, person→citizenship. */
function bylineOf(
  type_: string,
  props: Record<string, unknown>,
  disambiguation: string,
): string {
  switch (type_) {
    case "album":
      return creditOf(props, ["artist", "artists", "artist_name"]);
    case "book": {
      const author = creditOf(props, ["author", "authors"]);
      return author || disambTail(disambiguation);
    }
    case "movie":
    case "tv_show": {
      const director = creditOf(props, ["director", "directors"]);
      if (director) return `导演 ${director}`;
      const cast = creditOf(props, ["cast", "starring", "actors", "stars"]);
      if (cast) return `主演 ${cast.split(/\s*,\s*/)[0] ?? cast}`;
      return creditFromDescription(type_, asStr(props.description));
    }
    case "videogame":
    case "video_game": {
      const dev = creditOf(props, ["developer", "developers", "publisher"]);
      return dev || disambTail(disambiguation);
    }
    case "podcast":
      return creditOf(props, ["host", "hosts", "presenter", "narrator", "creator"]);
    case "person":
      return creditOf(props, ["citizenship", "nationality", "occupation", "profession"]);
    default:
      return creditOf(props, ["author", "authors", "artist", "artists", "developer"]);
  }
}

function searchBrief(raw: unknown, fallbackName: string): EntBrief {
  const e = asObj(raw);
  const props = asObj(e.properties);
  const types = Array.isArray(e.types) ? e.types : [];
  const firstType =
    types.length > 0 ? String(types[0]).replace("urn:entity:", "") : (asStr(e.type)||asStr(e.subtype)).replace("urn:entity:", "");
  return {
    id: asStr(e.entity_id),
    name: asStr(e.name) || fallbackName,
    type: firstType,
    desc: shortDescOf(props).slice(0, 220),
    website: asStr(props.website),
    address: addrOf(props),
    year: yearOf(props),
    byline: bylineOf(firstType, props, asStr(e.disambiguation)),
    image: imageOf(props),
    catalogHorror: catalogHorrorLabels(e),
    catalogTags: catalogTasteTags(e),
    entrySeries: catalogEntrySeries(e),
  };
}

async function searchEntities(
  name: string,
  apiKey: string,
  types: string = SEARCH_TYPES,
  take?: number,
): Promise<EntBrief[]> {
  const d = await qlooGet("/search", { query: name, types, ...(take?{take:String(take)}:{}) }, apiKey, "resolve");
  const res: unknown = d.results;
  const entities: unknown[] = Array.isArray(res)
    ? res
    : Array.isArray(asObj(res).entities)
      ? (asObj(res).entities as unknown[])
      : [];
  return entities.map((e) => searchBrief(e, name)).filter((e) => e.id.length > 0);
}

// --- name resolution: sanity check + disambiguation -------------------------

/** A disambiguation candidate. Beyond the pin identity (id/name/type) it
 * carries the distinguishing facts the entity's own /search payload
 * offered — short description, year, creator byline, cover image — each
 * null when the payload had none, so same-name/same-type candidates can
 * be told apart without inventing anything. */
type PackMember = {
  id: string;
  name: string;
  type: string;
  year: number | null;
  /** True only for members the user added by hand in the pack editor;
   * automatic members omit the flag (or carry false). */
  manual?: boolean;
};

type PackInfo = {
  label: string;
  /** "all" = the whole-series pack (one work per type); otherwise the
   * single content type this flavor pack is made of (movie, tv_show,
   * book, album, videogame, podcast). Packs/pins written before flavors
   * existed carry no flavor and are treated as "all". */
  flavor: string;
  members: PackMember[];
};

type PinnedEnt = {
  id: string;
  name: string;
  type: string;
  desc: string | null;
  year: number | null;
  byline: string | null;
  image: string | null;
  pack?: boolean;
  label?: string | null;
  flavor?: string | null;
  members?: PackMember[] | null;
};

type NeedChoice = {
  field: "destination" | "seed";
  index: number | null;
  query: string;
  candidates: PinnedEnt[];
  hint: string;
  /** "choices": pick one of the candidates. "none_found": nothing in the
   * catalog plausibly matches — candidates stays empty and `closest`
   * carries up to 3 literally-nearest names as plain text only.
   * "out_of_scope": the destination only exists in the catalog as an
   * out-of-scope type (place/brand) — `scope_type_label` carries that
   * type's Chinese label for the boundary panel. */
  tier: "choices" | "none_found" | "out_of_scope";
  scope_type_label: string | null;
  closest: string[];
  /** The English name actually searched when this question came out of
   * the translation path (homonym group or conservative-adoption miss);
   * null when the question came straight from the original search. */
  via_translation: string | null;
  /** Series-pack flavors offered on top of a homonym choice panel:
   * the whole-series pack (flavor "all") plus one pack per content
   * type that can field ≥2 name-matching works. Null when no flavor
   * qualifies. */
  packs: PackInfo[] | null;
};

type ResolveOutcome =
  | {
      ok: true;
      ents: EntBrief[];
      /** Set when the entity was resolved through the Chinese→English
       * translation path, so the caller can leave an audit note. */
      via: { query: string; translation: string } | null;
      /** Set when a pack pin was resolved: ents holds every member. */
      pack: PackInfo | null;
    }
  | { ok: false; choice: NeedChoice };

const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/; // Han ranges: U+3400–4DBF, U+4E00–9FFF, U+F900–FAFF

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Sanity check that a search hit actually corresponds to what the user
 * typed, so Qloo's fragment matching can never silently snap a query onto
 * an unrelated entity (the "塔罗牌 → 火锅店" failure). Latin text: the
 * normalized names must contain each other, or ≥60% of the query's tokens
 * must appear in the candidate. Chinese text: ≥60% of the query's Han
 * characters must appear in the candidate name (the 60% bar absorbs
 * simplified/traditional differences like 乐/樂）. */
function nameMatch(query: string, candidateName: string): boolean {
  if (HAN_RE.test(query)) {
    const han = [...new Set([...query].filter((ch) => HAN_RE.test(ch)))];
    if (han.length === 0) return false;
    const hits = han.filter((ch) => candidateName.includes(ch)).length;
    return hits / han.length >= 0.6;
  }
  const q = normalizeName(query);
  const c = normalizeName(candidateName);
  if (!q || !c) return false;
  if (c.includes(q) || q.includes(c)) return true;
  const qTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (qTokens.size === 0) return false;
  const cTokens = new Set(candidateName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let inter = 0;
  for (const t of qTokens) if (cTokens.has(t)) inter += 1;
  return inter / qTokens.size >= 0.6;
}

/** Built-in Chinese→English aliases for common "territory" names. Only
 * the name sent to the catalog is translated; the user's original text
 * and narrative fields are never touched. Extend as new cases show up. */
const ZH_EN_ALIASES: Record<string, string> = {
  "哈利波特": "Harry Potter",
  "塔罗牌": "tarot cards",
  "塔罗": "tarot",
  "国际象棋": "international chess",
  "象棋": "chess",
  "占星术": "astrology",
  "占星": "astrology",
  "爵士乐": "jazz",
  "爵士": "jazz",
  "古典音乐": "classical music",
  "红酒": "wine",
  "葡萄酒": "wine",
  "威士忌": "whisky",
  "鸡尾酒": "cocktails",
  "咖啡": "coffee",
  "瑜伽": "yoga",
  "冥想": "meditation",
  "京剧": "Peking opera",
  "武侠": "wuxia",
  "科幻": "science fiction",
  "恐怖片": "horror movies",
  "悬疑": "mystery",
  "推理": "mystery",
  "摇滚": "rock music",
  "说唱": "hip hop",
  "民谣": "folk music",
  "摄影": "photography",
  "烘焙": "baking",
  "天文": "astronomy",
  "哲学": "philosophy",
  "心理学": "psychology",
  "神话": "mythology",
  "诗歌": "poetry",
  "芭蕾": "ballet",
  "歌剧": "opera",
  "音乐剧": "musicals",
};

/** Explicit confirmation searches keep related concrete works, not just
 * the first result's exact-title homonyms. No entity is auto-selected. */
async function confirmationCandidates(query:string,field:"destination"|"seed",apiKey:string):Promise<{ents:EntBrief[];translation:string|null}|null>{
  const normalized=normalizeName(query);
  const alias=Object.entries(ZH_EN_ALIASES).find(([name,value])=>normalizeName(name)===normalized||normalizeName(value)===normalized)?.[1];
  const translated=alias??(HAN_RE.test(query)?await translateName(query):null);
  const term=translated??query.trim();
  const types=field==='destination'?ALLOWED_SEARCH_TYPES:SEARCH_TYPES;
  const matches=(ent:EntBrief)=>nameMatch(term,ent.name)&&(!LATIN_RE.test(term)||normalizeName(term)===identityTitleKey(ent)||tokenMatch(term,ent.name));
  const allowed=field==='destination'?(ent:EntBrief)=>isAllowedType(ent.type):()=>true;
  const initial=await searchEntities(term,apiKey,types,50);
  const passing=initial.filter(ent=>allowed(ent)&&matches(ent));
  if(!passing.length)return null; // Preserve existing none-found/scope recovery.
  const deeper=await Promise.all(['book','movie'].map(async type=>
    (await searchEntities(term,apiKey,`urn:entity:${type}`,50)).filter(ent=>normEntType(ent.type)===type&&matches(ent))));
  return {ents:identityChoices([...passing,...deeper.flat()].filter(allowed),60),translation:translated&&normalizeName(translated)!==normalized?translated:null};
}

const LATIN_RE = /[A-Za-z]/;

/** English name for a Chinese catalog query: alias table first, then the
 * free MyMemory translation API (4s timeout). Any failure is silent —
 * resolution simply falls back to the original search's outcome. The
 * result is adopted only when it contains Latin letters and differs
 * from the original text. */
async function translateName(query: string): Promise<string | null> {
  const alias = ZH_EN_ALIASES[query];
  if (alias) return alias;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=zh-CN%7Cen`;
    const resp = await trackedFetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!resp.ok) return null;
    const data: unknown = await resp.json().catch(() => null);
    const text = asStr(asObj(asObj(data).responseData).translatedText).trim();
    if (!text || !LATIN_RE.test(text) || text === query) return null;
    return text;
  } catch {
    return null;
  }
}

/** A candidate is "cross-script" when it is written purely in the other
 * script system than the query (Han query → all-Latin name, or Latin
 * query → all-Han name). Such hits can't be name-checked, yet for
 * Chinese queries they are often the real entity under its foreign
 * title (甄嬛传 → Empresses in the Palace). Mixed-script names count as
 * neither. */
function isCrossScript(query: string, candidateName: string): boolean {
  const qHan = HAN_RE.test(query);
  const qLatin = LATIN_RE.test(query);
  const cHan = HAN_RE.test(candidateName);
  const cLatin = LATIN_RE.test(candidateName);
  if (qHan && !qLatin) return cLatin && !cHan;
  if (qLatin && !qHan) return cHan && !cLatin;
  return false;
}

/** Same-name ambiguity across the returned pool. Book series-position
 * suffixes are display metadata, not a different work title. */
function homonymGroup(results: EntBrief[]): EntBrief[] {
  const first = results[0];
  if (!first) return [];
  const norm = identityTitleKey(first);
  if (!norm) return [];
  const group = results.filter((e) => identityTitleKey(e) === norm);
  const types = new Set(group.map((e) => e.type));
  return group.length >= 2 && types.size >= 2 ? group : [];
}

function normEntType(t: string): string {
  return t === "video_game" ? "videogame" : t;
}

/** Series pack built by one uniform rule from a field's homonym pool:
 * walk the pool in Qloo search-rank order, keep the first work of each
 * allowed content type — no member cap: however many qualifying
 * types the pool holds is how many members the pack gets. Null when fewer than
 * 2 different allowed types are present (the caller then falls back
 * to the plain single-pick flow). The label is the user's own input.
 * This is the "all" (whole-series) flavor. */
function buildPack(label: string, pool: EntBrief[]): PackInfo | null {
  const seenTypes = new Set<string>();
  const members: PackMember[] = [];
  for (const e of pool) {
    const t = normEntType(e.type);
    if (!isAllowedType(t) || seenTypes.has(t)) continue;
    seenTypes.add(t);
    members.push({ id: e.id, name: e.name, type: t, year: e.year });
  }
  if (members.length < 2) return null;
  return { label, flavor: "all", members };
}

/** Content types that get their own flavor pack. A flavor pack holds
 * several works of this one type whose normalized name contains the
 * user's input name. */
const FLAVOR_TYPES = ["movie", "tv_show", "book", "album", "videogame", "podcast"];

/** Chinese name of a flavor as the user names the packs: the album
 * flavor is 「音乐」 (音乐包), not the candidate-card type label 「专辑」;
 * the other flavors coincide with their type labels. */
const FLAVOR_LABEL_ZH: Record<string, string> = {
  movie: "电影",
  tv_show: "剧集",
  book: "书",
  album: "音乐",
  videogame: "游戏",
  podcast: "播客",
};

function flavorLabelZh(flavor: string): string {
  return FLAVOR_LABEL_ZH[flavor] ?? TYPE_LABEL_ZH[flavor] ?? flavor;
}

/** Destination title for a pack: the whole-series pack keeps
 * 「{label} 系列」; a flavor pack is 「{label} 系列 · {类型中文}」. */
function packDestTitle(label: string, flavor: string | null | undefined): string {
  if (flavor && flavor !== "all") {
    return `${label} 系列 · ${flavorLabelZh(flavor)}`;
  }
  return `${label} 系列`;
}

/** Every pack flavor offered for one field, whole-series first, then
 * type flavors in FLAVOR_TYPES order. `homoPool` is the same-name
 * homonym group (basis of the "all" flavor); `fullPool` is the field's
 * full search result list in Qloo rank order (basis of the type
 * flavors). A type flavor keeps works of that type whose normalized
 * name contains the normalized search term — containment, so "the
 * batman", "batman: the movie" and "batman begins" all count for
 * "batman", and two distinct same-type entries with the same name
 * (two Batman albums) both count. Rank order is the search order.
 * There is no member cap: every matching work in the pool joins the
 * pack; a flavor with fewer than 2 members is not offered. One extra
 * type-filtered search always deepens the pool (the /search types
 * parameter supports a single-type filter); deepened candidates must
 * pass the same type + name-containment gate, and place/brand can
 * never enter. */
async function buildAllPacks(
  label: string,
  searchTerm: string,
  homoPool: EntBrief[],
  fullPool: EntBrief[],
  apiKey: string,
): Promise<PackInfo[] | null> {
  const packs: PackInfo[] = [];
  const all = buildPack(label, homoPool);
  if (all) packs.push(all);
  const needle = normalizeName(searchTerm);
  if (!needle) return packs.length > 0 ? packs : null;
  const matchesFlavor = (e: EntBrief, flavor: string): boolean =>
    normEntType(e.type) === flavor &&
    isAllowedType(flavor) &&
    normalizeName(e.name).includes(needle);
  const collect = (pool: EntBrief[], flavor: string, into: PackMember[], seen: Set<string>) => {
    for (const e of pool) {
      if (!matchesFlavor(e, flavor) || seen.has(e.id)) continue;
      seen.add(e.id);
      into.push({ id: e.id, name: e.name, type: normEntType(e.type), year: e.year });
    }
  };
  const flavors = await Promise.all(
    FLAVOR_TYPES.map(async (flavor) => {
      const members: PackMember[] = [];
      const seen = new Set<string>();
      collect(fullPool, flavor, members, seen);
      try {
        const typed = await searchEntities(searchTerm, apiKey, `urn:entity:${flavor}`);
        collect(typed, flavor, members, seen);
      } catch (e) {
        if (isQlooTypedError(e)) throw e;
        // A failed deepening search just leaves the pool as found.
      }
      return members.length >= 2 ? { label, flavor, members } : null;
    }),
  );
  for (const f of flavors) if (f) packs.push(f);
  return packs.length > 0 ? packs : null;
}

/** Token-level match for the translation path: ≥60% of the translation's
 * tokens appear as whole tokens in the candidate name, or ≥60% of the
 * candidate's tokens appear in the translation. Unlike nameMatch's
 * normalized-substring containment, this cannot be satisfied by a
 * phonetic echo — MyMemory transliterates gibberish like 阿巴阿巴 into
 * "Abaaba", whose letters happen to be a substring of the unrelated
 * "Aba Aba Ristorante"; no whole token is shared, so it never counts
 * as a translated hit. Real translations share whole words ("tarot
 * cards" → Modern Tarot; "X-Men: Battle 1" → X-Men). */
function tokenMatch(query: string, candidateName: string): boolean {
  const qTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const cTokens = new Set(candidateName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (qTokens.size === 0 || cTokens.size === 0) return false;
  let inter = 0;
  for (const t of qTokens) if (cTokens.has(t)) inter += 1;
  return inter / qTokens.size >= 0.6 || inter / cTokens.size >= 0.6;
}

/** Literal closeness used only to rank the "probably not yours" names
 * shown as plain text in a none_found panel: fraction of the query's
 * distinct Han characters (or Latin tokens) appearing in the name. */
function literalScore(query: string, candidateName: string): number {
  if (HAN_RE.test(query)) {
    const han = [...new Set([...query].filter((ch) => HAN_RE.test(ch)))];
    if (han.length === 0) return 0;
    return han.filter((ch) => candidateName.includes(ch)).length / han.length;
  }
  const q = normalizeName(query);
  const c = normalizeName(candidateName);
  if (!q || !c) return 0;
  if (c.includes(q) || q.includes(c)) return 1;
  const qTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (qTokens.size === 0) return 0;
  const cTokens = new Set(candidateName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let inter = 0;
  for (const t of qTokens) if (cTokens.has(t)) inter += 1;
  return inter / qTokens.size;
}

/** Pins select an ID; only a fresh catalogue match supplies entity facts.
 * Typed take=50 hydration covers the same per-type window used to offer
 * up to 60 confirmation choices. A missing ID never becomes client facts. */
async function hydratePinned(ref:{id:string;name:string;type:string},apiKey:string):Promise<EntBrief|null>{
  const type=normEntType(ref.type),typed=`urn:entity:${type}`;
  const types=SEARCH_TYPES.split(',').includes(typed)?typed:SEARCH_TYPES;
  const found=await searchEntities(ref.name,apiKey,types,50);
  let match=found.find(e=>e.id.toLowerCase()===ref.id.toLowerCase());
  if(!match&&types!==SEARCH_TYPES){
    const wider=await searchEntities(ref.name,apiKey,SEARCH_TYPES,50);
    match=wider.find(e=>e.id.toLowerCase()===ref.id.toLowerCase());
  }
  return match?{...match,type:normEntType(match.type)}:null;
}

async function resolveOne(
  query: string,
  pinned: PinnedEnt | null,
  field: "destination" | "seed",
  index: number | null,
  apiKey: string,
): Promise<ResolveOutcome> {
  if (pinned) {
    const fail=(ent?:EntBrief):ResolveOutcome=>({ok:false,choice:{field,index,query,candidates:[],hint:ent?'这个条目不属于可作为终点的娱乐作品，请重新选择。':'原先选择的条目暂时无法核实，请重新确认；不会替换成同名记录。',tier:ent?'out_of_scope':'none_found',scope_type_label:ent?(TYPE_LABEL_ZH[ent.type]??ent.type):null,closest:[],via_translation:null,packs:null}});
    if(pinned.pack){
      if(!pinned.members?.length)return fail();
      const ents:EntBrief[]=[];
      for(const member of pinned.members){
        const ent=await hydratePinned(member,apiKey);
        if(!ent)return fail();
        if(field==='destination'&&!isAllowedType(ent.type))return fail(ent);
        ents.push(ent);
      }
      const manualIds=new Set(pinned.members.filter(m=>m.manual).map(m=>m.id.toLowerCase()));
      return {ok:true,ents,via:null,pack:{label:pinned.label??pinned.name,flavor:pinned.flavor??'all',members:ents.map(e=>({id:e.id,name:e.name,type:e.type,year:e.year,...(manualIds.has(e.id.toLowerCase())?{manual:true}:{})}))}};
    }
    const ent=await hydratePinned(pinned,apiKey);
    if(!ent)return fail();
    if(field==='destination'&&!isAllowedType(ent.type))return fail(ent);
    return {ok:true,ents:[ent],via:null,pack:null};
  }
  const toPinned = (e: EntBrief): PinnedEnt => {
    // Candidate-card facts, all from this entity's own payload: the
    // short description as plain text trimmed to ~60 chars, plus year,
    // byline and cover image when the payload carried them.
    const cardDesc = plainText(e.desc);
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      desc: cardDesc ? (cardDesc.length > 63 ? `${cardDesc.slice(0, 60)}…` : cardDesc) : null,
      year: e.year,
      byline: e.byline || null,
      image: e.image || null,
    };
  };
  const hint = HAN_RE.test(query)
    ? "中文名在这个目录里经常查不准，换英文名或具体作品名通常立刻就好"
    : "没找到对得上的，你看看是不是下面哪个";
  // Re-confirmation is always an explicit user choice: a picked
  // candidate is never silently replaced by a same-name record.
  const homoHint =
    "请确认具体条目；同名同年也可能是不同记录，不会自动替换你的选择。";

  // Step 1+4: search the original text; a same-name/different-type group
  // in the top 6 forces disambiguation even when the first hit passes.
  // The destination search is scoped to the allowed entertainment types;
  // seeds keep the full type list.
  const scoped = field === "destination";
  const searchTypes = scoped ? ALLOWED_SEARCH_TYPES : SEARCH_TYPES;
  const results = await searchEntities(query, apiKey, searchTypes);
  if (results.length === 0 && !scoped) throw new Error(`找不到实体：${query}`);
  const top6 = results.slice(0, 6);
  const homo = homonymGroup(results);
  if (homo.length > 0) {
    return {
      ok: false,
      choice: {
        field,
        index,
        query,
        candidates: identityChoices(homo).map(toPinned),
        hint: homoHint,
        tier: "choices",
        scope_type_label: null,
        closest: [],
        via_translation: null,
        packs: await buildAllPacks(query, query, homo, results, apiKey),
      },
    };
  }
  // Every hit that passes the name check, in search order. Callers use
  // the first; the destination may fall through to later passing hits
  // when an earlier one turns out to be a taste-graph dead end.
  const passing = results.filter((e) => nameMatch(query, e.name));
  if (passing.length > 0) return { ok: true, ents: passing, via: null, pack: null };

  // Step 2+3: nothing passed and the input is Chinese — translate the
  // name (alias table, else MyMemory) and search again in English.
  let translation: string | null = null;
  let translationHadPassing = false;
  if (HAN_RE.test(query)) {
    translation = await translateName(query);
  }
  if (translation) {
    const tResults = await searchEntities(translation, apiKey, searchTypes).catch((e: unknown) => {
      if (isQlooTypedError(e)) throw e;
      return [] as EntBrief[];
    });
    if (tResults.length > 0) {
      const tHomo = homonymGroup(tResults);
      if (tHomo.length > 0) {
        return {
          ok: false,
          choice: {
            field,
            index,
            query,
            candidates: identityChoices(tHomo).map(toPinned),
            hint: homoHint,
            tier: "choices",
            scope_type_label: null,
            closest: [],
            via_translation: translation,
            packs: await buildAllPacks(query, translation, tHomo, tResults, apiKey),
          },
        };
      }
      // A translated hit counts only when it passes nameMatch AND
      // shares whole tokens with the translation (see tokenMatch):
      // substring-only passes are phonetic-echo fragment matches.
      const tPassing = tResults.filter(
        (e) => nameMatch(translation, e.name) && tokenMatch(translation, e.name),
      );
      if (tPassing.length > 0) {
        translationHadPassing = true;
        // Conservative auto-adopt: only when the original search held no
        // cross-script candidate the name check couldn't judge, or the
        // translated winner also surfaced in the original top 6. For a
        // scoped destination the gate is judged against the FULL-type
        // original search (what this pipeline saw before scoping): the
        // scoped top 6 is full of Latin-named fragment hits that would
        // otherwise block every adoption （塔罗牌 → tarot cards).
        let gateTop6 = top6;
        if (scoped) {
          try {
            const fullOriginal = await searchEntities(query, apiKey);
            if (fullOriginal.length > 0) gateTop6 = fullOriginal.slice(0, 6);
          } catch (e) {
            if (isQlooTypedError(e)) throw e;
          }
        }
        const hasCross = gateTop6.some((e) => isCrossScript(query, e.name));
        const first = tPassing[0];
        const firstInOriginal =
          first != null &&
          (top6.some((e) => e.id === first.id) ||
            gateTop6.some((e) => e.id === first.id));
        if (!hasCross || firstInOriginal) {
          return { ok: true, ents: tPassing, via: { query, translation }, pack: null };
        }
      }
    }
  }

  // Step 5: fallback disambiguation from the ORIGINAL search results.
  // Cross-script hits can't be name-checked but are often the real
  // entity — keep them as clickable candidates. When every hit is
  // same-script fragment garbage, say "not found" plainly instead of
  // dressing the fragments up as choices.
  const hasCross = top6.some((e) => isCrossScript(query, e.name));
  if (hasCross && !scoped) {
    return {
      ok: false,
      choice: {
        field,
        index,
        query,
        candidates: top6.map(toPinned),
        hint,
        tier: "choices",
        scope_type_label: null,
        closest: [],
        via_translation: translation,
        packs: null,
      },
    };
  }
  // Scope boundary (destination only): nothing in the allowed types
  // passed, but the same wording in a FULL-type search hits an
  // out-of-scope entity (e.g. 国际象棋 → an academy, a place). That is
  // not "not found" and not "rephrase it" — the word lives outside the
  // entertainment map. This check runs BEFORE the cross-script fallback
  // below: cross-script hits were never name-checked （国际象棋's scoped
  // top 6 is Latin-named fragment garbage like "The Matrix"), so they
  // must not outrank a demonstrated boundary hit. Check the original
  // wording and, when the translation path ran, the translated wording
  // too (the academy is only name-matchable in English).
  if (scoped && !translationHadPassing) {
    const pools: { q: string; list: EntBrief[] }[] = [];
    try {
      pools.push({ q: query, list: await searchEntities(query, apiKey) });
    } catch (e) {
      if (isQlooTypedError(e)) throw e;
    }
    if (translation) {
      try {
        pools.push({
          q: translation,
          list: await searchEntities(translation, apiKey),
        });
      } catch (e) {
        if (isQlooTypedError(e)) throw e;
      }
    }
    for (const pool of pools) {
      const hit = pool.list
        .slice(0, 6)
        .find((e) => !isAllowedType(e.type) && nameMatch(pool.q, e.name));
      if (hit) {
        return {
          ok: false,
          choice: {
            field,
            index,
            query,
            candidates: [],
            hint,
            tier: "out_of_scope",
            scope_type_label: TYPE_LABEL_ZH[hit.type] ?? hit.type,
            closest: [],
            via_translation: translation,
            packs: null,
          },
        };
      }
    }
  }
  // Scoped fallback, after the boundary check: cross-script hits from
  // the allowed-type search stay available as clickable candidates.
  if (hasCross) {
    return {
      ok: false,
      choice: {
        field,
        index,
        query,
        candidates: top6.map(toPinned),
        hint,
        tier: "choices",
        scope_type_label: null,
        closest: [],
        via_translation: translation,
        packs: null,
      },
    };
  }
  const closest = top6
    .map((e, i) => ({ name: e.name, score: literalScore(query, e.name), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.name);
  return {
    ok: false,
    choice: {
      field,
      index,
      query,
      candidates: [],
      hint,
      tier: "none_found",
      scope_type_label: null,
      closest,
      via_translation: null,
      packs: null,
    },
  };
}

async function insightsEntities(
  type_: string,
  signalIds: string[],
  apiKey: string,
  take = 50,
  page = 1,
): Promise<unknown[]> {
  const d = await qlooGet(
    "/v2/insights",
    {
      "filter.type": `urn:entity:${type_}`,
      "signal.interests.entities": signalIds.join(","),
      take: String(take),
      page: String(page),
    },
    apiKey,
    "ring",
  );
  const results = asObj(d.results);
  return Array.isArray(results.entities) ? (results.entities as unknown[]) : [];
}

async function oracle(
  type_: string,
  signalIds: string[],
  candidateIds: string[],
  apiKey: string,
  stage = "measure",
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < candidateIds.length; i += 5) {
    const batch = candidateIds.slice(i, i + 5);
    const d = await qlooGet(
      "/v2/insights",
      {
        "filter.type": `urn:entity:${type_}`,
        "signal.interests.entities": signalIds.join(","),
        "filter.results.entities": batch.join(","),
        take: String(batch.length),
      },
      apiKey,
      stage,
    );
    const results = asObj(d.results);
    const entities = Array.isArray(results.entities) ? (results.entities as unknown[]) : [];
    for (const raw of entities) {
      const e = asObj(raw);
      const aff = asObj(e.query).affinity;
      if (typeof aff === "number") {
        out[asStr(e.entity_id)] = Math.round(aff * 1000) / 1000;
      }
    }
  }
  return out;
}

/** Signal-validity probe for series-pack members, run once after a pack
 * is chosen and before any route is built: a member counts as live when
 * Qloo returns a non-empty taste-tag profile for it, or a non-empty
 * neighborhood for its own type. Members failing both probes are
 * dropped by the caller (and named in the route provenance). */
async function validatePackMembers(
  members: EntBrief[],
  apiKey: string,
): Promise<{ kept: EntBrief[]; dropped: EntBrief[] }> {
  const kept: EntBrief[] = [];
  const dropped: EntBrief[] = [];
  const checks = await Promise.all(
    members.map(async (m) => {
      try {
        const profile = await tagProfile([m.id], apiKey);
        if (profile.size > 0) return true;
      } catch (e) {
        if (isQlooTypedError(e)) throw e;
      }
      try {
        const ring = await insightsEntities(normEntType(m.type), [m.id], apiKey, 5, 1);
        if (ring.length > 0) return true;
      } catch (e) {
        if (isQlooTypedError(e)) throw e;
      }
      return false;
    }),
  );
  members.forEach((m, i) => {
    if (checks[i]) kept.push(m);
    else dropped.push(m);
  });
  return { kept, dropped };
}

// --- per-step "why" (seed attribution + shared taste tags) -----------------
//
// Every main step of an auto-built route carries a human-readable reason
// built ONLY from measured Qloo data:
//   1. Attribution — which seed pulled this step in. Preferred source:
//      /v2/insights with feature.explainability=true, whose per-result
//      query.explainability["signal.interests.entities"] gives each input
//      seed's contribution score (verified live 2026-10-19: Doctor Who +
//      Modern Family → Modern Tarot scored 0.452 / 0.548). When a step
//      comes back without explainability, fall back to a per-seed oracle
//      (the step scored against each seed alone; highest affinity wins).
//   2. Shared tags — the step entity's taste-tag profile intersected with
//      the attributed seed's profile (profiles: /v2/insights with the
//      entity as signal, filter.type=urn:tag, results.tags). Only taste
//      families count; noise families observed in real profiles
//      (credit_card, cost_description, inclusivity, specialty_dish,
//      hotel_rating, …) and place/brand-scoped tags never enter a reason;
//      within the surviving families, only the quotable pool is matched
//      or quoted ("+"-prefixed compound tags and fan/audience tags like
//      "X Fans" are excluded). Matching is normalized (trim + lowercase on the tag name, and the
//      tag URN compared lowercase too): Qloo's vocabulary is not uniform
//      (Doctor Who carries "Alien", Star Wars carries "alien"), so a
//      case-only difference must still count as the same tag.
//   3. Tag kinship — Qloo also uses different words for the same idea on
//      the two sides ("Comic Book" vs "Comics"), which no string
//      intersection can see. Qloo's own tag graph can: /v2/insights
//      accepts a tag itself as the signal (signal.interests.tags=<tag
//      URN>, filter.type=urn:tag) and returns that tag's relatives with
//      affinities. The explanation stage reuses measured relatives first,
//      with at most two new expansions per route. Every station receives
//      its routing facts and exact shared-tag explanation before expansion.
//      Kinship reasons require a measured affinity >= 0.90.
//   4. The sentence is template-assembled from those facts only.

/** Explanation completeness of one step (two-stage why contract):
 * complete = a measured tag-level explanation (shared tags or a
 * kinship pair); partial = measured attribution/edge facts only, no
 * tag-level explanation; missing = no measured explanation facts at
 * all — the step then carries NO sentence (text is ""). */
type ExplanationStatus = "complete" | "partial" | "missing";

type WhyObj = {
  text: string;
  seed: string | null;
  seed_id: string | null;
  tags: string[];
  explanation_status?: ExplanationStatus;
  routing_text?: string;
  routing_link?: ReverseLink;
  via: "explainability" | "oracle" | "kinship" | null;
  /** Legacy field from the retired theme-cluster layer: no longer
   * written with a value (always null on new routes). Kept in the shape
   * so stored routes stay uniform; the client never reads it. */
  cluster?: string | null;
  /** [seed-side tag name, step-side tag name] quoted by a kinship
   * sentence (original spellings), or null without a kinship hit. */
  pair?: [string, string] | null;
  /** Kin affinity Qloo returned for the quoted tag pair (kinship hits
   * only); null otherwise. */
  kin_affinity?: number | null;
};

/** Normalized match key for a tag name: trim + lowercase. */
function normTagName(name: string): string {
  return name.trim().toLowerCase();
}

const TASTE_TAG_FAMILIES = new Set([
  "genre",
  "subgenre",
  "theme",
  "keyword",
  "style",
  "plot",
  "character",
  "archetype",
  "mood",
  "tone",
  "motif",
  "setting",
]);

/** A tag_id looks like urn:tag:<family>:<scope>:<value>. Only taste
 * content families pass, and place/brand-scoped tags (genre:place:*,
 * genre:brand:*) are place/brand descriptors, not taste. */
function isTasteTag(tagId: string): boolean {
  const parts = tagId.split(":");
  if (parts[0] !== "urn" || parts[1] !== "tag") return false;
  const family = parts[2] ?? "";
  if (!TASTE_TAG_FAMILIES.has(family)) return false;
  const scope = parts[3] ?? "";
  if (scope === "place" || scope === "brand") return false;
  return true;
}

/** The quotable pool: taste tags that may be quoted in a reason, matched
 * against, or used as a kinship-expansion source. On top of the family
 * allowlist, two name shapes are excluded — names starting with "+"
 * (Qloo's compound demographic tags, e.g. "+young Adult") and
 * fan/audience tags ("X Fans", "X Enthusiasts"): they describe who
 * consumes a work, not what the work is. */
function isQuotableTag(name: string): boolean {
  if (name.startsWith("+")) return false;
  if (/(?:^|\s)(fans?|enthusiasts?)$/i.test(name)) return false;
  return true;
}

/** Quotable subset of a tag profile, as a list. */
function quotableTags(profile: Map<string, TagInfo>): TagInfo[] {
  return [...profile.values()].filter((t) => isQuotableTag(t.name));
}

type TagInfo = { id: string; name: string; affinity: number };

/** Taste-tag profile of one or more signal entities (results.tags of a
 * urn:tag insights call), taste-filtered, keyed by tag_id. */
async function tagProfile(
  signalIds: string[],
  apiKey: string,
  stage = "profile",
): Promise<Map<string, TagInfo>> {
  const out = new Map<string, TagInfo>();
  const d = await qlooGet(
    "/v2/insights",
    {
      "filter.type": "urn:tag",
      "signal.interests.entities": signalIds.join(","),
      take: "50",
    },
    apiKey,
    stage,
  );
  const results = asObj(d.results);
  const rawTags = Array.isArray(results.tags) ? (results.tags as unknown[]) : [];
  for (const t of rawTags) {
    const to = asObj(t);
    const id = asStr(to.tag_id);
    const name = asStr(to.name).trim();
    if (!id || !name || !isTasteTag(id) || out.has(id)) continue;
    const aff = asObj(to.query).affinity;
    out.set(id, { id, name, affinity: typeof aff === "number" ? aff : 0 });
  }
  return out;
}

/** Shared measured-data cache for ONE whole route-building call
 * (call-reduction package): tag profiles and tag-relative lists are
 * fetched at most once per entity/tag per build and reused by the
 * constraint machinery, the motivation matcher, attachWhys and the
 * kinship expansion — no stage keeps a private re-read path. The
 * scope is a single buildRoute action invocation (including its
 * destination fall-through attempts and a reroute's tail rebuild):
 * wider sharing would serve stale taste data across user actions. */
type SharedQlooCache = {
  profiles: Map<string, Promise<Map<string, TagInfo>>>;
  relatives: Map<string, Promise<KinRelative[]>>;
};

function newSharedQlooCache(): SharedQlooCache {
  return { profiles: new Map(), relatives: new Map() };
}

/** tagProfile through the shared cache (failures are NOT cached as
 * successes: a rejected promise is dropped so a later stage may see
 * the real outcome again — and typed errors still propagate). */
function sharedTagProfile(
  cache: SharedQlooCache,
  id: string,
  apiKey: string,
  stage = "profile",
): Promise<Map<string, TagInfo>> {
  const cached = cache.profiles.get(id);
  if (cached) return cached;
  const p = tagProfile([id], apiKey, stage).catch((e: unknown) => {
    cache.profiles.delete(id);
    throw e;
  });
  cache.profiles.set(id, p);
  return p;
}

/** One kinship-map entry: a relative of a seed tag, as measured by a
 * tag-signal insights call (the relative's own name + affinity). */
type KinRelative = { name: string; affinity: number };

/** Relatives of one tag in Qloo's tag graph: the tag itself as the
 * signal (signal.interests.tags=<tag URN>), filter.type=urn:tag.
 * Returns the raw (name, affinity) pairs from results.tags. */
async function tagRelatives(
  tagUrn: string,
  apiKey: string,
): Promise<KinRelative[]> {
  const d = await qlooGet(
    "/v2/insights",
    {
      "filter.type": "urn:tag",
      "signal.interests.tags": tagUrn,
      take: "30",
    },
    apiKey,
    "why",
  );
  const results = asObj(d.results);
  const rawTags = Array.isArray(results.tags) ? (results.tags as unknown[]) : [];
  const out: KinRelative[] = [];
  for (const t of rawTags) {
    const to = asObj(t);
    const name = asStr(to.name).trim();
    const aff = asObj(to.query).affinity;
    if (!name || typeof aff !== "number") continue;
    out.push({ name, affinity: aff });
  }
  return out;
}

/** tagRelatives through the shared cache: the motivation matcher and
 * the why kinship expansion read the SAME measured relative lists. */
function sharedTagRelatives(
  cache: SharedQlooCache,
  tagUrn: string,
  apiKey: string,
): Promise<KinRelative[]> {
  const cached = cache.relatives.get(tagUrn);
  if (cached) return cached;
  const p = tagRelatives(tagUrn, apiKey).catch((e: unknown) => {
    cache.relatives.delete(tagUrn);
    throw e;
  });
  cache.relatives.set(tagUrn, p);
  return p;
}

/** Per-candidate seed attribution from explainability: for each candidate
 * id, the input seed with the highest contribution score. Candidates the
 * response carries no explainability for are simply absent from the map. */
async function explainAttribution(
  type_: string,
  seedIds: string[],
  candidateIds: string[],
  apiKey: string,
): Promise<Map<string, { seedId: string; score: number }>> {
  const out = new Map<string, { seedId: string; score: number }>();
  for (let i = 0; i < candidateIds.length; i += 5) {
    const batch = candidateIds.slice(i, i + 5);
    const d = await qlooGet(
      "/v2/insights",
      {
        "filter.type": `urn:entity:${type_}`,
        "signal.interests.entities": seedIds.join(","),
        "filter.results.entities": batch.join(","),
        "feature.explainability": "true",
        take: String(batch.length),
      },
      apiKey,
      "why",
    );
    const results = asObj(d.results);
    const entities = Array.isArray(results.entities) ? (results.entities as unknown[]) : [];
    for (const raw of entities) {
      const e = asObj(raw);
      const contribs = asObj(asObj(e.query).explainability)[
        "signal.interests.entities"
      ];
      if (!Array.isArray(contribs)) continue;
      let best: { seedId: string; score: number } | null = null;
      for (const c of contribs) {
        const co = asObj(c);
        const sid = asStr(co.entity_id);
        const score = co.score;
        if (
          sid &&
          typeof score === "number" &&
          (best == null || score > best.score)
        ) {
          best = { seedId: sid, score };
        }
      }
      if (best) out.set(asStr(e.entity_id), best);
    }
  }
  return out;
}

// Optional explanations reuse measured tag relatives and permit at most two
// additional expansions across the whole route. Selection rules are unchanged.
type KinEntry = { seedTag: TagInfo; kinAffinity: number };
type KinshipMap = Map<string, KinEntry>;
type ExplanationBudget = {
  relativesUsed:number; relativesCap:number;
  profilesUsed:number; profilesCap:number; failures:number;
};
function newExplanationBudget(profileCap:number):ExplanationBudget {
  return {relativesUsed:0,relativesCap:2,profilesUsed:0,profilesCap:profileCap,failures:0};
}

type KinHit = {
  seedTag: TagInfo;
  stepTag: TagInfo;
  kinAffinity: number;
};

/** Minimum kin affinity for a kinship reason to count. */
const KIN_MIN_AFFINITY = 0.9;

/** Best kinship hit for a step: every quotable step tag that appears in
 * the seed's kinship map with kin affinity ≥ 0.90 is a candidate pair;
 * pairs rank by kin affinity, ties by the weaker side's tag affinity. */
function bestKinHit(
  kinship: KinshipMap,
  stepTags: TagInfo[],
): KinHit | null {
  let best: KinHit | null = null;
  let bestMin = -1;
  for (const t of stepTags) {
    const entry = kinship.get(normTagName(t.name));
    if (!entry || entry.kinAffinity < KIN_MIN_AFFINITY) continue;
    const minAff = Math.min(entry.seedTag.affinity, t.affinity);
    if (
      !best ||
      entry.kinAffinity > best.kinAffinity ||
      (entry.kinAffinity === best.kinAffinity && minAff > bestMin)
    ) {
      best = { seedTag: entry.seedTag, stepTag: t, kinAffinity: entry.kinAffinity };
      bestMin = minAff;
    }
  }
  return best;
}

function composeKinshipWhy(
  seedName: string,
  hit: KinHit,
): { text: string; pair: [string, string] } {
  const pair: [string, string] = [hit.seedTag.name, hit.stepTag.name];
  return {
    text: `因为你喜欢《${seedName}》——你那边的『${hit.seedTag.name}』和这一步的『${hit.stepTag.name}』，在 Qloo 的标签图里是 ${hit.kinAffinity.toFixed(2)} 的近亲。`,
    pair,
  };
}

function composeWhy(seedName: string | null, tags: string[]): string {
  if (seedName && tags.length > 0) {
    return `因为你喜欢《${seedName}》——这一步和它同属 ${tags.join("、")} 的气质。`;
  }
  if (seedName) {
    return `Qloo 测得它与你喜欢的《${seedName}》存在关联。`;
  }
  return "Qloo 的品味图显示它与你的口味相邻，但这个条目数据较薄，说不出更具体的理由。";
}

/** Explain from measured routing facts first; enrichment never erases them.
 * All exact-tag comparisons finish before bounded kinship expansion, so one
 * station cannot consume the budget before the others receive their reasons. */
type ExplainStep = {
    entity_id: string;
    type: string;
    why: WhyObj | null;
    aff_from_seeds?: number | null;
    reverse_link?: ReverseLink;
    is_destination?: boolean;
};
function explanationStatusFor(steps: unknown[]): ExplanationStatus {
    const states = steps.map(s => { const why = asObj(asObj(s).why); return asStr(why.explanation_status) || (asStr(why.text) ? 'partial' : 'missing'); });
    return states.length && states.every(s => s === 'complete') ? 'complete' : states.every(s => s === 'missing') ? 'missing' : 'partial';
}
function routingWhy(step: ExplainStep, seeds: EntBrief[]): WhyObj {
    const facts: string[] = [];
    const home = step.aff_from_seeds;
    const single = seeds.length === 1 && typeof home === 'number' && Number.isFinite(home) ? seeds[0] : null;
    if (step.is_destination)
        facts.push('这是你选定的目的地，前面的作品围绕它倒推选择。');
    if (typeof home === 'number' && Number.isFinite(home))
        facts.push(`它与你${single ? `喜欢的《${single.name}》` : '的已有喜欢'}有实测关联（${home.toFixed(3)}）。`);
    const link = step.reverse_link;
    const routingText = link && link.to_entity_id === step.entity_id
        ? `为了靠近《${link.from_name}》${link.basis === 'pack' ? '系列' : ''}，Agent 以它为线索找到了这一站（倒推关联 ${link.affinity.toFixed(3)}）。` : '';
    if (routingText) facts.push(routingText);
    return { text: facts.join(''), routing_text:routingText, routing_link:link, seed: single?.name ?? null, seed_id: single?.id ?? null, tags: [], via: single ? 'oracle' : null, cluster: null, pair: null, kin_affinity: null, explanation_status: facts.length ? 'partial' : 'missing' };
}
async function attachWhys(steps: ExplainStep[], seeds: EntBrief[], apiKey: string, cache?: SharedQlooCache): Promise<ExplanationStatus> {
    const shared = cache ?? newSharedQlooCache();
    const budget = newExplanationBudget(seeds.length + steps.length + 4);
    // At most two NEW kinship reads for the whole route; cached facts are free.
    budget.relativesCap = 2;
    const base = new Map(steps.map(step => [step.entity_id, routingWhy(step, seeds)]));
    for (const step of steps)
        step.why = base.get(step.entity_id)!;
    const profiles = new Map<string, Map<string, TagInfo>>();
    const profileFor = async (id: string) => {
        if (profiles.has(id))
            return profiles.get(id)!;
        let profile = new Map<string, TagInfo>();
        try {
            if (shared.profiles.has(id) || budget.profilesUsed < budget.profilesCap) {
                budget.profilesUsed++;
                profile = await sharedTagProfile(shared, id, apiKey);
            }
        }
        catch {
            budget.failures++;
        }
        profiles.set(id, profile);
        return profile;
    };
    const attribution = new Map<string, {
        seedId: string;
        via: 'explainability' | 'oracle';
    }>();
    for (const step of steps) {
        const why = base.get(step.entity_id)!;
        if (why.seed_id)
            attribution.set(step.entity_id, { seedId: why.seed_id, via: 'oracle' });
    }
    // Only query missing attribution; a measured single-seed home score already
    // identifies its source. Never assign a multi-seed score to one named seed.
    const byType = new Map<string, string[]>();
    for (const step of steps)
        if (!attribution.has(step.entity_id) && !step.is_destination) {
            const ids = byType.get(step.type) ?? [];
            ids.push(step.entity_id);
            byType.set(step.type, ids);
        }
    for (const [type, ids] of byType) {
        try {
            for (const [id, hit] of await explainAttribution(type, seeds.map(s => s.id), ids, apiKey))
                if (seeds.some(s => s.id === hit.seedId))
                    attribution.set(id, { seedId: hit.seedId, via: 'explainability' });
        }
        catch {
            budget.failures++;
        }
        const missing = ids.filter(id => !attribution.has(id));
        if (missing.length) {
            const best = new Map<string, {
                seedId: string;
                aff: number;
            }>();
            for (const seed of seeds) {
                try {
                    const scores = await oracle(type, [seed.id], missing, apiKey);
                    for (const id of missing) {
                        const aff = scores[id];
                        if (aff != null && (!best.has(id) || aff > best.get(id)!.aff))
                            best.set(id, { seedId: seed.id, aff });
                    }
                }
                catch {
                    budget.failures++;
                }
            }
            for (const [id, hit] of best)
                attribution.set(id, { seedId: hit.seedId, via: 'oracle' });
        }
    }
    const unresolved: {
        step: ExplainStep;
        seed: EntBrief;
        seedPool: TagInfo[];
        stepPool: TagInfo[];
    }[] = [];
    for (const step of steps) {
        const attr = attribution.get(step.entity_id), seed = seeds.find(s => s.id === attr?.seedId);
        if (!seed)
            continue;
        const seedPool = quotableTags(await profileFor(seed.id)), stepPool = quotableTags(await profileFor(step.entity_id));
        const names = new Map<string, {
            name: string;
            strength: number;
        }>();
        for (const t of stepPool) {
            const match = seedPool.find(x => x.id.toLowerCase() === t.id.toLowerCase() || normTagName(x.name) === normTagName(t.name));
            if (match) {
                const key = normTagName(t.name), strength = Math.min(t.affinity, match.affinity);
                if (!names.has(key) || strength > names.get(key)!.strength)
                    names.set(key, { name: t.name, strength });
            }
        }
        const tags = [...names.values()].sort((a, b) => b.strength - a.strength).slice(0, 3).map(t => t.name);
        const routing = base.get(step.entity_id)!;
        step.why = { ...routing, text: tags.length ? composeWhy(seed.name, tags) + routing.text : routing.text || composeWhy(seed.name, []), seed: seed.name, seed_id: seed.id, tags, via: attr!.via, explanation_status: tags.length ? 'complete' : 'partial' };
        if (!tags.length && seedPool.length && stepPool.length)
            unresolved.push({ step, seed, seedPool, stepPool });
    }
    // Read already measured relatives first, then at most two new tag signals.
    // Every successful hit is applied immediately; a later timeout cannot erase it.
    const sources = new Map<string, TagInfo>();
    for (const row of unresolved)
        for (const tag of row.seedPool)
            if (!sources.has(tag.id))
                sources.set(tag.id, tag);
    const ordered = [...sources.values()].sort((a, b) => Number(shared.relatives.has(b.id)) - Number(shared.relatives.has(a.id)) || b.affinity - a.affinity);
    for (const tag of ordered) {
        const targets = unresolved.filter(r => r.step.why?.explanation_status !== 'complete' && r.seedPool.some(t => t.id === tag.id));
        if (!targets.length)
            continue;
        if (!shared.relatives.has(tag.id)) {
            if (budget.relativesUsed >= budget.relativesCap)
                continue;
            budget.relativesUsed++;
        }
        let rels: KinRelative[];
        try {
            rels = await sharedTagRelatives(shared, tag.id, apiKey);
        }
        catch {
            break;
        }
        const kin: KinshipMap = new Map(rels.map(r => [normTagName(r.name), { seedTag: tag, kinAffinity: r.affinity }]));
        for (const row of targets) {
            const hit = bestKinHit(kin, row.stepPool);
            if (!hit)
                continue;
            const reason = composeKinshipWhy(row.seed.name, hit);
            row.step.why = { ...row.step.why!, text: reason.text + base.get(row.step.entity_id)!.text, pair: reason.pair, kin_affinity: hit.kinAffinity, via: 'kinship', explanation_status: 'complete' };
        }
    }
    return explanationStatusFor(steps);
}

function kindOf(type_: string): string {
  const map: Record<string, string> = {
    artist: "listen",
    movie: "watch",
    tv_show: "watch",
    book: "view",
    place: "view",
    podcast: "listen",
    video_game: "view",
    videogame: "view",
    person: "view",
    brand: "view",
  };
  return map[type_] ?? "view";
}

function itemFor(ent: EntBrief): { title: string; url: string; pinned: boolean; kind: string } {
  if (ent.type === "place" && ent.website) {
    return { title: `${ent.name} · 官网/酒单`, url: ent.website, pinned: true, kind: "view" };
  }
  const q = encodeURIComponent(ent.name);
  return {
    title: `${ent.name}（搜索页）`,
    url: `https://www.youtube.com/results?search_query=${q}`,
    pinned: false,
    kind: kindOf(ent.type),
  };
}

function catalogTasteTags(e:Record<string,unknown>):{id:string;name:string}[]{
 const seen=new Set<string>(),tags:{id:string;name:string}[]=[];
 for(const raw of Array.isArray(e.tags)?e.tags:[]){const t=asObj(raw),id=asStr(t.tag_id)||asStr(t.id),name=asStr(t.name).trim();if(!id||!name||!isTasteTag(id)||seen.has(id.toLowerCase()))continue;seen.add(id.toLowerCase());tags.push({id,name});}
 return tags;
}

function catalogHorrorLabels(e:Record<string,unknown>):string[]{
 const p=asObj(e.properties),labels:string[]=[];
 for(const genre of Array.isArray(p.genres)?p.genres:[])if(typeof genre==='string'&&/horror/i.test(genre))labels.push(genre);
 for(const raw of Array.isArray(e.tags)?e.tags:[]){const t=asObj(raw);if(/horror/i.test(asStr(t.id)+' '+asStr(t.name)))labels.push(asStr(t.name)||asStr(t.id));}
 return [...new Set(labels)].slice(0,3);
}

function entBrief(raw: unknown): EntBrief {
  const e = asObj(raw);
  const props = asObj(e.properties);
  const subtype = asStr(e.subtype).replace("urn:entity:", "");
  const desc = (asStr(props.description) || asStr(props.short_description)).slice(0, 220);
  const type_ = subtype || asStr(e.type);
  return {
    id: asStr(e.entity_id),
    name: asStr(e.name),
    type: type_,
    desc,
    website: asStr(props.website),
    address: addrOf(props),
    year: yearOf(props),
    byline: bylineOf(type_, props, asStr(e.disambiguation)),
    image: imageOf(props),
    catalogHorror: catalogHorrorLabels(e),
    catalogTags: catalogTasteTags(e),
    entrySeries: catalogEntrySeries(e),
  };
}

function briefBio(c: EntBrief): string {
  if (c.type === "place") {
    const parts = [c.name, `地址：${c.address || "见条目链接"}`];
    if (c.desc) parts.push(c.desc);
    return parts.join("\n");
  }
  return c.desc || "";
}

class RouteBrokenError extends Error {
  hop: number;
  /** "shell": the destination anchor itself has no usable neighborhood
   * at hop 1 (the insights call failed, e.g. Qloo rejecting the signal
   * id, or the neighborhood came back empty) — the destination is a
   * catalog shell, not a wording problem. "far": the neighborhood was
   * non-empty but no candidate cleared the floor; `maxHop` carries the
   * best measured hop affinity actually observed at that hop. */
  kind: "shell" | "far" | "entry_series" | "series_order";
  destName: string;
  maxHop: number | null;
  /** Set when a hard user constraint (A-item) filtered out every
   * feasible candidate at this hop: the failure is named after that
   * constraint so the UI can offer「放宽这条重建」. */
  constraint: { id: string; label: string; excerpt: string } | null;
  constructor(
    hop: number,
    kind: "shell" | "far" | "entry_series" | "series_order",
    destName: string,
    maxHop: number | null,
    constraint: { id: string; label: string; excerpt: string } | null = null,
  ) {
    super(`route broken at hop ${hop} (${kind})`);
    this.name = "RouteBrokenError";
    this.hop = hop;
    this.kind = kind;
    this.destName = destName;
    this.maxHop = maxHop;
    this.constraint = constraint;
  }
}

function fmtAff(x: number): string {
  return String(Math.round(x * 1000) / 1000);
}

type RingEntry = { ent: EntBrief; hop: number | null };

/** One hop's neighborhood: entities of `type_` in the anchor's Qloo
 * neighborhood (anchor as the interest signal, take 50 — the same call
 * shape the standalone router v2 uses). Each result's query.affinity is
 * the measured distance from the anchor — the hop distance. (An earlier
 * build also sent filter.include.entities for the anchor; Qloo then
 * returned nothing usable and every first hop broke, so the parameter
 * was dropped — verified live 2026-10-18.) */
async function anchorRing(
  type_: string,
  anchor: EntBrief,
  apiKey: string,
): Promise<RingEntry[]> {
  return anchorRingForSignals(type_, [anchor.id], apiKey);
}

/** Neighborhood for a union of signals (a series pack's members used
 * together as one anchor): same insights call, all member ids as the
 * interest signal. */
async function anchorRingForSignals(
  type_: string,
  signalIds: string[],
  apiKey: string,
): Promise<RingEntry[]> {
  const d = await qlooGet(
    "/v2/insights",
    {
      "filter.type": `urn:entity:${type_}`,
      "signal.interests.entities": signalIds.join(","),
      take: "50",
    },
    apiKey,
    "ring",
  );
  const results = asObj(d.results);
  const entities = Array.isArray(results.entities) ? (results.entities as unknown[]) : [];
  return entities.map((raw) => {
    const e = asObj(raw);
    const q = asObj(e.query).affinity;
    const top = e.affinity;
    const hop =
      typeof q === "number"
        ? Math.round(q * 1000) / 1000
        : typeof top === "number"
          ? Math.round(top * 1000) / 1000
          : null;
    return { ent: entBrief(raw), hop };
  });
}

type AltObj = {
  entrySeries?: EntrySeries;
  image?: string;
  year?: number | null;
  name: string;
  type: string;
  entity_id: string;
  aff_from_seeds: number;
  byline?:string;
  bio: string;
  tracks: ReturnType<typeof itemFor>[];
  edge_note: string;
};

// --- A-item: barrier / motivation → measured constraints -------------------
//
// The user's barrier (what kept them out) and motivation (what pulls
// them in) are parsed by DETERMINISTIC keyword rules only — no model
// ever interprets them (product rule: computation never depends on a
// model). A parsed constraint becomes routing input only where Qloo
// data can actually measure it:
//   hard filters  — tag pool (horror/gore, Anime/Animation) and entity
//                   type (book), applied to hop candidates before the
//                   pick; the destination itself is never a candidate,
//                   so it is exempt by construction.
//   soft prefs    — year bands (<1990 / ≥2015) and a wanted tag
//                   (motivation-side horror): a swap is allowed only
//                   inside a ±0.02 hop-affinity tolerance band, so a
//                   preference never sacrifices a measured edge.
//   unhandled     — length / episode count / pace: Qloo carries no
//                   reliable field for these, so they produce NO
//                   routing effect and the arrival recap says so.
// Every constraint's fate (filtered N candidates / swapped M steps /
// no effect / unhandled) is recorded in a per-route report stored on
// the route meta and quoted in the provenance line.

type ConstraintKind =
  | "avoid_horror"
  | "avoid_gore"
  | "avoid_anime"
  | "avoid_book"
  | "avoid_old"
  | "avoid_tag"
  | "prefer_recent"
  | "prefer_old"
  | "prefer_horror"
  | "prefer_tag"
  | "unhandled_length"
  | "unhandled_pace";

/** A topic-class avoid (避开恐怖题材） can collide with the pinned
 * destination itself when the destination carries horror tags. The
 * collision is surfaced, never silently resolved: `pending` = seen at
 * parse time, not yet confirmed by the user (the constraint then does
 * NOT take effect); `active` = the user confirmed「仍要避开」and the
 * constraint applies normally (destination still exempt); `inactive`
 * is reserved for a stored record of a suppressed conflict. */
type ConstraintConflict = {
  status: "pending" | "inactive" | "active";
  /** The destination's own horror-topic tag names (≤3, 、-joined). */
  evidence: string;
};

type RouteConstraint = {
  /** Stable id (= kind for parsed constraints); the client echoes
   * these back to buildRoute so a chip the user removed simply never
   * reaches the router. Manual entries use their entryId as id. */
  id: string;
  /** Client-supplied identity for manual entries (≤64 chars). */
  entryId?: string;
  source: "barrier" | "motivation" | "manual";
  kind: ConstraintKind;
  hard: boolean;
  /** Chip / report label, e.g.「避开恐怖题材」. */
  label: string;
  /** Short name used inside swap notes, e.g.「避开老作品」. */
  short: string;
  /** The exact fragment of the user's own text that matched; manual
   * entries carry「手动添加」. */
  excerpt: string;
  /** Tag URN for the tag kinds (avoid_tag / prefer_tag). */
  tagId?: string | null;
  conflict?: ConstraintConflict | null;
  /** Topic-class avoids need a destination tag check before they can
   * be trusted not to fight the destination itself. */
  needsDestinationCheck?: boolean;
};

type ConstraintReportEntry = {
  id: string;
  label: string;
  excerpt: string;
  source: "barrier" | "motivation" | "manual";
  status: "applied" | "no_effect" | "unhandled";
  detail: string;
};

/** One motivation signal: a measurable (or honestly unmeasurable)
 * reason the user gave for wanting in. Only signals the user selected
 * (or added by hand) ever enter routing; the rest are echoes. */
type MotivationSignal = {
  id: string;
  label: string;
  source: "text" | "destination_tags" | "manual" | "pending_supplement";
  tagId: string | null;
  status: "ready" | "pending" | "unhandled";
  excerpt: string;
  /** For the generic-pending placeholder only: what the user can
   * fill in to turn the placeholder into a real signal (field name +
   * examples). The placeholder itself never enters routing and never
   * appears in any report. */
  supplement?: {
    field: string;
    examples: string[];
  } | null;
};

/** The placeholder signal returned when the motivation says「被某种
 * 概念/设定吸引」in ordinary words but names no concrete concept and
 * no destination tags are usable: an explicit pending marker (the
 * frontend never has to re-derive this with its own Chinese regex).
 * tagId is null and the id is never resolvable in buildRoute, so it
 * cannot enter routing or any report. */
function genericPendingPlaceholder(motivation: string): MotivationSignal {
  const excerpt =
    motivation.match(/[^，。；]*?(概念|设定|题材|世界观)[^，。；]*/)?.[0] ??
    motivation.slice(0, 24);
  return {
    id: "mot:pending:generic",
    label: "想看的设定还没说具体",
    source: "pending_supplement",
    tagId: null,
    status: "pending",
    excerpt,
    supplement: {
      field: "motivation",
      examples: [
        "被时间旅行这种设定吸引",
        "对赛博朋克的世界观有感觉",
        "这个设定挺有意思，想试试末日废土",
      ],
    },
  };
}

type MotivationReportEntry = {
  signal_id: string;
  label: string;
  status: "applied_changed" | "applied_no_change" | "unhandled";
  detail: string;
};

/** A motivation tag signal that actually enters routing, with its
 * priority class: 0 = manual (user-typed), 1 = selected parse signal.
 * Auto-parsed prefer_* constraints rank below both. */
type ActiveMotSignal = {
  signalId: string;
  label: string;
  tagId: string;
  priority: 0 | 1;
  source: "text" | "destination_tags" | "manual";
};

// --- Parser v2: horror/gore with a context gate -------------------------
//
// Horror (a TOPIC: 恐怖/吓人/惊悚/鬼片/灵异/丧尸/僵尸） and gore (a CONTENT
// class: 血腥/血浆/断肢/内脏） are parsed as two independent conditions.
// A category word only becomes an avoid when an avoidance context word
// （怕/不敢/受不了/看不了/接受不了/不想/不要/别/拒绝/避开/回避/看不下去）
// shares its clause — clauses split on ，。；、 and on the turn words
// 但/但是/可是/不过/就是/只是. Mentioning a category is not avoiding it:
// 「我超爱恐怖片」「想看恐怖片」produce nothing. Suppression: a category
// word whose NEAREST avoidance token is a negated one （不怕/不害怕） does
// not fire; clause-level 没关系/无所谓 suppress the whole clause; a
// refusal-to-avoid phrase （不想避开…） deactivates both its tokens; and
// in the「不是怕X，是怕Y」pattern only the「是怕」clause counts.

const HORROR_TOPIC_WORDS = ["恐怖", "吓人", "惊悚", "鬼片", "灵异", "丧尸", "僵尸"];
const GORE_CONTENT_WORDS = ["血腥", "血浆", "断肢", "内脏"];
const AVOID_CONTEXT_WORDS = [
  "看不下去",
  "接受不了",
  "受不了",
  "看不了",
  "不敢",
  "不想",
  "不要",
  "拒绝",
  "避开",
  "回避",
  "怕",
  "别",
];

function splitBarrierClauses(text: string): string[] {
  return text
    .replace(/但是|可是|不过|只是|但|就是/g, "，")
    .split(/[，。；、！？]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse the barrier for horror-topic and gore-content avoidance,
 * returning the matched category word per class (or null). */
function parseHorrorGore(barrier: string): {
  horror: string | null;
  gore: string | null;
} {
  const clauses = splitBarrierClauses(barrier);
  // 「不是怕X，是怕Y」: only the 是怕 clause states a real avoidance.
  const focusPattern =
    /不是怕/.test(barrier) && /是怕/.test(barrier);
  let horror: string | null = null;
  let gore: string | null = null;
  for (const clause of clauses) {
    // A clause whose only 是怕 sits inside 不是怕 is the denied half
    // of the pattern and states no avoidance.
    if (
      focusPattern &&
      clause.includes("不是怕") &&
      !clause.replace(/不是怕/g, "").includes("是怕")
    ) {
      continue;
    }
    if (/没关系|无所谓/.test(clause)) continue;
    // Dead spans: avoidance tokens inside them never count —
    // negated fear （不怕/不害怕） and refusals to avoid （不想避开…）.
    const deadSpans: [number, number][] = [];
    for (const m of clause.matchAll(/不害怕|不怕/g)) {
      deadSpans.push([m.index, m.index + m[0].length]);
    }
    for (const m of clause.matchAll(/(?:不想|不要|别)(?:避开|回避)/g)) {
      deadSpans.push([m.index, m.index + m[0].length]);
    }
    const inDead = (i: number): boolean =>
      deadSpans.some(([a, b]) => i >= a && i < b);
    // Every avoidance token occurrence, flagged active or dead.
    const tokens: { at: number; active: boolean }[] = [];
    for (const w of AVOID_CONTEXT_WORDS) {
      let from = 0;
      for (;;) {
        const i = clause.indexOf(w, from);
        if (i < 0) break;
        tokens.push({ at: i, active: !inDead(i) });
        from = i + w.length;
      }
    }
    if (!tokens.some((t) => t.active)) continue;
    // A category word fires only when its NEAREST avoidance token is
    // an active one — in「不怕恐怖就怕血浆」the 恐怖 sits next to the
    // dead 不怕 and stays silent, while 血浆 sits next to the live 怕.
    const fires = (word: string): boolean => {
      let from = 0;
      for (;;) {
        const i = clause.indexOf(word, from);
        if (i < 0) return false;
        let nearest: { at: number; active: boolean } | null = null;
        for (const t of tokens) {
          if (
            !nearest ||
            Math.abs(t.at - i) < Math.abs(nearest.at - i)
          ) {
            nearest = t;
          }
        }
        if (nearest?.active) return true;
        from = i + word.length;
      }
    };
    if (!horror) {
      for (const w of HORROR_TOPIC_WORDS) {
        if (fires(w)) {
          horror = w;
          break;
        }
      }
    }
    if (!gore) {
      for (const w of GORE_CONTENT_WORDS) {
        if (fires(w)) {
          gore = w;
          break;
        }
      }
    }
    if (horror && gore) break;
  }
  return { horror:horror??englishAvoidance(barrier,/\b(?:horror|scary movies?|ghost stories|zombies?)\b/i), gore:gore??englishAvoidance(barrier,/\b(?:gore|gory|blood|bloody|dismemberment)\b/i) };
}

// --- Motivation concept → Qloo tag map ----------------------------------
//
// Each entry's URN was verified against the real Qloo tag surface on
// 2026-10-24 by reading the tag profile of a work that carries it
// (source noted per entry). Concepts whose only candidate URNs turned
// out to be narrower than the concept itself （治愈/温暖、运动/体育 —
// only Boxing verified, 游戏/电竞 — only music-scope video-game tags,
// 犯罪 — only Gangster / Organized Crime / Crime Investigation,
// 记忆 — no memory tag in any probed profile) were dropped from the
// table rather than mapped to a wrong tag.
//
// Mapping-quality pass (batch 3, 2026-10-24): a URN existing is NOT
// semantic equivalence. Every retained entry was re-read against its
// tag's actual meaning; entries whose tag NARROWS or JUMPS the
// concept are marked `pending: true` — they surface as pending
// suggestions the user must confirm before they can enter routing,
// never as ready signals. Downgrade list and reasons:
//   太空/宇宙探索 → outer space:只是太空设定，不含探索叙事，外星也不必在太空
//   侦探/推理 → detective:侦探角色词，不等于推理类型
//   战争 → military:军事词，战争作品不止于军队本身
//   家庭 → Family Bonds:亲情纽带母题，不等于家庭题材
//   成长/青春 → Rite Of Passage:成年礼母题，只是成长的一种叙事
//   冒险 → Action & Adventure:被收窄为动作冒险复合类型
//   悬疑 → Mysteries:谜案向，悬疑的悬念/惊悚面不在内
//   西部 → Spaghetti Western:只是意大利西部片子类
//   音乐/乐队 → Band:只限乐队，音乐概念大得多
//   舞蹈 → dance (genre:music):舞曲音乐类型，不是舞蹈本身
//   旅行 → Voyage:航程/远航，旅行概念大得多
//   神话 → Mythical Creatures:只指神话生物，不等于神话体系
//   历史 → period drama:年代剧，历史题材不止于此
//   传记 → Biopic:传记电影，书籍等其他媒介的传记不在内
//   动物 → talking animal:只限会说话的动物
//   梦境 → Dreamscapes:梦境景观，梦境概念大得多
//   分身/平行世界 → Multiverse:只覆盖平行宇宙，不含分身
//   循环/轮回 → Time Loop:只覆盖时间循环，不含轮回转世
const MOTIVATION_TAG_MAP: {
  concept: string;
  slug: string;
  tagId: string;
  /** Qloo tag name as it appears in profiles. */
  tagName: string;
  keywords: string[];
  /** True when the verified URN narrows or jumps the concept (see
   * the downgrade list above): the signal is offered as a pending
   * suggestion, not a ready one. */
  pending?: boolean;
}[] = [
  // Observed in pinned Obsession catalogue, 2026-10-25; general Wish,
  // not the narrower Corrupted Wish / supernatural bargain concepts.
  { concept:"许愿 / 愿望成真",slug:"wish",tagId:"urn:tag:keyword:qloo:wish",tagName:"Wish",keywords:["许愿柳","愿望成真","许愿","One Wish Willow"] },
  // urn from Doctor Who's profile: urn:tag:subgenre:qloo:time_travel "Time Travel"
  { concept: "时间旅行", slug: "time-travel", tagId: "urn:tag:subgenre:qloo:time_travel", tagName: "Time Travel", keywords: ["时间旅行", "时空旅行", "穿越"] },
  // urn from Jurassic Park's profile: urn:tag:keyword:media:outer_space "outer space"
  { concept: "太空/宇宙探索", slug: "outer-space", tagId: "urn:tag:keyword:media:outer_space", tagName: "outer space", keywords: ["太空", "宇宙", "星际", "外星"], pending: true },
  // urn from Blade Runner 2049's profile: urn:tag:keyword:qloo:artificial_intelligence "Artificial Intelligence"
  { concept: "人工智能", slug: "artificial-intelligence", tagId: "urn:tag:keyword:qloo:artificial_intelligence", tagName: "Artificial Intelligence", keywords: ["人工智能"] },
  // urn from Jurassic Park's profile: urn:tag:keyword:media:robot "robot"
  { concept: "机器人", slug: "robots", tagId: "urn:tag:keyword:media:robot", tagName: "robot", keywords: ["机器人"] },
  // urn from Harry Potter's profile: urn:tag:subgenre:qloo:magic "Magic"
  { concept: "魔法", slug: "magic", tagId: "urn:tag:subgenre:qloo:magic", tagName: "Magic", keywords: ["魔法", "巫师"] },
  // urn from Jurassic Park's profile: urn:tag:subgenre:qloo:dinosaur "Dinosaur" (before 龙: 恐龙 contains 龙）
  { concept: "恐龙", slug: "dinosaurs", tagId: "urn:tag:subgenre:qloo:dinosaur", tagName: "Dinosaur", keywords: ["恐龙"] },
  // urn from How to Train Your Dragon's profile: urn:tag:keyword:qloo:dragons "DRAGONs"
  { concept: "龙", slug: "dragons", tagId: "urn:tag:keyword:qloo:dragons", tagName: "DRAGONs", keywords: ["龙"] },
  // urn from Twilight's profile: urn:tag:genre:qloo:vampire "Vampire"
  { concept: "吸血鬼", slug: "vampires", tagId: "urn:tag:genre:qloo:vampire", tagName: "Vampire", keywords: ["吸血鬼"] },
  // urn from The Walking Dead's profile: urn:tag:keyword:qloo:zombies "Zombies"
  { concept: "僵尸", slug: "zombies", tagId: "urn:tag:keyword:qloo:zombies", tagName: "Zombies", keywords: ["僵尸", "丧尸"] },
  // urn from The Walking Dead's profile: urn:tag:keyword:qloo:post_apocalypse "Post-Apocalypse"
  { concept: "末日/废土", slug: "post-apocalypse", tagId: "urn:tag:keyword:qloo:post_apocalypse", tagName: "Post-Apocalypse", keywords: ["末日", "废土"] },
  // urn from Blade Runner 2049's profile: urn:tag:subgenre:qloo:cyberpunk "Cyberpunk"
  { concept: "赛博朋克", slug: "cyberpunk", tagId: "urn:tag:subgenre:qloo:cyberpunk", tagName: "Cyberpunk", keywords: ["赛博朋克", "赛博"] },
  // urn from Mortal Engines' profile: urn:tag:subgenre:qloo:steampunk "Steampunk"
  { concept: "蒸汽朋克", slug: "steampunk", tagId: "urn:tag:subgenre:qloo:steampunk", tagName: "Steampunk", keywords: ["蒸汽朋克"] },
  // urn from Ready Player One's profile: urn:tag:subgenre:qloo:superhero "Superhero"
  { concept: "超级英雄", slug: "superheroes", tagId: "urn:tag:subgenre:qloo:superhero", tagName: "Superhero", keywords: ["超级英雄"] },
  // urn from Sherlock's profile: urn:tag:keyword:media:detective "detective"
  { concept: "侦探/推理", slug: "detective", tagId: "urn:tag:keyword:media:detective", tagName: "detective", keywords: ["侦探", "推理", "破案"], pending: true },
  // urn from Skyfall's profile: urn:tag:subgenre:qloo:spy "Spy"
  { concept: "间谍", slug: "spies", tagId: "urn:tag:subgenre:qloo:spy", tagName: "Spy", keywords: ["间谍", "特工", "谍战"] },
  // urn from Saving Private Ryan's profile: urn:tag:keyword:media:military "military"
  { concept: "战争", slug: "war", tagId: "urn:tag:keyword:media:military", tagName: "military", keywords: ["战争", "二战", "军事"], pending: true },
  // urn from Titanic's profile: urn:tag:keyword:media:love "love"
  { concept: "爱情/浪漫", slug: "love", tagId: "urn:tag:keyword:media:love", tagName: "love", keywords: ["爱情", "浪漫", "恋爱"] },
  // urn from Twilight's profile: urn:tag:motif:qloo:family_bonds "Family Bonds"
  { concept: "家庭", slug: "family", tagId: "urn:tag:motif:qloo:family_bonds", tagName: "Family Bonds", keywords: ["家庭", "亲情"], pending: true },
  // urn from Stand by Me's profile: urn:tag:archetype:qloo:rite_of_passage "Rite Of Passage"
  { concept: "成长/青春", slug: "coming-of-age", tagId: "urn:tag:archetype:qloo:rite_of_passage", tagName: "Rite Of Passage", keywords: ["成长", "青春"], pending: true },
  // urn from John Wick's profile: urn:tag:keyword:media:revenge "revenge"
  { concept: "复仇", slug: "revenge", tagId: "urn:tag:keyword:media:revenge", tagName: "revenge", keywords: ["复仇", "报仇"] },
  // urn verified in profiles: urn:tag:subgenre:qloo:action_adventure "Action & Adventure"
  { concept: "冒险", slug: "adventure", tagId: "urn:tag:subgenre:qloo:action_adventure", tagName: "Action & Adventure", keywords: ["冒险", "探险"], pending: true },
  // urn from The Secret Life of Walter Mitty's profile: urn:tag:genre:media:humor "Humor"
  { concept: "喜剧/搞笑", slug: "comedy", tagId: "urn:tag:genre:media:humor", tagName: "Humor", keywords: ["喜剧", "搞笑", "幽默"] },
  // urn from Stand by Me's profile: urn:tag:theme:qloo:mysteries "Mysteries"
  { concept: "悬疑", slug: "mystery", tagId: "urn:tag:theme:qloo:mysteries", tagName: "Mysteries", keywords: ["悬疑", "悬念"], pending: true },
  // urn from Jurassic Park's profile: urn:tag:keyword:qloo:pirate "Pirate"
  { concept: "海盗", slug: "pirates", tagId: "urn:tag:keyword:qloo:pirate", tagName: "Pirate", keywords: ["海盗"] },
  // urn from Django Unchained's profile: urn:tag:subgenre:qloo:spaghetti_western "Spaghetti Western"
  { concept: "西部", slug: "western", tagId: "urn:tag:subgenre:qloo:spaghetti_western", tagName: "Spaghetti Western", keywords: ["西部", "牛仔"], pending: true },
  // urn from Bohemian Rhapsody's profile: urn:tag:keyword:qloo:band "Band"
  { concept: "音乐/乐队", slug: "music", tagId: "urn:tag:keyword:qloo:band", tagName: "Band", keywords: ["音乐", "乐队"], pending: true },
  // urn from Twilight's profile: urn:tag:genre:music:dance "dance"
  { concept: "舞蹈", slug: "dance", tagId: "urn:tag:genre:music:dance", tagName: "dance", keywords: ["舞蹈", "跳舞"], pending: true },
  // urn from Ratatouille's profile: urn:tag:subgenre:qloo:culinary "Culinary"
  { concept: "美食/烹饪", slug: "culinary", tagId: "urn:tag:subgenre:qloo:culinary", tagName: "Culinary", keywords: ["美食", "烹饪", "厨师"] },
  // urn from Twilight's profile: urn:tag:keyword:qloo:voyage "Voyage"
  { concept: "旅行", slug: "travel", tagId: "urn:tag:keyword:qloo:voyage", tagName: "Voyage", keywords: ["旅行", "旅游"], pending: true },
  // urn verified in profiles: urn:tag:motif:qloo:mythical_creatures "Mythical Creatures"
  { concept: "神话", slug: "mythology", tagId: "urn:tag:motif:qloo:mythical_creatures", tagName: "Mythical Creatures", keywords: ["神话"], pending: true },
  // urn from Amélie's profile: urn:tag:keyword:media:period_drama "period drama"
  { concept: "历史", slug: "history", tagId: "urn:tag:keyword:media:period_drama", tagName: "period drama", keywords: ["历史", "古装"], pending: true },
  // urn from Hamilton's profile: urn:tag:keyword:qloo:biopic "Biopic"
  { concept: "传记", slug: "biography", tagId: "urn:tag:keyword:qloo:biopic", tagName: "Biopic", keywords: ["传记", "真人真事"], pending: true },
  // urn from Finding Nemo's profile: urn:tag:keyword:media:talking_animal "talking animal"
  { concept: "动物", slug: "animals", tagId: "urn:tag:keyword:media:talking_animal", tagName: "talking animal", keywords: ["动物"], pending: true },
  // urn from Finding Nemo's profile: urn:tag:keyword:qloo:ocean "Ocean"
  { concept: "海洋", slug: "ocean", tagId: "urn:tag:keyword:qloo:ocean", tagName: "Ocean", keywords: ["海洋", "大海", "海底"] },
  // urn from The Walking Dead's profile: urn:tag:keyword:media:ghost "ghost"
  { concept: "幽灵/灵异", slug: "ghosts", tagId: "urn:tag:keyword:media:ghost", tagName: "ghost", keywords: ["幽灵", "灵异"] },
  // urn from Inception's profile: urn:tag:theme:qloo:dreamscapes "Dreamscapes"
  { concept: "梦境", slug: "dreams", tagId: "urn:tag:theme:qloo:dreamscapes", tagName: "Dreamscapes", keywords: ["梦境", "梦"], pending: true },
  // urn from Spider-Man: Into the Spider-Verse's profile: urn:tag:keyword:qloo:multiverse "Multiverse"
  { concept: "分身/平行世界", slug: "multiverse", tagId: "urn:tag:keyword:qloo:multiverse", tagName: "Multiverse", keywords: ["平行世界", "平行宇宙", "多重宇宙", "分身"], pending: true },
  // urn from Groundhog Day's profile: urn:tag:subgenre:qloo:time_loop "Time Loop"
  { concept: "循环/轮回", slug: "time-loop", tagId: "urn:tag:subgenre:qloo:time_loop", tagName: "Time Loop", keywords: ["时间循环", "循环", "轮回"], pending: true },
];

/** Deterministic motivation → signals parse. Concept hits come from
 * MOTIVATION_TAG_MAP (matched spans are consumed so 恐龙 never also
 * fires 龙）; the year/topic preference branches reappear as signals —
 * the same fact in a second view, still consumed once by the
 * constraint pipeline. `genericPending` flags the「被某种概念/设定吸引」
 * shape with no concrete concept: only the caller (which may know the
 * destination) can turn that into pending candidate signals. */
function parseMotivationSignals(
  motivation: string,
  parsed: RouteConstraint[],
): { signals: MotivationSignal[]; genericPending: boolean } {
  const signals: MotivationSignal[] = [];
  const mo = motivation.trim();
  if (!mo) return { signals, genericPending: false };
  let work = mo;
  for (const entry of MOTIVATION_TAG_MAP) {
    for (const kw of [...entry.keywords,...(englishConceptAliases[entry.slug]??[])]) {
      const i = /[a-z]/i.test(kw)?englishKeywordIndex(work,kw):work.indexOf(kw);
      if (i < 0) continue;
      if(/[a-z]/i.test(kw)&&englishNegatedInterest(work,i,kw.length))continue;
      if(entry.slug==='wish'){
       const before=work.slice(0,i).split(/[，。；,]|但是|不过|而是/).at(-1)??'';
       const after=work.slice(i+kw.length).split(/[，。；,]|但是|不过|而是/)[0]??'';
       if(/(?:不是|并非|不喜欢|不想看|不想试)[^，。；,]*$/.test(before)||/^(?:的?设定|这个设定|题材|概念|这点|这个)?(?:没意思|不感兴趣|没兴趣|不好奇)/.test(after.trim()))continue;
      }
      signals.push({
        id: `mot:tag:${entry.slug}`,
        label: entry.concept,
        source: "text",
        tagId: entry.tagId,
        // Mappings whose verified tag narrows or jumps the concept
        // are suggestions the user confirms, not ready signals.
        status: entry.pending ? "pending" : "ready",
        excerpt: kw,
      });
      work = work.slice(0, i) + "　".repeat(kw.length) + work.slice(i + kw.length);
      break;
    }
  }
  for (const c of parsed) {
    if (
      c.kind === "prefer_recent" ||
      c.kind === "prefer_old" ||
      c.kind === "prefer_horror"
    ) {
      signals.push({
        // Contract id shape: mot:pref_recent / mot:pref_old /
        // mot:pref_horror.
        id: `mot:pref_${c.kind.slice("prefer_".length)}`,
        label: c.label,
        source: "text",
        tagId: null,
        status: "ready",
        excerpt: c.excerpt,
      });
    }
  }
  const hasConcept = signals.some((s) => s.tagId != null);
  // Interest phrasing in ordinary words counts （有意思/有味道/带感/
  // 有感觉 alongside 吸引/感兴趣/好奇/想试） — but a clause that
  // negates the interest（「设定没意思」「对这个概念不感兴趣」) is
  // stripped first, so a negation never reads as interest.
  const interestText = mo.replace(
    /[^，。；]*(没意思|没有意思|不感兴趣|没兴趣|不好奇|不想试)[^，。；]*/g,
    "",
  );
  const genericPending =
    !hasConcept &&
    /(概念|设定|题材|世界观)|\b(?:concept|premise|setting|worldbuilding)\b/i.test(mo) &&
    /(吸引|感兴趣|好奇|想试|挺有意思|有意思|有味道|带感|有感觉)|\b(?:interested|curious|intriguing|intrigues|interesting|drawn|attracts)\b/i.test(
      interestText,
    );
  if (signals.length === 0 && !genericPending) {
    // Pure feeling with nothing measurable in it — said out loud as
    // an unhandled signal instead of being silently dropped. (Pace /
    // length complaints are already accounted on the constraint side
    // and never reach this function as motivation text.)
    signals.push({
      id: "mot:unhandled",
      label: "这份心动暂时测不了",
      source: "text",
      tagId: null,
      status: "unhandled",
      excerpt: mo.slice(0, 24),
    });
  }
  return { signals, genericPending };
}

/** Signal id for each motivation-side prefer_* constraint kind: the
 * selection state of these ids (selectedMotivationIds) is what
 * decides whether the matching parsed constraint takes effect. */
const MOT_PREF_SIGNAL_ID: Record<string, string> = {
  prefer_recent: "mot:pref_recent",
  prefer_old: "mot:pref_old",
  prefer_horror: "mot:pref_horror",
};

function isMotivationPref(c: RouteConstraint): boolean {
  return c.source === "motivation" && c.kind in MOT_PREF_SIGNAL_ID;
}

/** Apply an EXPLICIT selectedMotivationIds selection (including an
 * empty array) to parsed constraints: a source=motivation prefer_*
 * whose signal id is not selected is removed — it must not enter
 * routing, must not be stored, must not affect ordering. When the
 * argument is undefined the caller's old behaviour is kept verbatim.
 * Barrier-side and manual constraints are never touched here. */
function filterMotivationPrefsBySelection(
  constraints: RouteConstraint[],
  selectedMotivationIds: string[] | undefined,
): RouteConstraint[] {
  if (selectedMotivationIds === undefined) return constraints;
  return constraints.filter(
    (c) =>
      !isMotivationPref(c) ||
      selectedMotivationIds.includes(MOT_PREF_SIGNAL_ID[c.kind] ?? ""),
  );
}

function parseConstraints(barrier: string, motivation: string): RouteConstraint[] {
  const out: RouteConstraint[] = [];
  const seen = new Set<string>();
  const add = (c: RouteConstraint) => {
    if (seen.has(c.kind)) return;
    seen.add(c.kind);
    out.push(c);
  };
  const hit = (text: string, re: RegExp): string | null => {
    const m = text.match(re);
    return m ? m[0] : null;
  };
  const b = barrier.trim();
  const mo = motivation.trim();
  if (b) {
    for(const [kind,words] of [['avoid_anime',/\b(?:anime|animation|animated works?)\b/i],['avoid_book',/\b(?:books?|reading)\b/i]] as const){
     const excerpt=englishAvoidance(b,words);if(excerpt)add({id:kind,kind,hard:true,source:'barrier',label:kind==='avoid_anime'?'中间步避开动画':'中间步避开书',short:kind==='avoid_anime'?'避开动画':'避开书',excerpt});
    }
    let ex: string | null;
    // Parser v2: topic and content are separate conditions, each
    // gated on a real avoidance context in the same clause.
    const hg = parseHorrorGore(b);
    if (hg.horror) {
      add({
        id: "avoid_horror",
        source: "barrier",
        kind: "avoid_horror",
        hard: true,
        label: "避开恐怖题材",
        short: "避开恐怖",
        excerpt: hg.horror,
        needsDestinationCheck: true,
      });
    }
    if (hg.gore) {
      add({
        id: "avoid_gore",
        source: "barrier",
        kind: "avoid_gore",
        hard: true,
        label: "避开血腥内容",
        short: "避开血腥",
        excerpt: hg.gore,
      });
    }
    if (
      /动画|动漫/.test(b) &&
      /不想|不看|不要|别给|别来|拒绝|讨厌|受不了|看不下去|不喜欢|不爱看/.test(b)
    ) {
      ex =
        hit(b, /不想看动画|不看动画|不想看动漫|不看动漫|不要动画|不要动漫/) ??
        hit(b, /动画|动漫/);
      add({
        id: "avoid_anime",
        source: "barrier",
        kind: "avoid_anime",
        hard: true,
        label: "中间步避开动画",
        short: "避开动画",
        excerpt: ex ?? "动画",
      });
    }
    if (
      (ex = hit(
        b,
        /不看书|不想看书|不想读书|不想读|不读文字|不想读文字|不看文字|懒得读|不爱看书/,
      ))
    ) {
      add({
        id: "avoid_book",
        source: "barrier",
        kind: "avoid_book",
        hard: true,
        label: "中间步避开书",
        short: "避开书",
        excerpt: ex,
      });
    }
    if ((ex = hit(b, /老片子|老电影|老作品|太老了|太老|年代太久|上世纪|老片|\btoo old\b|\boutdated\b/i))) {
      add({
        id: "avoid_old",
        source: "barrier",
        kind: "avoid_old",
        hard: false,
        label: "避开老作品（1990 年前）",
        short: "避开老作品",
        excerpt: ex,
      });
    }
    if (
      (ex = hit(b, /想看新的|想看新一点|新一点|近几年|最近几年|新出的|新作品|较新|\b(?:prefer|want) (?:recent|newer|modern)\b/i))
    ) {
      add({
        id: "prefer_recent",
        source: "barrier",
        kind: "prefer_recent",
        hard: false,
        label: "偏好近几年（2015 年后）",
        short: "偏好近几年",
        excerpt: ex,
      });
    }
    if ((ex = hit(b, /太长了|太长|篇幅|集数太多|集数多|没时间|没耐心|时长|\btoo long\b|\bno time\b|\btoo many episodes\b/i))) {
      add({
        id: "unhandled_length",
        source: "barrier",
        kind: "unhandled_length",
        hard: false,
        label: "篇幅/时间（测不了）",
        short: "篇幅太长",
        excerpt: ex,
      });
    }
    if ((ex = hit(b, /节奏太慢|节奏慢|太慢|太闷|拖沓|\btoo slow\b|\bslow paced\b|\bslow-paced\b/i))) {
      add({
        id: "unhandled_pace",
        source: "barrier",
        kind: "unhandled_pace",
        hard: false,
        label: "节奏快慢（测不了）",
        short: "节奏太慢",
        excerpt: ex,
      });
    }
  }
  if (mo) {
    let ex: string | null;
    if (
      (ex = hit(
        mo,
        /想看恐怖|想看点吓人|想看吓人|喜欢恐怖|爱看恐怖|想看惊悚|想找刺激|想看血腥|重口味/,
      ))
    ) {
      add({
        id: "prefer_horror",
        source: "motivation",
        kind: "prefer_horror",
        hard: false,
        label: "偏好吓人的（恐怖题材）",
        short: "想看点吓人的",
        excerpt: ex,
      });
    }
    if ((ex = hit(mo, /喜欢老片|想看老片|怀旧|经典老片|老片子|想看老电影|\b(?:love|like|prefer|want) (?:old|classic) (?:films|movies|works)\b|\bnostalgia\b/i))) {
      add({
        id: "prefer_old",
        source: "motivation",
        kind: "prefer_old",
        hard: false,
        label: "偏好老作品（1990 年前）",
        short: "偏好老作品",
        excerpt: ex,
      });
    }
    if ((ex = hit(mo, /近几年|新一点|想看新|新出的|最新|\b(?:prefer|want) (?:recent|newer|modern)\b/i))) {
      add({
        id: "prefer_recent",
        source: "motivation",
        kind: "prefer_recent",
        hard: false,
        label: "偏好近几年（2015 年后）",
        short: "偏好近几年",
        excerpt: ex,
      });
    }
  }
  return out;
}

const CONSTRAINT_KINDS: readonly string[] = [
  "avoid_horror",
  "avoid_gore",
  "avoid_anime",
  "avoid_book",
  "avoid_old",
  "avoid_tag",
  "prefer_recent",
  "prefer_old",
  "prefer_horror",
  "prefer_tag",
  "unhandled_length",
  "unhandled_pace",
];

/** Stored constraints recovered from a route's meta (reroute path):
 * the active set the route was actually built with, so a rebuilt tail
 * obeys the same constraints — including chips the user removed and
 * manual entries they added. A constraint that was deleted before the
 * route was built is not in the stored set and can never revive. */
function storedConstraints(meta: Record<string, unknown>): RouteConstraint[] | null {
  const raw = meta.constraints;
  if (!Array.isArray(raw)) return null;
  const out: RouteConstraint[] = [];
  for (const r of raw) {
    const o = asObj(r);
    const kind = asStr(o.kind) as ConstraintKind;
    const id = asStr(o.id);
    if (!id || !CONSTRAINT_KINDS.includes(kind)) continue;
    const conflictRaw = asObj(o.conflict);
    const conflictStatus = asStr(conflictRaw.status);
    out.push({
      id,
      entryId: asStr(o.entryId) || undefined,
      source:
        o.source === "motivation"
          ? "motivation"
          : o.source === "manual"
            ? "manual"
            : "barrier",
      kind,
      hard: o.hard === true,
      label: asStr(o.label) || id,
      short: asStr(o.short) || asStr(o.label) || id,
      excerpt: asStr(o.excerpt),
      tagId: typeof o.tagId === "string" ? o.tagId : null,
      conflict:
        conflictStatus === "pending" ||
        conflictStatus === "inactive" ||
        conflictStatus === "active"
          ? { status: conflictStatus, evidence: asStr(conflictRaw.evidence) }
          : null,
      needsDestinationCheck: o.needsDestinationCheck === true,
    });
  }
  return out;
}

/** Stored motivation tag signals recovered from a route's meta, so a
 * rerouted tail keeps obeying the signals the original build used. */
function storedMotivationSignals(
  meta: Record<string, unknown>,
): ActiveMotSignal[] {
  const raw = meta.motivation_signals;
  if (!Array.isArray(raw)) return [];
  const out: ActiveMotSignal[] = [];
  for (const r of raw) {
    const o = asObj(r);
    const tagId = asStr(o.tagId);
    const signalId = asStr(o.signalId) || asStr(o.id);
    if (!tagId || !signalId) continue;
    out.push({
      signalId,
      label: asStr(o.label) || tagId,
      tagId,
      priority: o.priority === 0 ? 0 : 1,
      source:
        o.source === "manual"
          ? "manual"
          : o.source === "destination_tags"
            ? "destination_tags"
            : "text",
    });
  }
  return out;
}

/** Does this candidate's measured tag profile carry a horror/gore tag?
 * Matched on the tag name and the tag URN, both normalized — the same
 * surface the why pipeline quotes. */
function profileHasHorror(profile: Map<string, TagInfo>): boolean {
  for (const t of profile.values()) {
    const n = normTagName(t.name);
    const id = t.id.toLowerCase();
    if (
      n.includes("horror") ||
      n.includes("gore") ||
      id.includes("horror") ||
      id.includes("gore")
    ) {
      return true;
    }
  }
  return false;
}

/** Gore CONTENT tags on Qloo's tag surface (tag names / URN values,
 * normalized: lowercase, underscores read as spaces). This is the
 * content class — blood and graphic violence — kept strictly separate
 * from the horror TOPIC above: a work can be gory without being a
 * horror title and vice versa. */
const GORE_TAG_WORDS = [
  "gore",
  "gory",
  "graphic violence",
  "splatter",
  "extreme violence",
  "torture",
];

function profileHasGore(profile: Map<string, TagInfo>): boolean {
  for (const t of profile.values()) {
    const n = normTagName(t.name).replace(/_/g, " ");
    const id = t.id.toLowerCase().replace(/_/g, " ");
    if (GORE_TAG_WORDS.some((w) => n.includes(w) || id.includes(w))) {
      return true;
    }
  }
  return false;
}

/** Does this profile carry exactly this tag (URN comparison,
 * case-insensitive)? Used by the manual avoid_tag / prefer_tag kinds
 * and by motivation tag signals. */
function profileHasTagId(
  profile: Map<string, TagInfo>,
  tagId: string,
): boolean {
  const want = tagId.toLowerCase();
  for (const t of profile.values()) {
    if (t.id.toLowerCase() === want) return true;
  }
  return false;
}

/** The calibre sentence fixed onto every avoid_gore report entry:
 * tag-based filtering is only as complete as Qloo's tag coverage. */
const GORE_CALIBER_NOTE =
  "按已知标签过滤；标签覆盖不全，不能保证无血腥内容。";

/** Horror-TOPIC tag names in a profile (the destination-conflict
 * evidence surface): tag name or URN mentioning horror. */
function horrorTopicTagNames(profile: Map<string, TagInfo>): string[] {
  const names: string[] = [];
  for (const t of profile.values()) {
    const n = normTagName(t.name);
    const id = t.id.toLowerCase();
    if (n.includes("horror") || id.includes("horror")) {
      if (!names.includes(t.name)) names.push(t.name);
    }
  }
  return names;
}

/** Deep tag profile for ONE entity (destination checks only): the
 * standard tagProfile reads page 1 (top 50); a destination's horror
 * tag can sit deeper — Alien's "supernatural horror" is on page 3 —
 * so the conflict check reads up to 3 pages, stopping as soon as a
 * horror-topic tag shows up. Typed Qloo errors propagate. */
async function destinationHorrorEvidence(
  entityId: string,
  apiKey: string,
  catalogEntity?: EntBrief,
): Promise<string | null> {
  if(catalogEntity?.id===entityId&&catalogEntity.catalogHorror?.length)return catalogEntity.catalogHorror.join("、")+"（Qloo条目分类）";
  for (let page = 1; page <= 3; page++) {
    const d = await qlooGet(
      "/v2/insights",
      {
        "filter.type": "urn:tag",
        "signal.interests.entities": entityId,
        take: "50",
        page: String(page),
      },
      apiKey,
      "destination_evidence",
    );
    const results = asObj(d.results);
    const rawTags = Array.isArray(results.tags) ? (results.tags as unknown[]) : [];
    const profile = new Map<string, TagInfo>();
    for (const t of rawTags) {
      const to = asObj(t);
      const id = asStr(to.tag_id);
      const name = asStr(to.name).trim();
      if (!id || !name || !isTasteTag(id) || profile.has(id)) continue;
      const aff = asObj(to.query).affinity;
      profile.set(id, { id, name, affinity: typeof aff === "number" ? aff : 0 });
    }
    const names = horrorTopicTagNames(profile);
    if (names.length > 0) return names.slice(0, 3).join("、");
    if (rawTags.length < 50) break;
  }
  return null;
}

/** Verify a tag URN against Qloo's tag endpoint: the tag used as a
 * signal must return tag results. An empty/unreadable answer means
 * the tag cannot be verified; typed Qloo failures (rate limit /
 * upstream) propagate so the caller can fail the whole build with
 * upstream_unavailable instead of guessing. */
async function verifyTagExists(tagId: string, apiKey: string): Promise<boolean> {
  let d: Record<string, unknown>;
  try {
    d = await qlooGet(
      "/v2/insights",
      {
        "filter.type": "urn:tag",
        "signal.interests.tags": tagId,
        take: "30",
      },
      apiKey,
      "tags",
    );
  } catch (e) {
    if (isQlooTypedError(e)) throw e;
    return false;
  }
  const results = asObj(d.results);
  const rawTags = Array.isArray(results.tags) ? (results.tags as unknown[]) : [];
  return rawTags.length > 0;
}

/** Vet merged constraints' manual tags: a tag Qloo cannot verify
 * never takes effect (reported as unhandled, build continues); a
 * rate-limit / upstream failure propagates as a typed error so the
 * whole build fails with upstream_unavailable. Afterwards, a tagId
 * claimed by both avoid_tag and prefer_tag knocks BOTH out — each is
 * reported as conflicted and neither enters routing. */
async function vetManualTagConstraints(
  merged: RouteConstraint[],
  apiKey: string,
): Promise<{ kept: RouteConstraint[]; extras: ConstraintReportEntry[] }> {
  const extras: ConstraintReportEntry[] = [];
  const vetted: RouteConstraint[] = [];
  for (const c of merged) {
    if ((c.kind === "avoid_tag" || c.kind === "prefer_tag") && c.tagId) {
      const okTag = await verifyTagExists(c.tagId, apiKey);
      if (!okTag) {
        extras.push({
          id: c.id,
          label: c.label,
          excerpt: c.excerpt,
          source: c.source,
          status: "unhandled",
          detail: "标签无法验证，未生效",
        });
        continue;
      }
    }
    vetted.push(c);
  }
  const avoidTags = new Set(
    vetted
      .filter((c) => c.kind === "avoid_tag" && c.tagId)
      .map((c) => (c.tagId as string).toLowerCase()),
  );
  const clash = new Set(
    vetted
      .filter(
        (c) =>
          c.kind === "prefer_tag" &&
          c.tagId &&
          avoidTags.has(c.tagId.toLowerCase()),
      )
      .map((c) => (c.tagId as string).toLowerCase()),
  );
  if (clash.size === 0) return { kept: vetted, extras };
  const kept: RouteConstraint[] = [];
  for (const c of vetted) {
    if (
      (c.kind === "avoid_tag" || c.kind === "prefer_tag") &&
      c.tagId &&
      clash.has(c.tagId.toLowerCase())
    ) {
      extras.push({
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "unhandled",
        detail:
          "同一个标签同时被设为偏好与回避，两条互相冲突，本轮两者均未生效。",
      });
      continue;
    }
    kept.push(c);
  }
  return { kept, extras };
}

/** Manual-constraint merge: identity is (kind, tagId ?? ""). A manual
 * entry with the same identity as a parsed one replaces it (excerpt
 * becomes「手动添加」); two avoid_tag entries with different tagIds
 * coexist. Pure — the async tag vetting happens in the caller. */
type ManualConstraintInput = {
  entryId: string;
  kind: ConstraintKind;
  tagId?: string;
  label?: string;
};

const MANUAL_KIND_DEFAULTS: Record<
  string,
  { hard: boolean; label: string; short: string }
> = {
  avoid_horror: { hard: true, label: "避开恐怖题材", short: "避开恐怖" },
  avoid_gore: { hard: true, label: "避开血腥内容", short: "避开血腥" },
  avoid_anime: { hard: true, label: "中间步避开动画", short: "避开动画" },
  avoid_book: { hard: true, label: "中间步避开书", short: "避开书" },
  avoid_old: { hard: false, label: "避开老作品（1990 年前）", short: "避开老作品" },
  prefer_recent: { hard: false, label: "偏好近几年（2015 年后）", short: "偏好近几年" },
  prefer_old: { hard: false, label: "偏好老作品（1990 年前）", short: "偏好老作品" },
  prefer_horror: { hard: false, label: "偏好吓人的（恐怖题材）", short: "想看点吓人的" },
  unhandled_length: { hard: false, label: "篇幅/时间（测不了）", short: "篇幅太长" },
  unhandled_pace: { hard: false, label: "节奏快慢（测不了）", short: "节奏太慢" },
};

function manualToConstraint(m: ManualConstraintInput): RouteConstraint {
  const tagId = m.tagId ?? null;
  const defaults = MANUAL_KIND_DEFAULTS[m.kind] ?? {
    hard: m.kind.startsWith("avoid_"),
    label: m.kind,
    short: m.kind,
  };
  const label =
    m.label ??
    (m.kind === "avoid_tag"
      ? `避开标签 ${tagId ?? ""}`.trim()
      : m.kind === "prefer_tag"
        ? `偏好标签 ${tagId ?? ""}`.trim()
        : defaults.label);
  return {
    id: m.entryId,
    entryId: m.entryId,
    source: "manual",
    kind: m.kind,
    hard:
      m.kind === "avoid_tag" || m.kind === "prefer_tag"
        ? m.kind === "avoid_tag"
        : defaults.hard,
    label,
    short: label,
    excerpt: "手动添加",
    tagId,
    needsDestinationCheck: m.kind === "avoid_horror",
  };
}

function mergeManualConstraints(
  auto: RouteConstraint[],
  manual: ManualConstraintInput[],
): RouteConstraint[] {
  const keyOf = (kind: string, tagId: string | null | undefined): string =>
    `${kind}::${tagId ?? ""}`;
  const out = [...auto];
  const indexByKey = new Map<string, number>();
  out.forEach((c, i) => indexByKey.set(keyOf(c.kind, c.tagId), i));
  for (const m of manual) {
    const c = manualToConstraint(m);
    const key = keyOf(c.kind, c.tagId);
    const at = indexByKey.get(key);
    if (at != null) {
      out[at] = c;
    } else {
      indexByKey.set(key, out.length);
      out.push(c);
    }
  }
  return out;
}

function profileHasAnime(profile: Map<string, TagInfo>): boolean {
  for (const t of profile.values()) {
    const n = normTagName(t.name);
    const id = t.id.toLowerCase();
    if (n === "anime" || n === "animation" || n.includes("anime") || id.includes("anime") || id.includes("animation")) {
      return true;
    }
  }
  return false;
}

/** Soft-preference tolerance band: a swap may only replace the
 * measured pick with a candidate whose hop affinity is within this
 * distance of the pick's. */
const SOFT_SWAP_TOLERANCE = 0.02;

/** Router v2 — build backwards from the destination, one measured hop at
 * a time. Each hop's candidates come from the anchor's real Qloo
 * neighborhood; a hop only counts when its distance clears the floor
 * (0.78, relaxed once to 0.72) and the home affinity does not fall off a
 * cliff versus the previous hop. If no hop qualifies the route honestly
 * fails (RouteBrokenError) instead of padding the chain. The two hops
 * nearest the destination must share the destination's type. */
type BuildOpts = {
  destPack?: { info: PackInfo; memberEnts: EntBrief[] } | null;
  seedPacks?: PackInfo[];
  /** Entity ids that must never appear as a hop candidate (used by
   * score-driven rerouting: the cliff step being avoided, plus the
   * fixed prefix steps so the new tail cannot repeat the prefix). */
  excludeIds?: string[];
  /** Already visited effective works, in walking order. A rebuilt tail
   * cannot introduce an earlier volume after a visited later volume. */
  fixedPrefix?: EntryWork[];
  /** Active A-item constraints (already chip-filtered by the caller).
   * Hard ones filter hop candidates; soft ones may swap the pick
   * inside the tolerance band; unhandled ones only get reported. */
  constraints?: RouteConstraint[];
  /** Motivation tag signals that enter routing (manual first, then
   * user-selected parse signals). They share the soft-preference
   * tolerance mechanism with prefer_* constraints but outrank them. */
  motivationSignals?: ActiveMotSignal[];
  /** Report entries decided by the caller before routing (e.g. a
   * destination-conflicted constraint that never took effect, an
   * unverifiable manual tag): appended to the constraint report
   * verbatim. */
  extraReportEntries?: ConstraintReportEntry[];
  /** Shared measured-data cache for the whole build call (profiles +
   * tag relatives). Supplied by the action handler so destination
   * fall-through attempts and the why stage reuse one cache; a
   * bundle built without one creates its own. */
  sharedCache?: SharedQlooCache;
};

async function buildRouteBundle(
  seeds: EntBrief[],
  dest: EntBrief,
  nSteps: number,
  apiKey: string,
  barrier: string,
  motivation: string,
  opts: BuildOpts = {},
): Promise<Record<string, unknown>> {
  const destPack = opts.destPack ?? null;
  if(!isAllowedType(normEntType(dest.type))||destPack?.memberEnts.some(e=>!isAllowedType(normEntType(e.type)))){
    throw new Error('目的地必须是已核实的娱乐类型；不能使用地点或品牌。');
  }
  const seedPacks = opts.seedPacks ?? [];
  const destPackTypes = destPack
    ? [...new Set(destPack.memberEnts.map((m) => normEntType(m.type)))].filter((t) =>
        isAllowedType(t),
      )
    : [];
  const destLabel = destPack
    ? packDestTitle(destPack.info.label, destPack.info.flavor)
    : dest.name;
  const seedIds = seeds.map((s) => s.id);
  const dtype = normEntType(dest.type);
  const typePlan = [dtype, ...["artist", "movie", "tv_show", "book"].filter((t) => t !== dtype)];
  // Hop candidates only ever come from allowed entertainment types —
  // place/brand steps can never appear in an auto-built route.
  const hopTypes = [...new Set([...destPackTypes, ...typePlan])].filter((t) =>
    isAllowedType(t),
  );

  // --- A-item constraint machinery -------------------------------------
  const constraints = opts.constraints ?? [];
  const hardConstraints = constraints.filter((c) => c.hard);
  const softConstraints = constraints.filter(
    (c) => !c.hard && c.kind !== "unhandled_length" && c.kind !== "unhandled_pace",
  );
  const motSignals = opts.motivationSignals ?? [];
  const needsProfiles =
    hardConstraints.some(
      (c) =>
        c.kind === "avoid_horror" ||
        c.kind === "avoid_gore" ||
        c.kind === "avoid_anime" ||
        c.kind === "avoid_tag",
    ) ||
    softConstraints.some(
      (c) => c.kind === "prefer_horror" || c.kind === "prefer_tag",
    ) ||
    motSignals.length > 0;
  // Tag profiles are fetched lazily, once per entity per BUILD CALL
  // through the shared cache (which the why stage also reads — no
  // private re-read paths), and only when a tag-based constraint or
  // motivation signal is active. A non-typed profile failure reads
  // as an empty profile (the candidate is then never killed on
  // unmeasured evidence); typed failures propagate.
  const sharedCache = opts.sharedCache ?? newSharedQlooCache();
  const profileOf = (id: string): Promise<Map<string, TagInfo>> => {
    return sharedTagProfile(sharedCache, id, apiKey).catch((e: unknown) => {
      if (isQlooTypedError(e)) throw e;
      return new Map<string, TagInfo>();
    });
  };
  const resolvedProfiles = new Map<string, Map<string, TagInfo>>();
  const catalogById=new Map([...seeds,dest,...(opts.destPack?.memberEnts??[])].map(e=>[e.id,e.catalogTags??[]]));
  const ensureProfiles = async (ids: string[]): Promise<void> => {
    for (let i = 0; i < ids.length; i += 8) {
      const batch = ids.slice(i, i + 8);
      const maps = await Promise.all(batch.map((id) => profileOf(id)));
      batch.forEach((id, j) => {
        const m = maps[j];
        if (m) resolvedProfiles.set(id, m);
      });
    }
  };
  /** Hard kills that need NO tag profile (entity type only). These
   * run over the whole measured pool before any profile is fetched. */
  const hardKillerNoProfile = (ent: EntBrief): RouteConstraint | null => {
    for (const c of hardConstraints) {
      if (c.kind === "avoid_book" && normEntType(ent.type) === "book") return c;
      if (c.kind === "avoid_horror" && ent.catalogHorror?.length) return c;
    }
    return null;
  };
  const hardTagConstraints = hardConstraints.some(
    (c) =>
      c.kind === "avoid_horror" ||
      c.kind === "avoid_gore" ||
      c.kind === "avoid_anime" ||
      c.kind === "avoid_tag",
  );
  /** Which hard constraint (if any) kills this candidate. A candidate
   * is only killed on positive measured evidence: a tag profile that
   * actually carries the avoided tag, or (book) the entity type. An
   * empty/unfetched profile never kills. */
  const hardKiller = (ent: EntBrief): RouteConstraint | null => {
    for (const c of hardConstraints) {
      if (c.kind === "avoid_book" && normEntType(ent.type) === "book") return c;
      if (c.kind === "avoid_horror" && ent.catalogHorror?.length) return c;
      if (c.kind === "avoid_horror") {
        const p = resolvedProfiles.get(ent.id);
        if (p && profileHasHorror(p)) return c;
      }
      if (c.kind === "avoid_gore") {
        const p = resolvedProfiles.get(ent.id);
        if (p && profileHasGore(p)) return c;
      }
      if (c.kind === "avoid_anime") {
        const p = resolvedProfiles.get(ent.id);
        if (p && profileHasAnime(p)) return c;
      }
      if (c.kind === "avoid_tag" && c.tagId) {
        const p = resolvedProfiles.get(ent.id);
        if (p && profileHasTagId(p, c.tagId)) return c;
      }
    }
    return null;
  };
  /** Does this candidate satisfy a soft preference, on measured data
   * only (a year Qloo actually states, a tag profile that actually
   * carries the wanted tag)? Unknown never counts as preferred. */
  const isPreferred = (
    c: RouteConstraint,
    cand: { ent: EntBrief },
  ): boolean => {
    switch (c.kind) {
      case "avoid_old":
        return cand.ent.year != null && cand.ent.year >= 1990;
      case "prefer_recent":
        return cand.ent.year != null && cand.ent.year >= 2015;
      case "prefer_old":
        return cand.ent.year != null && cand.ent.year < 1990;
      case "prefer_horror": {
        const p = resolvedProfiles.get(cand.ent.id);
        return p != null && profileHasHorror(p);
      }
      case "prefer_tag": {
        if (!c.tagId) return false;
        const p = resolvedProfiles.get(cand.ent.id);
        return p != null && profileHasTagId(p, c.tagId);
      }
      default:
        return false;
    }
  };
  // Motivation tag signals: a candidate matches when its measured
  // profile carries the signal's tag (basis "direct"), or a tag that
  // is a close relative of it in Qloo's tag graph (basis "kinship",
  // kin affinity ≥ 0.90, the kinship layer's floor; relatives are
  // fetched once per signal per build and cached). The two bases are
  // NEVER worded the same: only a direct hit may be described as
  //「这一站的标签里有 …」; a kinship hit names the candidate's actual
  // tag and the measured affinity. `actualTag` always comes from the
  // candidate's own measured profile — a manual signal's label never
  // stands in for the verified tag name.
  type MotMatch = {
    basis: "direct" | "kinship";
    requestedTag: string;
    actualTag: string;
    affinity: number | null;
  };
  const motKin = new Map<
    string,
    Map<string, { name: string; affinity: number }>
  >();
  const motMatches = (sig: ActiveMotSignal, entId: string): MotMatch | null => {
    const profile=resolvedProfiles.get(entId);
    const measured=[...(profile?.values()??[])];
    const catalog=catalogById.get(entId)??[];
    const want=sig.tagId.toLowerCase();
    for(const tag of measured)if(tag.id.toLowerCase()===want)return {basis:'direct',requestedTag:sig.label,actualTag:tag.name,affinity:tag.affinity};
    // Catalogue membership is an observed tag fact, with no invented
    // affinity. It can support a direct motivation hit even when the
    // aggregate taste-profile endpoint has no tags for the entity.
    for(const tag of catalog)if(tag.id.toLowerCase()===want)return {basis:'direct',requestedTag:sig.label,actualTag:tag.name,affinity:null};
    const kin=motKin.get(sig.signalId);if(!kin?.size)return null;
    for(const tag of [...measured,...catalog]){const rel=kin.get(normTagName(tag.name));if(rel)return {basis:'kinship',requestedTag:sig.label,actualTag:tag.name,affinity:rel.affinity};}
    return null;
  };

  const filterLog = new Map<string, { count: number; names: string[] }>();
  const killedBy = new Map<string, RouteConstraint>();
  const recordFilter = (c: RouteConstraint, ent: EntBrief) => {
    killedBy.set(ent.id, c);
    const cur = filterLog.get(c.id) ?? { count: 0, names: [] };
    cur.count += 1;
    if (cur.names.length < 3 && !cur.names.includes(ent.name)) {
      cur.names.push(ent.name);
    }
    filterLog.set(c.id, cur);
  };
  type SwapRecord = {
    constraintId: string;
    fromName: string;
    toName: string;
    toYear: number | null;
    diff: number;
    note: string;
  };
  const swapRecords: SwapRecord[] = [];
  const swapNotes = new Map<string, string>();
  const satisfiedSoft = new Set<string>();
  /** Soft constraints that at some hop faced a non-preferred pick with
   * no in-band replacement — the report must not claim「每一跳都符合」
   * when this is non-empty. */
  const missedSoft = new Map<string, number>();

  const used = new Set<string>([
    ...seedIds,
    dest.id,
    ...(destPack ? destPack.memberEnts.map((m) => m.id) : []),
    ...(opts.excludeIds ?? []),
  ]);
  const entryTargets = destPack ? destPack.memberEnts : [dest];
  const entryExclusions = new Map<string, {entity_id:string;name:string;reason:string}>();
  let seriesRejectedAtHop = 0;
  let orderRejectedAtHop = 0;
  const orderExclusions = new Map<string,{entity_id:string;name:string;against_name:string;reason:string}>();
  // work is assembled in reverse; each new candidate will precede it.
  const work: EntBrief[] = [dest];
  const allowedEntry = (ent: EntBrief): boolean => {
    for (const target of entryTargets) {
      const reason = entrySeriesReason(ent, target);
      if (reason) {
        seriesRejectedAtHop++;
        entryExclusions.set(ent.id, {entity_id:ent.id,name:ent.name,reason});
        return false;
      }
    }
    for(const next of work){
      const reason=seriesOrderConflict(ent,next);
      if(reason){orderRejectedAtHop++;orderExclusions.set(ent.id,{entity_id:ent.id,name:ent.name,against_name:next.name,reason});return false;}
    }
    for(const previous of opts.fixedPrefix??[]){
      const reason=seriesOrderConflict(previous,ent);
      if(reason){orderRejectedAtHop++;orderExclusions.set(ent.id,{entity_id:ent.id,name:ent.name,against_name:previous.name,reason});return false;}
    }
    return true;
  };
  const hopMeta = new Map<string, { hop: number; home: number; anchorId:string; anchorName:string; signalIds:string[]; pack:boolean }>();
  const altsMap = new Map<string, AltObj[]>();
  const unavailableBranches:{hop:number;signal_entity_ids:string[];result_type:string;reason:'invalid_entity_signals'}[]=[];
  let lastHome: number | null = null;
  const nInter = nSteps - 1;

  // Motivation signal bookkeeping (per route): swaps performed for a
  // signal, the first final pick that already matched it, and the
  // first hop whose feasible pool contained a matching candidate.
  type MotSwapRecord = {
    signalId: string;
    stepN: number;
    fromName: string;
    toName: string;
    diff: number;
    basis: "direct" | "kinship";
    actualTag: string;
    affinity: number | null;
  };
  const motSwapRecords: MotSwapRecord[] = [];
  const motPickHits = new Map<
    string,
    { stepN: number; name: string; match: MotMatch }
  >();
  const motCandHits = new Map<string, { stepN: number; match: MotMatch }>();
  // Kinship relatives per signal, fetched once up front (bounded by
  // the number of active signals; a failed fetch just means direct
  // tag matches only for that signal).
  for (const sig of motSignals) {
    try {
      const rels = await sharedTagRelatives(sharedCache, sig.tagId, apiKey);
      const byName = new Map<string, { name: string; affinity: number }>();
      for (const r of rels) {
        if (r.affinity >= KIN_MIN_AFFINITY) {
          byName.set(normTagName(r.name), { name: r.name, affinity: r.affinity });
        }
      }
      motKin.set(sig.signalId, byName);
    } catch (e) {
      if (isQlooTypedError(e)) throw e;
      motKin.set(sig.signalId, new Map());
    }
  }

  for (let hopIdx = 1; hopIdx <= nInter; hopIdx++) {
    seriesRejectedAtHop = 0;
    orderRejectedAtHop = 0;
    const anchor = work[work.length - 1];
    if (!anchor) break;
    // Destination pack: the first hop's anchor is the members' union
    // signal, and the two hops nearest the destination may use any type
    // that appears inside the pack (instead of only the dest type).
    const isPackAnchor = destPack != null && hopIdx === 1;
    const anchorSignalIds = isPackAnchor
      ? destPack.memberEnts.map((m) => m.id)
      : [anchor.id];
    const anchorName = isPackAnchor ? destLabel : anchor.name;
    const types =
      hopIdx <= 2
        ? destPack
          ? destPackTypes.length > 0
            ? destPackTypes
            : hopTypes
          : isAllowedType(dtype)
            ? [dtype]
            : hopTypes
        : hopTypes;
    type Scored = { ent: EntBrief; hop: number; home: number };
    const scored: Scored[] = [];
    const seen = new Set<string>();
    let ringTotal = 0;
    let eligibleTotal = 0;
    let hopMeasured = 0;
    let homeMeasured = 0;
    let acceptedTypes=0;
    let rejectedType:QlooSignalTypeError|null=null;
    for (const t of types) {
      let ring: RingEntry[] = [];
      try {
        ring = isPackAnchor
          ? await anchorRingForSignals(t, anchorSignalIds, apiKey)
          : await anchorRing(t, anchor, apiKey);
        acceptedTypes++;
      } catch (e) {
        // Only the exact observed entity-signal rejection may close an
        // optional exploratory type branch. It is not retried or treated
        // as a zero affinity, and required measurements still fail closed.
        if(e instanceof QlooSignalTypeError&&types.length>1){
          rejectedType=e;
          unavailableBranches.push({hop:hopIdx,signal_entity_ids:[...anchorSignalIds],result_type:t,reason:'invalid_entity_signals'});
          continue;
        }
        if (isQlooTypedError(e)) throw e;
        continue;
      }
      ringTotal += ring.length;
      const fresh = ring
        .filter(
          (r) =>
            r.ent.id.length > 0 &&
            !used.has(r.ent.id) &&
            !seen.has(r.ent.id) &&
            isAllowedType(r.ent.type) &&
            allowedEntry(r.ent),
        )
        .sort((a, b) => (b.hop ?? -1) - (a.hop ?? -1))
        .slice(0, 12);
      for (const r of fresh){seen.add(r.ent.id);catalogById.set(r.ent.id,r.ent.catalogTags??[]);}
      eligibleTotal += fresh.length;
      if (fresh.length === 0) continue;
      // Fill any missing hop distance with a direct measurement against
      // the anchor, then score home affinity (oracle, batches of ≤5).
      const missingHop = fresh.filter((r) => r.hop == null).map((r) => r.ent.id);
      let hopFill: Record<string, number> = {};
      if (missingHop.length > 0) {
        hopFill = await oracle(t, anchorSignalIds, missingHop, apiKey);
      }
      const home = await oracle(t, seedIds, fresh.map((r) => r.ent.id), apiKey);
      for (const r of fresh) {
        const hop = r.hop ?? hopFill[r.ent.id];
        const homeAff = home[r.ent.id];
        if (hop != null) hopMeasured++;
        if (homeAff != null) homeMeasured++;
        if (hop != null && homeAff != null) {
          scored.push({ ent: r.ent, hop, home: homeAff });
        }
      }
    }
    if(rejectedType&&acceptedTypes===0)throw rejectedType;
    if(rejectedType&&scored.length===0)throw new QlooMeasurementError({ring:ringTotal,eligible:eligibleTotal,hop_measured:hopMeasured,home_measured:homeMeasured,complete:0},`hop_${hopIdx}`);
    // Measurement completeness (signal patch): the neighborhood had
    // entities but NOT ONE candidate came back with both affinities
    // measured — that is "not enough data to judge", never "the
    // route is broken". (ringTotal === 0 keeps the shell/far paths
    // below: an empty neighborhood is a different fact.)
    if (eligibleTotal === 0 && orderRejectedAtHop > 0) {
      throw new RouteBrokenError(hopIdx, "series_order", destLabel, null);
    }
    if (eligibleTotal === 0 && seriesRejectedAtHop > 0) {
      throw new RouteBrokenError(hopIdx, "entry_series", destLabel, null);
    }
    if (scored.length === 0 && ringTotal > 0) {
      throw new QlooMeasurementError(
        {
          ring: ringTotal,
          eligible: eligibleTotal,
          hop_measured: hopMeasured,
          home_measured: homeMeasured,
          complete: 0,
        },
        `hop_${hopIdx}`,
      );
    }
    // A-item hard filters, REORDERED for the call-reduction package.
    // The old order fetched a tag profile for EVERY fully measured
    // candidate before filtering — the single largest call sink in a
    // build (a wide hop could mean 60 profiles). The new order:
    //   1. No-profile hard kills (avoid_book, by entity type) run
    //      over the whole measured pool first — free, exact.
    //   2. Profiles are fetched ONLY for candidates that can still
    //      be picked: the feasible set at the relaxed floor (hop ≥
    //      0.72 and inside the 0.06 home ramp). A candidate outside
    //      that set can never be picked, swapped in, or quoted in a
    //      motivation receipt, so its profile cannot change any
    //      outcome. Documented trade-off (NOT a fully equivalent
    //      optimization): the constraint report's "excluded N"
    //      counts now cover feasible candidates only, instead of
    //      every measured candidate.
    //   3. Soft-only case (no hard tag constraint, no motivation
    //      signal): profiles are fetched only for the pick and the
    //      candidates inside the real ±0.02 tolerance band around
    //      it. That is exact, not a heuristic: a soft swap by
    //      construction only ever replaces the pick with an in-band
    //      candidate, and the satisfied/missed bookkeeping reads
    //      only the pick and in-band candidates — year-based soft
    //      preferences need no profile at all.
    // The destination is never in this pool (it sits in `used`), so
    // it is exempt by construction.
    let pool = scored;
    if (
      hardConstraints.length > 0 ||
      softConstraints.length > 0 ||
      motSignals.length > 0
    ) {
      if (hardConstraints.length > 0) {
        const kept: Scored[] = [];
        for (const c of scored) {
          const killer = hardKillerNoProfile(c.ent);
          if (killer) recordFilter(killer, c.ent);
          else kept.push(c);
        }
        pool = kept;
      }
      if (needsProfiles) {
        const feasLow = pool.filter(
          (c) =>
            c.hop >= 0.72 &&
            (lastHome == null || c.home >= lastHome - 0.06),
        );
        let profileIds: string[];
        if (hardTagConstraints || motSignals.length > 0) {
          profileIds = feasLow.map((c) => c.ent.id);
        } else {
          const sortedLow = [...feasLow].sort(
            (a, b) => b.hop - a.hop || b.home - a.home,
          );
          const top = sortedLow[0];
          profileIds = top
            ? sortedLow
                .filter((c) => top.hop - c.hop <= SOFT_SWAP_TOLERANCE + 1e-9)
                .map((c) => c.ent.id)
            : [];
        }
        await ensureProfiles(profileIds);
      }
      if (hardConstraints.length > 0) {
        const kept: Scored[] = [];
        for (const c of pool) {
          const killer = hardKiller(c.ent);
          if (killer) recordFilter(killer, c.ent);
          else kept.push(c);
        }
        pool = kept;
      }
    }
    const feasibleAt = (list: Scored[], floor: number): Scored[] =>
      list.filter(
        (c) => c.hop >= floor && (lastHome == null || c.home >= lastHome - 0.06),
      );
    let feas = feasibleAt(pool, 0.78);
    if (feas.length === 0) feas = feasibleAt(pool, 0.72);
    // The honest "closest landing" figure: the best hop affinity among
    // candidates that were fully measured (hop AND home affinity).
    // Candidates whose home affinity Qloo never returned are excluded —
    // quoting their raw hop distance would blame distance for what was
    // really an unmeasurable candidate. Null when nothing was fully
    // measured at this hop.
    const maxScoredHop =
      scored.length > 0 ? Math.max(...scored.map((c) => c.hop)) : null;
    if (feas.length === 0) {
      // Constraint-caused break: unfiltered candidates COULD have
      // landed here, but every one of them was killed by a hard
      // constraint. Name that constraint so the failure can offer
      //「放宽这条重建」instead of a generic dead end.
      const unfiltered = feasibleAt(scored, 0.72).sort(
        (a, b) => b.hop - a.hop || b.home - a.home,
      );
      if (pool.length !== scored.length && unfiltered.length > 0) {
        const victim = unfiltered[0];
        const killer = victim ? killedBy.get(victim.ent.id) : undefined;
        if (killer) {
          throw new RouteBrokenError(hopIdx, "far", destLabel, maxScoredHop, {
            id: killer.id,
            label: killer.label,
            excerpt: killer.excerpt,
          });
        }
      }
      // Hop 1 with a failed-or-empty anchor neighborhood means the
      // destination itself is a graph shell; anything else is a real
      // distance failure and reports the best affinity actually seen.
      if (hopIdx === 1 && ringTotal === 0) {
        throw new RouteBrokenError(hopIdx, "shell", destLabel, null);
      }
      throw new RouteBrokenError(hopIdx, "far", destLabel, maxScoredHop);
    }
    feas.sort((a, b) => b.hop - a.hop || b.home - a.home);
    let pick = feas[0];
    if (!pick) {
      throw new RouteBrokenError(hopIdx, "far", destLabel, maxScoredHop);
    }
    // A-item soft preferences + motivation tag signals: inside the
    // ±0.02 hop-affinity tolerance band only, a preferred candidate
    // may take the pick's place. The swap is written into the step's
    // edge note and the report; the measured edge quality is never
    // sacrificed beyond the band. Priority per hop: manual motivation
    // signals > selected motivation signals > auto-parsed prefer_*
    // constraints — the first actor that swaps ends the hop's swaps,
    // and only the facts of the actor that actually fired are booked.
    type SoftActor =
      | { type: "mot"; sig: ActiveMotSignal }
      | { type: "constraint"; c: RouteConstraint };
    const softActors: SoftActor[] = [
      ...motSignals.map((sig): SoftActor => ({ type: "mot", sig })),
      ...softConstraints.map((c): SoftActor => ({ type: "constraint", c })),
    ];
    const actorMatches = (
      a: SoftActor,
      cand: { ent: EntBrief },
    ): boolean =>
      a.type === "mot"
        ? motMatches(a.sig, cand.ent.id) != null
        : isPreferred(a.c, cand);
    if (softActors.length > 0) {
      for (const actor of softActors) {
        const cur = pick;
        if (actorMatches(actor, cur)) {
          if (actor.type === "constraint") satisfiedSoft.add(actor.c.id);
          continue;
        }
        const alt = feas.find(
          (c) =>
            c.ent.id !== cur.ent.id &&
            actorMatches(actor, c) &&
            cur.hop - c.hop <= SOFT_SWAP_TOLERANCE + 1e-9,
        );
        if (alt) {
          const diff = Math.round((cur.hop - alt.hop) * 100) / 100;
          if (actor.type === "mot") {
            const m = motMatches(actor.sig, alt.ent.id);
            const note =
              m?.basis === "kinship"
                ? `与原选《${cur.ent.name}》亲和仅差 ${diff.toFixed(2)}，按你想看的『${actor.sig.label}』换上《${alt.ent.name}》——它的『${m.actualTag}』与你想看的『${actor.sig.label}』是近亲（Qloo 关联亲和 ${(m.affinity ?? 0).toFixed(2)}）`
                : `与原选《${cur.ent.name}》亲和仅差 ${diff.toFixed(2)}，按你想看的『${actor.sig.label}』换上这部带『${m?.actualTag ?? actor.sig.label}』标签的《${alt.ent.name}》`;
            swapNotes.set(alt.ent.id, note);
            motSwapRecords.push({
              signalId: actor.sig.signalId,
              stepN: nSteps - hopIdx,
              fromName: cur.ent.name,
              toName: alt.ent.name,
              diff,
              basis: m?.basis ?? "direct",
              actualTag: m?.actualTag ?? actor.sig.label,
              affinity: m?.affinity ?? null,
            });
          } else {
            const sc = actor.c;
            const yearPart =
              alt.ent.year != null ? `这部 ${alt.ent.year} 年的` : "这部";
            const note =
              sc.kind === "prefer_horror"
                ? `与原选《${cur.ent.name}》亲和仅差 ${diff.toFixed(2)}，按你『${sc.short}』换上这部带恐怖标签的《${alt.ent.name}》`
                : sc.kind === "prefer_tag"
                  ? `与原选《${cur.ent.name}》亲和仅差 ${diff.toFixed(2)}，按你『${sc.short}』换上这部带这个标签的《${alt.ent.name}》`
                  : `与原选《${cur.ent.name}》亲和仅差 ${diff.toFixed(2)}，按你『${sc.short}』换上${yearPart}《${alt.ent.name}》`;
            swapNotes.set(alt.ent.id, note);
            swapRecords.push({
              constraintId: sc.id,
              fromName: cur.ent.name,
              toName: alt.ent.name,
              toYear: alt.ent.year,
              diff,
              note,
            });
          }
          pick = alt;
          break;
        }
        // Non-preferred pick and nothing in the tolerance band could
        // replace it: record the miss so the report stays honest.
        if (actor.type === "constraint") {
          missedSoft.set(actor.c.id, (missedSoft.get(actor.c.id) ?? 0) + 1);
        }
      }
    }
    // Motivation bookkeeping against the FINAL pick of this hop.
    if (motSignals.length > 0) {
      const stepN = nSteps - hopIdx;
      for (const sig of motSignals) {
        if (!motCandHits.has(sig.signalId)) {
          for (const c of feas) {
            const m = motMatches(sig, c.ent.id);
            if (m) {
              motCandHits.set(sig.signalId, { stepN, match: m });
              break;
            }
          }
        }
        if (!motPickHits.has(sig.signalId)) {
          const m = motMatches(sig, pick.ent.id);
          if (m) motPickHits.set(sig.signalId, { stepN, name: pick.ent.name, match: m });
        }
      }
    }
    hopMeta.set(pick.ent.id, { hop: pick.hop, home: pick.home, anchorId:isPackAnchor?"":anchor.id, anchorName, signalIds:[...anchorSignalIds], pack:isPackAnchor });
    altsMap.set(
      pick.ent.id,
      feas
        .filter((a) => a.ent.id !== pick.ent.id)
        .slice(0, 2)
        .map((a) => ({
        name: a.ent.name,
        type: a.ent.type,
        entity_id: a.ent.id,
        entrySeries: a.ent.entrySeries,
        image: a.ent.image,
        year: a.ent.year,
        aff_from_seeds: a.home,
        bio: briefBio(a.ent),
        byline:a.ent.byline,
        tracks: [itemFor(a.ent)],
        edge_note: `备选：以《${anchorName}》为信号反查到本步 ${fmtAff(a.hop)} · 离家 ${fmtAff(a.home)}`,
      })),
    );
    work.push(pick.ent);
    used.add(pick.ent.id);
    lastHome = pick.home;
  }

  // Destination pack: the terminal station is the member with the
  // highest measured affinity to the previous hop (the hop-1 pick,
  // work[1] in reverse assembly). Each member is oracle-measured
  // against that pick, grouped by member type; no reading at all falls
  // back to the pack's first member (search-rank order).
  let finalDest: EntBrief = dest;
  if (destPack) {
    let rep: EntBrief | null = destPack.memberEnts[0] ?? null;
    const prevPick = work[1];
    if (rep && prevPick && destPack.memberEnts.length > 1) {
      const scores = new Map<string, number>();
      const byType = new Map<string, EntBrief[]>();
      for (const m of destPack.memberEnts) {
        const t = normEntType(m.type);
        const list = byType.get(t) ?? [];
        list.push(m);
        byType.set(t, list);
      }
      for (const [t, members] of byType) {
        try {
          const s = await oracle(
            t,
            [prevPick.id],
            members.map((m) => m.id),
            apiKey,
          );
          for (const [id, aff] of Object.entries(s)) scores.set(id, aff);
        } catch (e) {
          if (isQlooTypedError(e)) throw e;
        }
      }
      let bestScore = -1;
      for (const m of destPack.memberEnts) {
        const sc = scores.get(m.id);
        if (sc != null && sc > bestScore) {
          bestScore = sc;
          rep = m;
        }
      }
    }
    if (rep) {
      finalDest = rep;
      work[0] = rep;
    }
  }
  const finalDtype = normEntType(finalDest.type) || "tv_show";

  const chain = [...work].reverse();
  if(chain.slice(0,-1).some(candidate=>entryTargets.some(target=>entrySeriesReason(candidate,target))))throw new RouteBrokenError(nInter,"entry_series",destLabel,null);
  if(routeSeriesConflict([...(opts.fixedPrefix??[]),...chain]))throw new RouteBrokenError(nInter,"series_order",destLabel,null);

  type StepObj = {
    entrySeries?: EntrySeries;
    n: number;
    name: string;
    type: string;
    kind: string;
    entity_id: string;
    description: string;
    image: string;
    year: number | null;
    address: string;
    aff_from_seeds: number | null;
    edge_note: string;
    why: WhyObj | null;
    reverse_link?: ReverseLink;
    byline?:string;
  bio: string;
    tracks: ReturnType<typeof itemFor>[];
    alternates: AltObj[];
  };

  const steps: StepObj[] = chain.map((c, i) => {
    const isDest = c.id === finalDest.id;
    const m = hopMeta.get(c.id);
    let edgeNote: string;
    if (isDest) {
      edgeNote = destPack
        ? `终点站：${destLabel}的代表作。`
        : "终点站：目的地本体。";
    } else if (i === 0) {
      edgeNote = `离家最近的一站：与你的口味亲和 ${m ? fmtAff(m.home) : "—"}`;
    } else {
      const next = chain[i + 1];
      edgeNote =
        m && next ? `与下一站《${next.name}》的亲和 ${fmtAff(m.hop)}（Qloo 实测）` : "";
    }
    // A-item soft swap: the swap fact rides on this step's edge note.
    const swapNote = swapNotes.get(c.id);
    if (swapNote) {
      edgeNote = edgeNote ? `${edgeNote}；${swapNote}。` : `${swapNote}。`;
    }
    return {
      n: i + 1,
      name: c.name,
      type: c.type,
      kind: kindOf(c.type),
      entity_id: c.id,
      entrySeries: c.entrySeries,
      description: c.desc,
      image: c.image,
      year: c.year,
      address: c.address,
      aff_from_seeds: isDest ? null : (m?.home ?? null),
      edge_note: edgeNote,
      why: null,
      bio: briefBio(c),
      byline:c.byline,
      tracks: [itemFor(c)],
      alternates: isDest ? [] : (altsMap.get(c.id) ?? []),
    };
  });
  // Earlier picks were unknown when later stations' alternates were
  // collected. Check every replacement against the completed route.
  const selectedIds=new Set(steps.map(s=>s.entity_id.toLowerCase()));
  steps.forEach((step,i)=>{
    step.alternates=step.alternates.filter(alt=>!selectedIds.has(alt.entity_id.toLowerCase())
      &&!entryTargets.some(target=>entrySeriesReason(alt,target))
      &&!routeSeriesConflict([...(opts.fixedPrefix??[]),...steps.map((current,k)=>k===i?alt:current)]));
  });

  // The destination's own home affinity is measured once, directly; if
  // Qloo has no reading for it the field stays empty — never invented.
  const destAffMap = await oracle(finalDtype, seedIds, [finalDest.id], apiKey);
  const lastStep = steps[steps.length - 1];
  if (lastStep) lastStep.aff_from_seeds = destAffMap[finalDest.id] ?? null;

  // Keep the actual destination-backtracking measurements. The
  // queried signal is the next station (or the destination pack),
  // and the returned result is this station. No opposite-direction gate.
  const reverseLinks:ReverseLink[]=[];
  for(let i=0;i<chain.length-1;i++){
    const c=chain[i],m=hopMeta.get(c.id);
    if(!m)continue;
    const link:ReverseLink={from_entity_id:m.anchorId,to_entity_id:c.id,from_name:m.anchorName,to_name:c.name,affinity:m.hop,minimum:.72,signal_entity_ids:[...m.signalIds],basis:m.pack?"pack":"entity"};
    reverseLinks.push(link);steps[i].reverse_link=link;
    steps[i].edge_note=(i===0?`与你的已有喜欢关联 ${steps[i].aff_from_seeds==null?"未测得":fmtAff(steps[i].aff_from_seeds!)}；`:"")+`以《${link.from_name}》${m.pack?"系列":""}为信号找到《${link.to_name}》，关联 ${fmtAff(link.affinity)}（Qloo倒推实测）`;
    const note=swapNotes.get(c.id);if(note)steps[i].edge_note+='；'+note;
  }

  const ringRaw2 = await insightsEntities(finalDtype, [finalDest.id], apiKey, 50, 1);
  const stepIds = new Set(steps.map((s) => s.entity_id));
  const ring2 = ringRaw2
    .map(entBrief)
    .filter((c) => !stepIds.has(c.id) && c.id !== finalDest.id && !entryTargets.some(target=>entrySeriesReason(c,target)));
  const baseW = ring2.slice(0, 3).map((c) => ({ ...itemFor(c), title: c.name }));
  const destW = ring2.slice(3, 6).map((c) => ({ ...itemFor(c), title: c.name }));

  // destination_tags: the destination's own tag profile, read through
  // tagProfile with its own stage label so an upstream failure here
  // is reported as stage "destination_tags" (not the generic profile
  // stage) and propagates under the typed-error rules.
  let tags: { tag: string; name: string; affinity: number }[] = [];
  try {
    // Deliberately NOT the shared cache: this read carries its own
    // stage label ("destination_tags") in typed-error reports, which
    // is part of the failure contract — a cached profile would hide
    // a failure at exactly this stage. It costs one call per build.
    const profile = await tagProfile([finalDest.id], apiKey, "destination_tags");
    tags = [...profile.values()]
      .map((t) => ({ tag: t.id, name: t.name, affinity: t.affinity }))
      .slice(0, 30);
  } catch (e) {
    if (isQlooTypedError(e)) throw e;
    tags = [];
  }


  // Human-readable per-step reasons — the OPTIONAL explanation stage
  // (why two-stage contract). attachWhys never throws: explanation
  // failures degrade per-step explanation_status instead of failing
  // the route, because every required measurement (identity, edges,
  // hard conditions, motivation) is already complete at this point.
  // The route-level status is stored on the meta next to the steps.
  await runExplanation(() => attachWhys(steps.map((s,i)=>Object.assign(s,{is_destination:i===steps.length-1})), seeds, apiKey, sharedCache));

  // Motivation attribution: when a step's measured tag profile really
  // carries a selected motivation tag (or a close relative), the why
  // may say so — one factual sentence, only on a measured hit.
  if (motSignals.length > 0) {
    for (const s of steps) {
      if (!s.why) continue;
      for (const sig of motSignals) {
        const m = motMatches(sig, s.entity_id);
        if (!m) continue;
        // Direct hit: the station's own profile carries the tag —
        // name the VERIFIED tag, not the signal's label. Kinship
        // hit: say kinship, with the measured affinity; never claim
        // the station "has" the requested tag.
        const fact =
          m.basis === "direct"
            ? `这一站的标签里有你想看的『${m.actualTag}』。`
            : `这一站的『${m.actualTag}』与你想看的『${sig.label}』是近亲（Qloo 关联亲和 ${(m.affinity ?? 0).toFixed(2)}）。`;
        if (s.why.explanation_status === "missing" || !s.why.text) {
          // A measured motivation fact is still only an edge fact,
          // not a tag-level explanation: the step stays partial.
          s.why.text = fact;
          s.why.explanation_status = "partial";
        } else {
          s.why.text = `${s.why.text}另外，${fact}`;
        }
        break;
      }
    }
  }


  const rid =
    "auto2-" +
    finalDest.name.toLowerCase().split(" ").join("-").slice(0, 24) +
    "-" +
    crypto.randomUUID();

  const edgeScores: Record<string, { aff_from_seeds: number | null }> = {};
  for (const s of steps) edgeScores[s.entity_id] = { aff_from_seeds: s.aff_from_seeds };

  // Seed list for the route header: pack seeds collapse into one
  // labelled entry (their members stay fully listed in seed_packs).
  const packMemberIds = new Set(
    seedPacks.flatMap((p) => p.members.map((m) => m.id)),
  );
  const seedLabels: string[] = [];
  const emittedPacks = new Set<string>();
  for (const s of seeds) {
    const pack = seedPacks.find((p) => p.members.some((m) => m.id === s.id));
    if (pack && packMemberIds.has(s.id)) {
      const packKey = `${pack.label}::${pack.flavor ?? "all"}`;
      if (!emittedPacks.has(packKey)) {
        emittedPacks.add(packKey);
        // Whole-series echo keeps 「系列包」; a flavor pack echoes as
        // 「{类型中文}包」 (e.g. batman（电影包 ×3）).
        seedLabels.push(
          pack.flavor && pack.flavor !== "all"
            ? `${pack.label}（${flavorLabelZh(pack.flavor)}包 ×${pack.members.length}）`
            : `${pack.label}（系列包 ×${pack.members.length}）`,
        );
      }
      continue;
    }
    seedLabels.push(s.name);
  }

  // A-item constraint report: one entry per ACTIVE constraint, in the
  // user's own words (excerpt), stating exactly what it did — or why
  // it did nothing. The same facts are folded into the provenance
  // line so the audit trail carries them verbatim.
  const YEAR_BOUNDARY_NOTE =
    "年份口径说明：作品按发行年算；歌手、乐队和人物按 Qloo 给这个人标注的年份算（多半是出道或成军的年份，跟作品发行年不是一回事）；没有年份的按不符合这条偏好计。它只影响亲和接近时的替换，永远不会把谁淘汰掉。";
  const isYearSoftKind = (kind: ConstraintKind): boolean =>
    kind === "avoid_old" || kind === "prefer_recent" || kind === "prefer_old";
  const withYearBoundaryNote = (detail: string, kind: ConstraintKind): string =>
    isYearSoftKind(kind) && !detail.includes(YEAR_BOUNDARY_NOTE)
      ? `${detail}${YEAR_BOUNDARY_NOTE}`
      : detail;
  const constraintReport: ConstraintReportEntry[] = constraints.map((c) => {
    if (c.kind === "unhandled_length") {
      return {
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "unhandled" as const,
        detail:
          "篇幅长短 Qloo 没有可靠数据，这条没拿来选路，只记下来到站陪你复盘。",
      };
    }
    if (c.kind === "unhandled_pace") {
      return {
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "unhandled" as const,
        detail:
          "节奏快慢 Qloo 没有可测的信号，这条没拿来选路，只记下来到站陪你复盘。",
      };
    }
    if (c.hard) {
      const log = filterLog.get(c.id);
      // avoid_gore always carries its calibre sentence: the filter is
      // only as complete as Qloo's tag coverage (once per route —
      // there is exactly one report entry per constraint).
      const goreSuffix = c.kind === "avoid_gore" ? GORE_CALIBER_NOTE : "";
      if (log && log.count > 0) {
        return {
          id: c.id,
          label: c.label,
          excerpt: c.excerpt,
          source: c.source,
          status: "applied" as const,
          detail: `选路时排除了 ${log.count} 部命中这条的候选（${log.names.map((n) => `《${n}》`).join("")}${log.count > log.names.length ? " 等" : ""}）。${goreSuffix}`,
        };
      }
      return {
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "no_effect" as const,
        detail: `这一轮的候选里没有命中这条的作品，没有可排除的。${goreSuffix}`,
      };
    }
    const swaps = swapRecords.filter((s) => s.constraintId === c.id);
    if (swaps.length > 0) {
      return {
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "applied" as const,
        detail: withYearBoundaryNote(
          `在亲和容差 ${SOFT_SWAP_TOLERANCE} 内换了 ${swaps.length} 步：${swaps
            .map(
              (s) =>
                `把《${s.fromName}》换成《${s.toName}》${s.toYear != null ? `（${s.toYear} 年）` : ""}，亲和仅差 ${s.diff.toFixed(2)}`,
            )
            .join("；")}。`,
          c.kind,
        ),
      };
    }
    const missed = missedSoft.get(c.id) ?? 0;
    if (missed > 0) {
      return {
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "no_effect" as const,
        detail: withYearBoundaryNote(
          `有 ${missed} 跳的原选不符合这条偏好，但亲和容差 ${SOFT_SWAP_TOLERANCE} 内没有符合的候选可换——再换就要牺牲边的实测质量了，所以那几步照原样留着。`,
          c.kind,
        ),
      };
    }
    if (satisfiedSoft.has(c.id)) {
      return {
        id: c.id,
        label: c.label,
        excerpt: c.excerpt,
        source: c.source,
        status: "no_effect" as const,
        detail: withYearBoundaryNote(
          "每一跳选中的本来就符合这条偏好，没有需要换位的。",
          c.kind,
        ),
      };
    }
    return {
      id: c.id,
      label: c.label,
      excerpt: c.excerpt,
      source: c.source,
      status: "no_effect" as const,
      detail: withYearBoundaryNote(
        `亲和容差 ${SOFT_SWAP_TOLERANCE} 内没有符合这条偏好的候选——怕伤了边的实测质量，就没硬换。`,
        c.kind,
      ),
    };
  });
  // Caller-decided fates (destination conflict, unverifiable or
  // self-conflicting manual tags) join the report verbatim.
  const fullConstraintReport: ConstraintReportEntry[] = [
    ...constraintReport,
    ...(opts.extraReportEntries ?? []),
  ];
  // Motivation report: one entry per signal that entered routing —
  // changed a pick (with hop, both names and the affinity difference),
  // entered but changed nothing (with its entry point), or could not
  // be measured anywhere on this route.
  const motivationReport: MotivationReportEntry[] = motSignals.map((sig) => {
    const swaps = motSwapRecords.filter((s) => s.signalId === sig.signalId);
    if (swaps.length > 0) {
      return {
        signal_id: sig.signalId,
        label: sig.label,
        status: "applied_changed" as const,
        detail: swaps
          .map(
            (s) =>
              s.basis === "kinship"
                ? `第 ${s.stepN} 步：把《${s.fromName}》换成《${s.toName}》，亲和仅差 ${s.diff.toFixed(2)}——换上的这部『${s.actualTag}』与你想看的『${sig.label}』是近亲（Qloo 关联亲和 ${(s.affinity ?? 0).toFixed(2)}）。`
                : `第 ${s.stepN} 步：把《${s.fromName}》换成《${s.toName}》，亲和仅差 ${s.diff.toFixed(2)}——换上的这部带『${s.actualTag}』的标签。`,
          )
          .join(""),
      };
    }
    const hit = motPickHits.get(sig.signalId);
    if (hit) {
      return {
        signal_id: sig.signalId,
        label: sig.label,
        status: "applied_no_change" as const,
        detail:
          hit.match.basis === "kinship"
            ? `进入点在第 ${hit.stepN} 步：《${hit.name}》的『${hit.match.actualTag}』与你想看的『${sig.label}』是近亲（Qloo 关联亲和 ${(hit.match.affinity ?? 0).toFixed(2)}），原选已经命中，没需要换的。`
            : `进入点在第 ${hit.stepN} 步：《${hit.name}》本来就带着『${hit.match.actualTag}』的标签，原选已经命中，没需要换的。`,
      };
    }
    const cand = motCandHits.get(sig.signalId);
    if (cand != null) {
      return {
        signal_id: sig.signalId,
        label: sig.label,
        status: "applied_no_change" as const,
        detail:
          cand.match.basis === "kinship"
            ? `每一跳都拿它量过候选：第 ${cand.stepN} 步的候选里有与『${sig.label}』近亲的『${cand.match.actualTag}』，但都在亲和容差 ${SOFT_SWAP_TOLERANCE} 之外，换了就要牺牲边的实测质量，所以没有改变选择。`
            : `每一跳都拿它量过候选：第 ${cand.stepN} 步的候选里有带『${cand.match.actualTag}』标签的，但都在亲和容差 ${SOFT_SWAP_TOLERANCE} 之外，换了就要牺牲边的实测质量，所以没有改变选择。`,
      };
    }
    return {
      signal_id: sig.signalId,
      label: sig.label,
      status: "unhandled" as const,
      detail: `这一轮每一跳的候选标签里都没测到『${sig.label}』，没有可量化的落点，这条只记下来复盘。`,
    };
  });
  const provNotes: string[] = [];
  if(unavailableBranches.length)provNotes.push('部分媒介未取得关联数据，本路线使用已测得的候选。');
  for (const entry of constraintReport) {
    if (entry.status === "applied") {
      provNotes.push(`约束「${entry.label}」生效：${entry.detail}`);
    } else if (entry.status === "unhandled") {
      provNotes.push(
        `你写的「${entry.excerpt}」属于${entry.id === "unhandled_length" ? "篇幅" : "节奏"}问题，Qloo 测不了，未参与选路`,
      );
    }
  }
  for (const entry of motivationReport) {
    if (entry.status === "applied_changed") {
      provNotes.push(`动机「${entry.label}」生效：${entry.detail}`);
    }
  }
  const provenanceLine = [
    "由 Qloo 路由器 v2 从目的地倒推，结合已有喜欢逐步选路",
    ...provNotes,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    schema: "acquired-route/2",
    route_id: rid,
    meta: {
      title: `自动路线：${seedLabels.join(" × ")} → ${destLabel}`,
      destination: destLabel,
      destination_entity_id: finalDest.id,
      entry_policy: "exclude_destination_series_v1",
      destination_content_policy: "catalogue_work_and_companion_v1",
      entry_exclusions: [...entryExclusions.values()],
      series_order_policy: "catalogue_sequence_v1",
      series_order_exclusions: [...orderExclusions.values()],
      query_branch_policy: 'verified_optional_type_rejection_v1',
      unavailable_query_branches: unavailableBranches,
      seed_labels: seedLabels,
      seed_entities: seeds.map((s) => ({
        id: s.id,
        name: s.name,
        type: normEntType(s.type),
      })),
      seed_packs: seedPacks.length > 0 ? seedPacks : null,
      destination_pack: destPack
        ? {
            label: destPack.info.label,
            flavor: destPack.info.flavor ?? "all",
            // info.members is the validated member table (built from
            // the kept members in the handler) and carries the manual
            // flags; memberEnts holds the same members as briefs.
            members: destPack.info.members,
          }
        : null,
      destination_representative: destPack
        ? { id: finalDest.id, name: finalDest.name }
        : null,
      motivation,
      barrier,
      constraints: constraints.length > 0 ? constraints : null,
      constraint_report:
        fullConstraintReport.length > 0 ? fullConstraintReport : null,
      motivation_signals: motSignals.length > 0 ? motSignals : null,
      motivation_report: motivationReport.length > 0 ? motivationReport : null,
      /** Why two-stage contract: route-level explanation status
       * (each step also carries its own on why.explanation_status).
       * A route delivered with partial/missing explanations is NOT
       * a full success and the client presents it as such. */
      routing_method: "destination_backtracking",
      reverse_links: reverseLinks,
      explanation_status: explanationStatusFor(steps),
      provenance: provenanceLine,
      protocol: "先说说想来的原因、没进来的原因→逐步走路（走不动可换步）→到站小结；到站后可自愿再尝三口，不设判定。",
    },
    config: ROUTER_CONFIG,
    baseline_works: baseW,
    destination_works: destW,
    aux_retest: null,
    steps,
    edge_scores: edgeScores,
    destination_tags: tags,
    tag_baseline_note: "种子侧与目的地侧标签位移待走后补算。",
  };
}

// --- score-driven rerouting (GPS-style, by step 好感） -----------------------
//
// A walk step rated 好感 ≤2 (a "cliff" step) can trigger a reroute of the
// remaining route: the steps before it stay a fixed prefix, the prefix's
// last step joins the seed set as an extra anchor, the cliff entity is
// excluded, and router v2 rebuilds exactly the remaining step count to
// the unchanged destination. The action returns the full spliced
// bundle; the client applies it to its session state (prefix step
// states untouched, tail states fresh, log line appended) and persists
// through the normal saveSession path. On any honest router failure
// nothing is returned but a plain-language error and the session is
// left exactly as it was.

type StoredEntRef = { id: string; name: string; type: string };

function storedEntRef(v: unknown): StoredEntRef | null {
  const o = asObj(v);
  const id = asStr(o.entity_id) || asStr(o.id);
  const name = asStr(o.name);
  if (!id || !name) return null;
  return { id, name, type: normEntType(asStr(o.type)) || "tv_show" };
}

/** Recover a full EntBrief for a stored entity reference: re-fetch by
 * name and match the id (recovering desc/year/byline); the stored
 * reference supplies no fallback facts if the catalogue no longer
 * returns its ID; rebuilding then fails closed. */
async function briefForStored(
  ref: StoredEntRef,
  apiKey: string,
): Promise<EntBrief> {
  const match=await hydratePinned(ref,apiKey);
  if(!match)throw new Error('保存的条目暂时无法核实，请重新确认路线。');
  return match;
}

/** The session's effective entity for one step position: the swap
 * override when the walker swapped that step, else the bundle step. */
function effectiveStoredStep(
  bundleStep: unknown,
  sessionStepRaw: unknown,
): StoredEntRef | null {
  const ss = asObj(sessionStepRaw);
  const override = ss.override;
  if (override != null && typeof override === "object") {
    const ref = storedEntRef(override);
    if (ref) return ref;
  }
  return storedEntRef(bundleStep);
}

function entryWorkOfStored(raw: unknown): EntryWork {
  const value=asObj(raw),series=asObj(value.entrySeries);
  return {id:asStr(value.id)||asStr(value.entity_id),name:asStr(value.name),type:asStr(value.type),byline:asStr(value.byline),bio:asStr(value.bio),description:asStr(value.description),
    entrySeries:{groups:(Array.isArray(series.groups)?series.groups:[]).filter((v):v is string=>typeof v==='string'),description:asStr(series.description)}};
}

function effectiveEntryWork(bundleStep:unknown,sessionStep:unknown):EntryWork {
  const override=asObj(sessionStep).override;
  return entryWorkOfStored(storedEntRef(override)?override:bundleStep);
}

/** Rebuild the original seed entities for a stored bundle. New routes
 * carry meta.seed_entities verbatim; older routes fall back to their
 * seed packs' member tables, then to resolving the plain seed labels
 * through the same name-checked search pipeline, and finally to the
 * per-step why attribution (every step built by router v2 records the
 * seed that pulled it in: seed name + seed_id). */
async function reconstructSeedEnts(
  meta: Record<string, unknown>,
  bundleSteps: unknown[],
  apiKey: string,
): Promise<EntBrief[]> {
  const out: EntBrief[] = [];
  const seen = new Set<string>();
  const push = async (ref: StoredEntRef) => {
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    out.push(await briefForStored(ref, apiKey));
  };
  const seedEntities = meta.seed_entities;
  if (Array.isArray(seedEntities) && seedEntities.length > 0) {
    for (const raw of seedEntities) {
      const ref = storedEntRef(raw);
      if (ref) await push(ref);
    }
    if (out.length > 0) return out;
  }
  const packs = meta.seed_packs;
  if (Array.isArray(packs)) {
    for (const p of packs) {
      const members = asObj(p).members;
      if (!Array.isArray(members)) continue;
      for (const m of members) {
        const ref = storedEntRef(m);
        if (ref) await push(ref);
      }
    }
  }
  const labels = meta.seed_labels;
  if (Array.isArray(labels)) {
    for (const raw of labels) {
      if (typeof raw !== "string") continue;
      // Pack labels are display text ("name（系列包 ×N）"); their members
      // were already recovered from seed_packs above.
      if (/（.*包 ×\d+）$/.test(raw)) continue;
      try {
        const found = await searchEntities(raw, apiKey);
        const hit =
          found.find((e) => nameMatch(raw, e.name)) ?? found[0];
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          out.push({ ...hit, type: normEntType(hit.type) });
        }
      } catch (e) {
        if (isQlooTypedError(e)) throw e;
      }
    }
  }
  if (out.length === 0) {
    // Oldest bundles carry no seed list at all, but every step's why
    // records the seed that pulled it in (name + seed_id).
    for (const raw of bundleSteps) {
      const why = asObj(asObj(raw).why);
      const seedId = asStr(why.seed_id);
      const seedName = asStr(why.seed);
      if (!seedId || !seedName || seen.has(seedId)) continue;
      seen.add(seedId);
      out.push(
        await briefForStored(
          { id: seedId, name: seedName, type: "tv_show" },
          apiKey,
        ),
      );
    }
  }
  return out;
}

/** Stored seed packs as PackInfo[] (for the intermediate rebuild's
 * provenance labelling only). */
function storedSeedPacks(meta: Record<string, unknown>): PackInfo[] {
  const packs = meta.seed_packs;
  if (!Array.isArray(packs)) return [];
  const out: PackInfo[] = [];
  for (const p of packs) {
    const po = asObj(p);
    const membersRaw = po.members;
    if (!Array.isArray(membersRaw)) continue;
    const members: PackMember[] = [];
    for (const m of membersRaw) {
      const ref = storedEntRef(m);
      if (!ref) continue;
      members.push({
        id: ref.id,
        name: ref.name,
        type: ref.type,
        year: typeof asObj(m).year === "number" ? (asObj(m).year as number) : null,
        ...(asObj(m).manual === true ? { manual: true } : {}),
      });
    }
    if (members.length > 0) {
      out.push({
        label: asStr(po.label),
        flavor: asStr(po.flavor) || "all",
        members,
      });
    }
  }
  return out;
}

async function getStoredQlooKey(_ctx: Ctx): Promise<string | null> {
  const value=(env as unknown as Record<string,string>).QLOO_API_KEY?.trim();
  return value || null;
}

const okResponse = z.object({ ok: z.literal(true) });

const routeSummary = z.object({
  route_id: z.string(),
  title: z.string(),
  destination: z.string(),
});

const saveKeyResponse = z.object({ ok: z.literal(true), has_key: z.boolean() });
const keyStatusResponse = z.object({ has_key: z.boolean() });
const packMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  year: z.number().nullable().optional(),
  // True only for members the user added by hand in the pack editor.
  manual: z.boolean().optional(),
});

const packSchema = z.object({
  label: z.string(),
  // "all" for the whole-series pack, else the flavor's content type.
  // Optional so a pack object without it still validates (treated as
  // "all" wherever it is read).
  flavor: z.string().optional(),
  members: z.array(packMemberSchema),
});

const pinnedEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  // Candidate-card facts from the entity's own /search payload (see
  // PinnedEnt). Optional so pins sent back by the client validate with
  // or without them; the server only reads id/name/type from a pin.
  desc: z.string().nullable().optional(),
  year: z.number().nullable().optional(),
  byline: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  // Series-pack form: {pack:true, label, flavor, members:[{id,name,type}]}.
  // id/name/type stay filled (first member) so older shapes still parse.
  // flavor is "all" or a content type; absent on pre-flavor pins (= "all").
  pack: z.boolean().optional(),
  label: z.string().nullable().optional(),
  flavor: z.string().nullable().optional(),
  members: z.array(packMemberSchema).nullable().optional(),
});

const needChoiceSchema = z.object({
  field: z.enum(["destination", "seed"]),
  index: z.number().nullable(),
  query: z.string(),
  candidates: z.array(pinnedEntitySchema),
  hint: z.string(),
  tier: z.enum(["choices", "none_found", "out_of_scope"]),
  scope_type_label: z.string().nullable(),
  closest: z.array(z.string()),
  via_translation: z.string().nullable(),
  packs: z.array(packSchema).nullable(),
});

const constraintSchema = z.object({
  id: z.string(),
  source: z.enum(["barrier", "motivation", "manual"]),
  kind: z.string(),
  hard: z.boolean(),
  label: z.string(),
  excerpt: z.string(),
  entryId: z.string().nullable(),
  tagId: z.string().nullable(),
  conflict: z
    .object({
      status: z.enum(["pending", "inactive", "active"]),
      evidence: z.string(),
    })
    .nullable(),
  needsDestinationCheck: z.boolean(),
});

const motivationSignalSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.enum(["text", "destination_tags", "manual", "pending_supplement"]),
  tagId: z.string().nullable(),
  status: z.enum(["ready", "pending", "unhandled"]),
  excerpt: z.string(),
  supplement: z
    .object({
      field: z.string(),
      examples: z.array(z.string()),
    })
    .nullable(),
});

const checkStatusSchema = z.object({
  destination_evidence: z.enum(["checked", "failed", "skipped"]),
  motivation_tags: z.enum(["checked", "failed", "skipped"]),
});

const motivationReportEntrySchema = z.object({
  signal_id: z.string(),
  label: z.string(),
  status: z.enum(["applied_changed", "applied_no_change", "unhandled"]),
  detail: z.string(),
});

const manualConstraintSchema = z
  .object({
    entryId: z.string().min(1).max(64),
    kind: z.enum([
      "avoid_horror",
      "avoid_gore",
      "avoid_anime",
      "avoid_book",
      "avoid_old",
      "avoid_tag",
      "prefer_recent",
      "prefer_old",
      "prefer_horror",
      "prefer_tag",
      "unhandled_length",
      "unhandled_pace",
    ]),
    tagId: z.string().min(1).max(300).optional(),
    label: z.string().min(1).max(100).optional(),
  })
  .refine(
    (o) =>
      (o.kind !== "avoid_tag" && o.kind !== "prefer_tag") || !!o.tagId,
    { message: "tag 类条件必须带 tagId" },
  );

const manualMotivationSignalSchema = z.object({
  label: z.string().min(1).max(100),
  tagId: z.string().min(1).max(300),
});

const brokenConstraintSchema = z.object({
  id: z.string(),
  label: z.string(),
  excerpt: z.string(),
});

const errorDetailSchema = z.object({
  reason: z.enum([
    "rate_limited",
    "upstream_5xx",
    "network",
    "signal_unavailable",
    "measurement_incomplete",
    "request_rejected",
    "forward_link_unverified",
  ]),
  status: z.number().nullable(),
  stage: z.string(),
  retry_after_seconds: z.number().nullable(),
  retryable: z.boolean(),
  signal_entity_ids: z.array(z.string()).optional(),
  link_check:z.object({from_entity_id:z.string(),to_entity_id:z.string(),from_name:z.string(),to_name:z.string(),affinity:z.number().nullable(),minimum:z.number()}).optional(),
  candidate_chain:z.array(z.object({id:z.string(),name:z.string(),type:z.string()})).optional(),
  candidate_chain_complete:z.boolean().optional(),
  candidate_checks:z.array(z.object({from_entity_id:z.string(),to_entity_id:z.string(),from_name:z.string(),to_name:z.string(),affinity:z.number().nullable(),minimum:z.number()})).optional(),
  verified_links:z.array(z.object({from_entity_id:z.string(),to_entity_id:z.string(),from_name:z.string(),to_name:z.string(),affinity:z.number(),minimum:z.number()})).optional(),
  measurement_counts: z
    .object({
      ring: z.number(),
      eligible: z.number(),
      hop_measured: z.number(),
      home_measured: z.number(),
      complete: z.number(),
    })
    .optional(),
});

const parseConstraintsResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: errorDetailSchema.nullable(),
  constraints: z.array(constraintSchema),
  motivationSignals: z.array(motivationSignalSchema),
  contract_version: z.number(),
  check_status: checkStatusSchema,
});

const conflictDecisionSchema = z.object({
  id: z.string(),
  label: z.string(),
  excerpt: z.string(),
  evidence: z.string(),
});

const buildRouteResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: errorDetailSchema.nullable(),
  bundle: z.string().nullable(),
  route_id: z.string().nullable(),
  need_choice: needChoiceSchema.nullable(),
  /** Set when a hard user constraint filtered the route dry: which
   * constraint did it, so the UI can offer「放宽这条重建」. */
  broken_constraint: brokenConstraintSchema.nullable(),
  /** Set with error_code "need_conflict_decision": a topic-class
   * avoid collides with the destination and the user has neither
   * confirmed nor disabled it — no route was built. The client asks
   * and re-sends with the id in confirmedConflictIds (enable) or
   * disabledConflictIds (disable). */
  conflict_decision: conflictDecisionSchema.nullable(),
  /** Contract v2: motivation signals that entered routing, one
   * receipt each (also stored on the route meta). */
  contract_version: z.number(),
  motivation_report: z.array(motivationReportEntrySchema).nullable(),
});

const rerouteResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: errorDetailSchema.nullable(),
  bundle: z.string().nullable(),
  log_line: z.string().nullable(),
  contract_version: z.number(),
});

const swapStepResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: errorDetailSchema.nullable(),
  /** The measured replacement step as a JSON string (same shape the
   * client stores as a step override), or null when the swap did not
   * happen — the walker's current step then stays exactly as it was. */
  step: z.string().nullable(),
});

const packSearchResponse = z.object({
  candidates: z.array(pinnedEntitySchema),
  error: z.string().nullable(),
});

const signalCheckResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  error_detail: errorDetailSchema.nullable(),
});

const packValidateResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});

/** Candidate-card shape for the pack editor's manual-add search: the
 * same distinguishing facts (desc/year/byline/image) the disambiguation
 * candidates carry, all from the entity's own /search payload. */
function candidateCard(e: EntBrief): PinnedEnt {
  const cardDesc = plainText(e.desc);
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    desc: cardDesc ? (cardDesc.length > 63 ? `${cardDesc.slice(0, 60)}…` : cardDesc) : null,
    year: e.year,
    byline: e.byline || null,
    image: e.image || null,
  };
}

export const Actions = {
  // --- Qloo key + router ---------------------------------------------------

  getQlooKeyStatus: defineAction({
    request: z.object({}),
    response: keyStatusResponse,
    handler: async (ctx): Promise<z.infer<typeof keyStatusResponse>> => {
      const key = await getStoredQlooKey(ctx);
      return { has_key: key != null };
    },
  }),

  /** A-item: parse barrier/motivation into constraints with the same
   * deterministic parser the router uses, so the home form can echo
   *「我听到的约束」as removable chips BEFORE building, plus the
   * motivation signals (contract v2). When the caller already pinned
   * a destination (destinationEntityId), topic-class avoids are
   * checked against the destination's own tag profile: a destination
   * that itself carries horror tags marks the chip as a pending
   * conflict; a generic「被概念吸引」motivation with no concrete
   * concept yields pending candidate signals from the destination's
   * quotable taste tags. The destination checks are best-effort echo
   * aids — buildRoute re-checks before anything takes effect. */
  parseConstraints: defineAction({
    request: z.object({
      barrier: z.string().max(1000).optional(),
      motivation: z.string().max(1000).optional(),
      destinationEntityId: z.string().min(1).max(200).optional(),
      destinationName: z.string().min(1).max(200).optional(),
    }),
    response: parseConstraintsResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof parseConstraintsResponse>> => {
      const barrier = (args.barrier ?? "").trim();
      const motivation = (args.motivation ?? "").trim();
      const parsed = parseConstraints(barrier, motivation);
      const { signals, genericPending } = parseMotivationSignals(
        motivation,
        parsed,
      );
      const checkStatus: z.infer<typeof checkStatusSchema> = {
        destination_evidence: "skipped",
        motivation_tags: "skipped",
      };
      const finish = (): z.infer<typeof parseConstraintsResponse> => ({
        ok: true,
        error: null,
        error_code: null,
        error_detail: null,
        constraints: parsed.map((c) => ({
          id: c.id,
          source: c.source,
          kind: c.kind,
          hard: c.hard,
          label: c.label,
          excerpt: c.excerpt,
          entryId: c.entryId ?? null,
          tagId: c.tagId ?? null,
          conflict: c.conflict ?? null,
          needsDestinationCheck: c.needsDestinationCheck === true,
        })),
        motivationSignals: signals.map((s) => ({
          id: s.id,
          label: s.label,
          source: s.source,
          tagId: s.tagId,
          status: s.status,
          excerpt: s.excerpt,
          supplement: s.supplement ?? null,
        })),
        contract_version: 2,
        check_status: checkStatus,
      });
      const failUpstream = (
        e: QlooRateLimitError | QlooUpstreamError,
      ): z.infer<typeof parseConstraintsResponse> => ({
        ok: false,
        error: qlooFailureMessage(qlooFailureCode(e)),
        error_code: qlooFailureCode(e),
        error_detail: upstreamDetailFor(e),
        constraints: [],
        motivationSignals: [],
        contract_version: 2,
        check_status: checkStatus,
      });
      const destId = args.destinationEntityId?.trim();
      let destTagSignalsAdded = 0;
      if (destId) {
          const apiKey = await getStoredQlooKey(ctx);
        if (apiKey) {
          const topicAvoids = parsed.filter(
            (c) => c.kind === "avoid_horror",
          );
          if (topicAvoids.length > 0) {
            // Typed upstream failures here are NOT a quiet "no
            // conflict": they abort through the upstream_unavailable
            // channel with stage "destination_evidence". A non-typed
            // failure marks the check failed — never a fake "checked".
            try {
              const catalog = args.destinationName ? (await searchEntities(args.destinationName,apiKey)).find(e=>e.id.toLowerCase()===destId.toLowerCase()) : undefined;
              const evidence = await destinationHorrorEvidence(destId, apiKey, catalog);
              checkStatus.destination_evidence = "checked";
              if (evidence) {
                for (const c of topicAvoids) {
                  c.conflict = { status: "pending", evidence };
                }
              }
            } catch (e) {
              if (e instanceof QlooRateLimitError || e instanceof QlooUpstreamError) {
                checkStatus.destination_evidence = "failed";
                return failUpstream(e);
              }
              if (e instanceof QlooAuthError) {
                checkStatus.destination_evidence = "failed";
                return {
                  ok: false,
                  error: "密钥不对或已失效，请检查后重新保存",
                  error_code: "auth",
                  error_detail: null,
                  constraints: [],
                  motivationSignals: [],
                  contract_version: 2,
                  check_status: checkStatus,
                };
              }
              checkStatus.destination_evidence = "failed";
            }
          }
          if (genericPending && signals.every((s) => s.tagId == null)) {
            try {
              const profile = await tagProfile([destId], apiKey, "motivation_tags");
              checkStatus.motivation_tags = "checked";
              const top = quotableTags(profile)
                .sort((a, b) => b.affinity - a.affinity)
                .slice(0, 3);
              for (const t of top) {
                signals.push({
                  id: `mot:dest:${t.id.split(":").pop() ?? "tag"}`,
                  label: t.name,
                  source: "destination_tags",
                  tagId: t.id,
                  status: "pending",
                  excerpt:
                    motivation.match(/[^，。；]*?(概念|设定|题材|世界观)[^，。；]*/)?.[0] ??
                    motivation.slice(0, 24),
                });
                destTagSignalsAdded++;
              }
            } catch (e) {
              if (e instanceof QlooRateLimitError || e instanceof QlooUpstreamError) {
                checkStatus.motivation_tags = "failed";
                return failUpstream(e);
              }
              if (e instanceof QlooAuthError) {
                checkStatus.motivation_tags = "failed";
                return {
                  ok: false,
                  error: "密钥不对或已失效，请检查后重新保存",
                  error_code: "auth",
                  error_detail: null,
                  constraints: [],
                  motivationSignals: [],
                  contract_version: 2,
                  check_status: checkStatus,
                };
              }
              checkStatus.motivation_tags = "failed";
            }
          }
        }
      }
      // Generic pending with nothing concrete to offer (no pinned
      // destination, or the destination yielded no usable tags): say
      // so with an explicit placeholder signal instead of silence.
      // The placeholder carries what a supplement entry needs (field
      // name + examples) and never enters routing or any report.
      if (
        genericPending &&
        destTagSignalsAdded === 0 &&
        signals.every((s) => s.tagId == null)
      ) {
        signals.push(genericPendingPlaceholder(motivation));
      }
      return finish();
    },
  }),

  buildRoute: defineAction({
    request: z.object({
      seeds: z.array(z.string().min(1).max(200)).min(1).max(20),
      destination: z.string().min(1).max(200),
      steps: z.number().int().min(3).max(10),
      barrier: z.string().max(1000).optional(),
      motivation: z.string().max(1000).optional(),
      /** Ids of the parsed constraints the user left active (chips not
       * removed). Absent = every parsed constraint is active. */
      constraintIds: z.array(z.string().max(60)).max(20).optional(),
      /** Contract v2: constraints the user added by hand (the client
       * has no entry UI yet; the contract is server-first). Merged
       * over the parsed set by (kind, tagId) identity. */
      manualConstraints: z.array(manualConstraintSchema).max(20).optional(),
      /** Ids of topic-avoid constraints whose destination conflict the
       * user explicitly confirmed（「仍要避开」). An unconfirmed
       * conflicting avoid does not take effect. */
      confirmedConflictIds: z.array(z.string().max(64)).max(20).optional(),
      /** Ids of topic-avoid constraints whose destination conflict the
       * user explicitly decided to DISABLE（「停用」). A conflicting
       * avoid in neither list aborts the build with
       * error_code "need_conflict_decision" — no route is built. */
      disabledConflictIds: z.array(z.string().max(64)).max(20).optional(),
      /** Motivation signal ids (from parseConstraints) the user left
       * selected. Only these — plus manualMotivationSignals — enter
       * routing. */
      selectedMotivationIds: z.array(z.string().max(160)).max(40).optional(),
      requireMotivationDecision:z.boolean().optional(),
      motivationDeferred:z.boolean().optional(),
      manualMotivationSignals: z
        .array(manualMotivationSignalSchema)
        .max(10)
        .optional(),
      destPinned: pinnedEntitySchema.optional(),
      seedPinned: z.record(z.string(), pinnedEntitySchema).optional(),
    }),
    response: buildRouteResponse,
    handler: async (ctx, args): Promise<z.infer<typeof buildRouteResponse>> => {
      const seeds = args.seeds.map((s) => s.trim()).filter(Boolean);
      const destination = args.destination.trim();
      if (!destination || seeds.length === 0) {
        return {
          ok: false,
          error: "种子和目的地都要填。",
          error_code: "invalid_input",
          error_detail: null,
          bundle: null,
          route_id: null,
          need_choice: null,
          broken_constraint: null,
          conflict_decision: null,
          contract_version: 2,
          motivation_report: null,
        };
      }
      const apiKey = await getStoredQlooKey(ctx);
      if (!apiKey) {
        return {
          ok: false,
          error: "请在站点设置配置 QLOO_API_KEY 服务端 Secret",
          error_code: "no_key",
          error_detail: null,
          bundle: null,
          route_id: null,
          need_choice: null,
          broken_constraint: null,
          conflict_decision: null,
          contract_version: 2,
          motivation_report: null,
        };
      }
      const nSteps = Math.max(3, Math.min(10, args.steps));
      // Normalize request pins (card fields optional on the wire) into
      // the internal candidate shape.
      const normPin = (
        p: z.infer<typeof pinnedEntitySchema> | undefined,
      ): PinnedEnt | null =>
        p
          ? {
              id: p.id,
              name: p.name,
              type: p.type,
              desc: p.desc ?? null,
              year: p.year ?? null,
              byline: p.byline ?? null,
              image: p.image ?? null,
              pack: p.pack ?? false,
              label: p.label ?? null,
              flavor: p.flavor ?? null,
              members: p.members
                ? p.members.map((m) => ({
                    id: m.id,
                    name: m.name,
                    type: m.type,
                    year: m.year ?? null,
                    ...(m.manual ? { manual: true } : {}),
                  }))
                : null,
            }
          : null;
      const destPin = normPin(args.destPinned);
      try {
        // Resolve the destination first, then the seeds in order; the
        // first field whose search hits all fail the name check comes
        // back as a disambiguation question instead of a silent snap.
        const destRes = await resolveOne(
          destination,
          destPin,
          "destination",
          null,
          apiKey,
        );
        if (!destRes.ok) {
          return {
            ok: false,
            error: null,
            error_code: "need_choice",
            error_detail: null,
            bundle: null,
            route_id: null,
            need_choice: destRes.choice,
            broken_constraint: null,
            conflict_decision: null,
            contract_version: 2,
            motivation_report: null,
          };
        }
        const seedEnts: EntBrief[] = [];
        const auditNotes: string[] = [];
        const seedPacks: PackInfo[] = [];
        // Destination pack: validate members before building. Invalid
        // members are dropped (and named in provenance); a pack left
        // with a single member degrades to a plain single pin.
        let destPack: { info: PackInfo; memberEnts: EntBrief[] } | null = null;
        let destSingle: EntBrief | null = null;
        if (destRes.pack) {
          const { kept, dropped } = await validatePackMembers(destRes.ents, apiKey);
          for (const d of dropped) {
            auditNotes.push(`系列包成员 ${d.name} 未能通过 Qloo 校验，已剔除`);
          }
          if (kept.length === 0) {
            throw new RouteBrokenError(
              1,
              "shell",
              packDestTitle(destRes.pack.label, destRes.pack.flavor),
              null,
            );
          }
          if (kept.length === 1) {
            const only = kept[0];
            if (only) {
              auditNotes.push(
                `系列包「${destRes.pack.label}」成员只剩 1 个，已退化为单部《${only.name}》钉选`,
              );
              destSingle = only;
            }
          } else {
            const manualIds = new Set(
              destRes.pack.members.filter((m) => m.manual).map((m) => m.id),
            );
            destPack = {
              info: {
                label: destRes.pack.label,
                flavor: destRes.pack.flavor ?? "all",
                members: kept.map((m) => ({
                  id: m.id,
                  name: m.name,
                  type: normEntType(m.type),
                  year: m.year,
                  ...(manualIds.has(m.id) ? { manual: true } : {}),
                })),
              },
              memberEnts: kept,
            };
          }
        }
        for (let i = 0; i < seeds.length; i++) {
          const seedName = seeds[i];
          if (!seedName) continue;
          const res = await resolveOne(
            seedName,
            normPin(args.seedPinned?.[String(i)]),
            "seed",
            i,
            apiKey,
          );
          if (!res.ok) {
            return {
              ok: false,
              error: null,
              error_code: "need_choice",
              error_detail: null,
              bundle: null,
              route_id: null,
              need_choice: res.choice,
              broken_constraint: null,
              conflict_decision: null,
              contract_version: 2,
              motivation_report: null,
            };
          }
          if (res.pack) {
            // Seed pack: validate members, drop the invalid ones
            // (named in provenance), degrade to a single pin at 1.
            const { kept, dropped } = await validatePackMembers(res.ents, apiKey);
            for (const d of dropped) {
              auditNotes.push(`系列包成员 ${d.name} 未能通过 Qloo 校验，已剔除`);
            }
            if (kept.length === 0) {
              return {
                ok: false,
                error: `种子系列包「${res.pack.label}」的成员全部未能通过 Qloo 校验，这条路修不通。换个种子再试。`,
                error_code: "broken",
                error_detail: null,
                bundle: null,
                route_id: null,
                need_choice: null,
                broken_constraint: null,
                conflict_decision: null,
                contract_version: 2,
                motivation_report: null,
              };
            }
            if (kept.length === 1) {
              const only = kept[0];
              if (only) {
                auditNotes.push(
                  `系列包「${res.pack.label}」成员只剩 1 个，已退化为单部《${only.name}》钉选`,
                );
                seedEnts.push(only);
              }
            } else {
              seedEnts.push(...kept);
              const manualIds = new Set(
                res.pack.members.filter((m) => m.manual).map((m) => m.id),
              );
              seedPacks.push({
                label: res.pack.label,
                flavor: res.pack.flavor ?? "all",
                members: kept.map((m) => ({
                  id: m.id,
                  name: m.name,
                  type: normEntType(m.type),
                  year: m.year,
                  ...(manualIds.has(m.id) ? { manual: true } : {}),
                })),
              });
            }
            continue;
          }
          const seedEnt = res.ents[0];
          if (seedEnt) {
            seedEnts.push(seedEnt);
            if (res.via) {
              auditNotes.push(
                `种子「${res.via.query}」按 "${res.via.translation}" 解析为《${seedEnt.name}》`,
              );
            }
          }
        }
        // Destination: try the passing hits in search order. A hit can
        // pass the name check yet be a taste-graph dead end — e.g. the
        // first hit for "tarot cards" is a shovelware videogame whose
        // entire neighborhood has zero measurable affinity to any seed
        // (verified live 2026-10-18: all 50 neighbors scored empty), so
        // its first hop can never qualify. When the first hop breaks for
        // such a hit, fall through to the next passing hit instead of
        // reporting a dead route; a pinned destination is the user's
        // explicit choice and never falls through.
        let bundle: Record<string, unknown> | null = null;
        let lastBroken: RouteBrokenError | null = null;
        let usedDest: EntBrief | null = null;
        // A-item: parse barrier/motivation into constraints here (the
        // single source of truth — the client's chips come from the
        // same parser via parseConstraints), then keep only the ones
        // the user left active.
        const parsedConstraints = parseConstraints(
          (args.barrier ?? "").trim(),
          (args.motivation ?? "").trim(),
        );
        // Selection precedence (batch 3): when selectedMotivationIds
        // is explicitly present (empty array included), IT decides
        // whether source=motivation prefer_* constraints live —
        // constraintIds then only governs barrier constraints and
        // deletions among the selected ones, and any contradiction
        // resolves in selectedMotivationIds' favour.
        const chipFiltered = args.constraintIds
          ? parsedConstraints.filter(
              (c) =>
                (isMotivationPref(c) &&
                  args.selectedMotivationIds !== undefined) ||
                args.constraintIds?.includes(c.id),
            )
          : parsedConstraints;
        const selectionFiltered = filterMotivationPrefsBySelection(
          chipFiltered,
          args.selectedMotivationIds,
        );
        // Contract v2: merge manual constraints over the parsed set,
        // vet manual tags against Qloo's tag endpoint, resolve
        // same-tag avoid/prefer conflicts, and run the destination
        // conflict check — all before routing starts.
        const extraReportEntries: ConstraintReportEntry[] = [];
        let merged = mergeManualConstraints(
          selectionFiltered,
          (args.manualConstraints ?? []).map((m) => ({
            entryId: m.entryId,
            kind: m.kind,
            tagId: m.tagId,
            label: m.label,
          })),
        );
        // Tag vetting + same-tag avoid/prefer conflict resolution.
        {
          const vetted = await vetManualTagConstraints(merged, apiKey);
          merged = vetted.kept;
          extraReportEntries.push(...vetted.extras);
        }
        // Destination conflict: a topic-class avoid that collides
        // with the pinned destination's own horror tags takes effect
        // ONLY when the user confirmed it（仍要避开）; a user decision
        // to disable it is archived as no_effect with the decision
        // stated; and with NEITHER decision on record the build
        // refuses — need_conflict_decision — instead of silently
        // dropping the constraint and building anyway. The request
        // must be able to tell "user agreed to disable" apart from
        // "user never saw the conflict".
        {
          const topicAvoids = merged.filter((c) => c.kind === "avoid_horror");
          if (topicAvoids.length > 0) {
            const destIds = destPack
              ? destPack.memberEnts.map((m) => m.id)
              : destSingle
                ? [destSingle.id]
                : destRes.ents.slice(0, 1).map((e) => e.id);
            let evidence: string | null = null;
            for (const id of destIds) {
              evidence = await destinationHorrorEvidence(id, apiKey, (destPack?.memberEnts ?? destRes.ents).find(e=>e.id===id));
              if (evidence) break;
            }
            if (evidence) {
              const kept: RouteConstraint[] = [];
              for (const c of merged) {
                if (c.kind !== "avoid_horror") {
                  kept.push(c);
                  continue;
                }
                if (args.confirmedConflictIds?.includes(c.id)) {
                  kept.push({
                    ...c,
                    conflict: { status: "active" as const, evidence },
                  });
                } else if (args.disabledConflictIds?.includes(c.id)) {
                  extraReportEntries.push({
                    id: c.id,
                    label: c.label,
                    excerpt: c.excerpt,
                    source: c.source,
                    status: "no_effect",
                    detail: `你的目的地本身就带恐怖题材标签（${evidence}），和这条正好冲突；你已决定停用这条，所以它没有生效。`,
                  });
                } else {
                  return {
                    ok: false,
                    error: `目的地本身就带恐怖题材标签（${evidence}），和你这条「${c.label}」冲突——先决定这条要启用还是停用，再来修路。`,
                    error_code: "need_conflict_decision",
                    error_detail: null,
                    bundle: null,
                    route_id: null,
                    need_choice: null,
                    broken_constraint: null,
                    conflict_decision: {
                      id: c.id,
                      label: c.label,
                      excerpt: c.excerpt,
                      evidence,
                    },
                    contract_version: 2,
                    motivation_report: null,
                  };
                }
              }
              merged = kept;
            }
          }
        }
        const activeConstraints = merged;
        // Motivation signals that enter routing: manual signals
        // (tag-verified, highest priority), then the parse signals
        // the user selected. Unselected signals never enter routing
        // and never appear in the report.
        const activeMotSignals: ActiveMotSignal[] = [];
        const motReportExtras: MotivationReportEntry[] = [];
        for (const ms of args.manualMotivationSignals ?? []) {
          const okTag = await verifyTagExists(ms.tagId, apiKey);
          if (!okTag) {
            motReportExtras.push({
              signal_id: `mot:manual:${ms.tagId}`,
              label: ms.label,
              status: "unhandled",
              detail: "标签无法验证，未生效",
            });
            continue;
          }
          activeMotSignals.push({
            signalId: `mot:manual:${ms.tagId}`,
            label: ms.label,
            tagId: ms.tagId,
            priority: 0,
            source: "manual",
          });
        }
        if (
          args.selectedMotivationIds &&
          args.selectedMotivationIds.length > 0
        ) {
          const { signals: parsedSignals, genericPending } =
            parseMotivationSignals(
              (args.motivation ?? "").trim(),
              parsedConstraints,
            );
          const resolvedSignals = [...parsedSignals];
          if (genericPending) {
            // Pending candidate signals come from the destination's
            // quotable taste tags (same pool the parse action used).
            const destIdForSignals = destPack
              ? destPack.memberEnts[0]?.id
              : destSingle
                ? destSingle.id
                : destRes.ents[0]?.id;
            if (destIdForSignals) {
              try {
                const profile = await tagProfile(
                  [destIdForSignals],
                  apiKey,
                  "motivation_tags",
                );
                const top = quotableTags(profile)
                  .sort((a, b) => b.affinity - a.affinity)
                  .slice(0, 3);
                for (const t of top) {
                  resolvedSignals.push({
                    id: `mot:dest:${t.id.split(":").pop() ?? "tag"}`,
                    label: t.name,
                    source: "destination_tags",
                    tagId: t.id,
                    status: "pending",
                    excerpt: (args.motivation ?? "").trim().slice(0, 24),
                  });
                }
              } catch (e) {
                if (isQlooTypedError(e)) throw e;
              }
            }
          }
          for (const id of args.selectedMotivationIds) {
            const sig = resolvedSignals.find((s) => s.id === id);
            // The pending placeholder (tagId null, source
            // pending_supplement) can never enter routing.
            if (!sig || !sig.tagId || sig.source === "pending_supplement") continue;
            if (activeMotSignals.some((s) => s.tagId === sig.tagId)) continue;
            activeMotSignals.push({
              signalId: sig.id,
              label: sig.label,
              tagId: sig.tagId,
              priority: 1,
              source: sig.source,
            });
          }
        }
        const pendingConcept=parseMotivationSignals((args.motivation??'').trim(),parsedConstraints).genericPending;
        if(pendingConcept&&activeMotSignals.length===0){
         if(args.requireMotivationDecision&&!args.motivationDeferred){
          return {ok:false,error:'吸引你的具体概念还没说清；补充一句，或明确选择这次先不用于选路。',error_code:'motivation_needs_detail',error_detail:null,bundle:null,route_id:null,need_choice:null,broken_constraint:null,conflict_decision:null,contract_version:2,motivation_report:null};
         }
         motReportExtras.push({signal_id:'mot:pending:generic',label:'想看的设定还没说具体',status:'unhandled',detail:args.motivationDeferred?'你明确选择本次先保留原话，不用于选路。':'没有得到具体可测的吸引点，未用于选路。'});
        }
        const buildOpts: BuildOpts = {
          destPack,
          seedPacks,
          constraints: activeConstraints,
          motivationSignals: activeMotSignals,
          extraReportEntries,
          // One shared measured-data cache for the whole build call:
          // fall-through attempts and the why stage reuse the
          // profiles/relatives the first attempt already measured.
          sharedCache: newSharedQlooCache(),
        };
        if (destPack) {
          // Pack destination: one attempt, anchored on the union of
          // the validated members; never falls through to a single.
          const firstMember = destPack.memberEnts[0];
          if (!firstMember) throw new Error("建路线失败");
          bundle = await buildRouteBundle(
            seedEnts,
            firstMember,
            nSteps,
            apiKey,
            (args.barrier ?? "").trim(),
            (args.motivation ?? "").trim(),
            buildOpts,
          );
          usedDest = firstMember;
        } else {
          const destAttempts = destSingle
            ? [destSingle]
            : args.destPinned
              ? destRes.ents.slice(0, 1)
              : destRes.ents.slice(0, 4);
          for (const destEnt of destAttempts) {
            try {
              bundle = await buildRouteBundle(
                seedEnts,
                destEnt,
                nSteps,
                apiKey,
                (args.barrier ?? "").trim(),
                (args.motivation ?? "").trim(),
                buildOpts,
              );
              usedDest = destEnt;
              break;
            } catch (e) {
              // A constraint-caused break is NOT a dead-end destination:
              // falling through to another hit would silently drop the
              // user's constraint, so it propagates immediately.
              if (
                e instanceof RouteBrokenError &&
                e.hop === 1 &&
                e.kind !== "entry_series" && e.kind !== "series_order" &&
                !args.destPinned &&
                !e.constraint
              ) {
                lastBroken = e;
                continue;
              }
              throw e;
            }
          }
        }
        if (!bundle) {
          throw lastBroken ?? new Error("建路线失败");
        }
        // Audit trail: when a name reached the catalog through the
        // translation path, record it on the route's provenance line.
        if (destRes.via && usedDest) {
          auditNotes.unshift(
            `目的地「${destRes.via.query}」按 "${destRes.via.translation}" 解析为《${usedDest.name}》`,
          );
        }
        if (auditNotes.length > 0) {
          const meta = asObj(bundle.meta);
          const prov = asStr(meta.provenance);
          meta.provenance = [prov, ...auditNotes.map((n) => `${n}。`)]
            .filter(Boolean)
            .join(" ");
          bundle.meta = meta;
        }
        // Motivation report, final assembly: the router's own tag
        // signal receipts (in the bundle meta) + the selected pref_*
        // signals, whose facts are the SAME facts the constraint
        // report already booked (counted once, viewed from the signal
        // side — never a second swap) + unverifiable manual signals.
        const finalMotReport: MotivationReportEntry[] = [];
        {
          const meta = asObj(bundle.meta);
          const fromBundle = meta.motivation_report;
          if (Array.isArray(fromBundle)) {
            for (const r of fromBundle) {
              const o = asObj(r);
              const st = asStr(o.status);
              if (
                st === "applied_changed" ||
                st === "applied_no_change" ||
                st === "unhandled"
              ) {
                finalMotReport.push({
                  signal_id: asStr(o.signal_id),
                  label: asStr(o.label),
                  status: st,
                  detail: asStr(o.detail),
                });
              }
            }
          }
          const reportRaw = meta.constraint_report;
          const reportEntries: ConstraintReportEntry[] = Array.isArray(reportRaw)
            ? (reportRaw as ConstraintReportEntry[])
            : [];
          for (const id of args.selectedMotivationIds ?? []) {
            if (!id.startsWith("mot:pref_")) continue;
            const kind = `prefer_${id.slice("mot:pref_".length)}`;
            const c = activeConstraints.find((x) => x.kind === kind);
            if (!c) continue;
            const entry = reportEntries.find((e) => e.id === c.id);
            if (!entry) continue;
            finalMotReport.push({
              signal_id: id,
              label: c.label,
              status:
                entry.status === "applied" &&
                entry.detail.includes("换了")
                  ? "applied_changed"
                  : entry.status === "unhandled"
                    ? "unhandled"
                    : "applied_no_change",
              detail: entry.detail,
            });
          }
          // Cancelled motivation preferences: when the user
          // explicitly deselected a pref signal (selectedMotivationIds
          // present, id absent), the report carries exactly one
          // non-applied receipt for it — the cancellation is a fact
          // of this route, and the signal must not be mistaken for
          // one that took effect.
          if (args.selectedMotivationIds !== undefined) {
            for (const c of parsedConstraints) {
              if (!isMotivationPref(c)) continue;
              const sid = MOT_PREF_SIGNAL_ID[c.kind] ?? "";
              if (!sid || args.selectedMotivationIds.includes(sid)) continue;
              if (activeConstraints.some((x) => x.id === c.id)) continue;
              finalMotReport.push({
                signal_id: sid,
                label: c.label,
                status: "unhandled",
                detail: "这条动机偏好已被你取消，本轮没有生效，也没有影响选路顺序。",
              });
            }
          }
          finalMotReport.push(...motReportExtras);
          meta.motivation_report =
            finalMotReport.length > 0 ? finalMotReport : null;
          // Archive the explicit selection state so a later reroute
          // replays THIS state — a cancelled preference never revives.
          meta.selected_motivation_ids = args.selectedMotivationIds ?? null;
          meta.motivation_deferred = args.motivationDeferred === true;
          bundle.meta = meta;
        }
        return {
          ok: true,
          error: null,
          error_code: null,
          error_detail: null,
          bundle: JSON.stringify(bundle),
          route_id: typeof bundle.route_id === "string" ? bundle.route_id : null,
          need_choice: null,
          broken_constraint: null,
          conflict_decision: null,
          contract_version: 2,
          motivation_report:
            finalMotReport.length > 0 ? finalMotReport : null,
        };
      } catch (e) {
        if (e instanceof QlooRateLimitError || e instanceof QlooUpstreamError) {
          return {
            ok: false,
            error: qlooFailureMessage(qlooFailureCode(e)),
            error_code: qlooFailureCode(e),
            error_detail: upstreamDetailFor(e),
            bundle: null,
            route_id: null,
            need_choice: null,
            broken_constraint: null,
            conflict_decision: null,
            contract_version: 2,
            motivation_report: null,
          };
        }
        if (e instanceof QlooAuthError) {
          return {
            ok: false,
            error: "密钥不对或已失效，请检查后重新保存",
            error_code: "auth",
            error_detail: null,
            bundle: null,
            route_id: null,
            need_choice: null,
            broken_constraint: null,
            conflict_decision: null,
            contract_version: 2,
            motivation_report: null,
          };
        }
        if (e instanceof RouteBrokenError) {
          if (e.constraint) {
            return {
              ok: false,
              error: `本次查到的候选中，按你『${e.constraint.label}』（原文「${e.constraint.excerpt}」）过滤后，第 ${e.hop} 跳没有留下达到关联门槛的条目。尚未找到符合条件的路线；目标和回避条件会保留，不代表整个图谱无路。`,
              error_code: "constraint_broken",
              error_detail: null,
              bundle: null,
              route_id: null,
              need_choice: null,
              broken_constraint: e.constraint,
              conflict_decision: null,
              contract_version: 2,
              motivation_report: null,
            };
          }
          return {
            ok: false,
            error:
              e.kind === "series_order"
                ? `本次查到的候选中，排除续作早于前作的倒序组合后，第 ${e.hop} 跳没有留下可用的桥梁。尚未找到符合条件的路线；可以减少站数或调整已有喜欢后再试。`
                : e.kind === "entry_series"
                ? `本次查到的候选排除《${e.destName}》本体、同系列及相关导读后，第 ${e.hop} 跳没有留下可用的入门桥梁，尚未找到符合条件的路线。可以减少站数或调整已有喜欢后再试。`
                : e.kind === "shell"
                ? `修不通：终点《${e.destName}》在图谱里是个空壳——搜得到，但没有真实的品味连接。这不是你的说法问题，换个具体的作品当终点试试。`
                : e.maxHop != null
                  ? `这条路修不通：第 ${e.hop} 跳最接近的落点亲和只有 ${fmtAff(e.maxHop)}，不够近。目的地或种子换一个再试。`
                  : `这条路修不通：第 ${e.hop} 跳的候选都测不到与你口味的亲和，确认不了哪一步够近。目的地或种子换一个再试。`,
            error_code: "broken",
            error_detail: null,
            bundle: null,
            route_id: null,
            need_choice: null,
            broken_constraint: null,
            conflict_decision: null,
            contract_version: 2,
            motivation_report: null,
          };
        }
        return {
          ok: false,
          error: e instanceof Error ? e.message : "建路线失败",
          error_code: "router",
          error_detail: null,
          bundle: null,
          route_id: null,
          need_choice: null,
          broken_constraint: null,
          conflict_decision: null,
          contract_version: 2,
          motivation_report: null,
        };
      }
    },
  }),

  // --- score-driven rerouting ----------------------------------------------

  /** Rebuild the tail of a walking session from a cliff step (0-based
   * `cliff_index`, rated 好感 `like_score` ≤2). The steps before the
   * cliff are a fixed prefix; the cliff entity is excluded; the
   * prefix's last step joins the seeds as an extra anchor; router v2
   * rebuilds exactly the remaining step count to the unchanged
   * destination. Returns the full spliced bundle for the client to
   * apply to its session state. On honest failure the session is left
   * untouched and only a plain-language error comes back. */
  rerouteFromStep: defineAction({
    request: z.object({
      session_id: z.number().int().positive(),
      cliff_index: z.number().int().min(0).max(20),
      like_score: z.number().int().min(1).max(5),
    }),
    response: rerouteResponse,
    handler: async (ctx, args): Promise<z.infer<typeof rerouteResponse>> => {
      const fail = (error: string): z.infer<typeof rerouteResponse> => ({
        ok: false,
        error,
        error_code: null,
        error_detail: null,
        bundle: null,
        log_line: null,
        contract_version: 2,
      });
      const failUpstream = (
        e: QlooRateLimitError | QlooUpstreamError,
      ): z.infer<typeof rerouteResponse> => ({
        ok: false,
        error: qlooFailureMessage(qlooFailureCode(e)),
        error_code: qlooFailureCode(e),
        error_detail: upstreamDetailFor(e),
        bundle: null,
        log_line: null,
        contract_version: 2,
      });
      const REROUTE_FAR =
        "这条路绕不开它，先按原路走，或试试给这一步换步。";
      const apiKey = await getStoredQlooKey(ctx);
      if (!apiKey) return fail("请在站点设置配置 QLOO_API_KEY，再重修。");
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, args.session_id),sessionScope(ctx)))
        .limit(1);
      const row = rows[0];
      if (!row) return fail("找不到这次行走的记录，没法重修。");
      let sessionRaw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.data);
        if (parsed == null || typeof parsed !== "object") {
          return fail("这次行走的记录读不出来，没法重修。");
        }
        sessionRaw = parsed as Record<string, unknown>;
      } catch {
        return fail("这次行走的记录读不出来，没法重修。");
      }
      const routeDataStr = await resolveRouteData(ctx, row.data);
      if (!routeDataStr) return fail("这条路线的记录读不出来，没法重修。");
      let bundleRaw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(routeDataStr);
        if (parsed == null || typeof parsed !== "object") {
          return fail("这条路线的记录读不出来，没法重修。");
        }
        bundleRaw = parsed as Record<string, unknown>;
      } catch {
        return fail("这条路线的记录读不出来，没法重修。");
      }
      const bundleSteps = bundleRaw.steps;
      if (!Array.isArray(bundleSteps) || bundleSteps.length === 0) {
        return fail("这条路线的记录读不出来，没法重修。");
      }
      const cliffIndex = args.cliff_index;
      if (cliffIndex >= bundleSteps.length) {
        return fail("这一步不在这条路上，没法重修。");
      }
      const totalSteps = bundleSteps.length;
      const remaining = totalSteps - cliffIndex;
      const sessionSteps = Array.isArray(sessionRaw.steps)
        ? sessionRaw.steps
        : [];
      const cliffRef = effectiveStoredStep(
        bundleSteps[cliffIndex],
        sessionSteps[cliffIndex],
      );
      if (!cliffRef) return fail("这一步的记录读不出来，没法重修。");
      const meta = asObj(bundleRaw.meta);
      // Destination: the bundle's final step / destination_entity_id.
      const lastStepRef = storedEntRef(bundleSteps[bundleSteps.length - 1]);
      const destId =
        asStr(meta.destination_entity_id) || (lastStepRef?.id ?? "");
      if (!destId || !lastStepRef) {
        return fail("这条路线的终点读不出来，没法重修。");
      }
      // The cliff IS the destination: avoiding it would move the
      // destination, which a reroute never does.
      if (cliffRef.id === destId) {
        return fail(
          "这一步就是终点本身，绕开它就等于换目的地了。先按原路走，或试试给前面几步换步。",
        );
      }
      // Fixed prefix: effective entities before the cliff.
      const prefixRefs: StoredEntRef[] = [];
      for (let i = 0; i < cliffIndex; i++) {
        const ref = effectiveStoredStep(bundleSteps[i], sessionSteps[i]);
        if (ref) prefixRefs.push(ref);
      }
      try {
        const seeds = await reconstructSeedEnts(meta, bundleSteps, apiKey);
        if (seeds.length === 0) {
          return fail("这条路线的种子读不出来，没法重修。");
        }
        const seedEnts: EntBrief[] = [...seeds];
        const anchorRef = prefixRefs[prefixRefs.length - 1];
        if (anchorRef && !seedEnts.some((s) => s.id === anchorRef.id)) {
          seedEnts.push(await briefForStored(anchorRef, apiKey));
        }
        // Destination (pack or single) reconstructed from stored meta.
        let destPack: { info: PackInfo; memberEnts: EntBrief[] } | null =
          null;
        let destEnt: EntBrief;
        const packRaw = meta.destination_pack;
        if (packRaw != null && typeof packRaw === "object") {
          const po = asObj(packRaw);
          const membersRaw = po.members;
          const memberRefs: StoredEntRef[] = [];
          if (Array.isArray(membersRaw)) {
            for (const m of membersRaw) {
              const ref = storedEntRef(m);
              if (ref) memberRefs.push(ref);
            }
          }
          if (memberRefs.length >= 2) {
            const memberEnts: EntBrief[] = [];
            for (const ref of memberRefs) {
              memberEnts.push(await briefForStored(ref, apiKey));
            }
            const manualIds = new Set(
              (Array.isArray(membersRaw) ? membersRaw : [])
                .filter((m) => asObj(m).manual === true)
                .map((m) => storedEntRef(m)?.id ?? ""),
            );
            destPack = {
              info: {
                label: asStr(po.label),
                flavor: asStr(po.flavor) || "all",
                members: memberEnts.map((m) => ({
                  id: m.id,
                  name: m.name,
                  type: normEntType(m.type),
                  year: m.year,
                  ...(manualIds.has(m.id) ? { manual: true } : {}),
                })),
              },
              memberEnts,
            };
            const firstMember = memberEnts[0];
            if (!firstMember) return fail(REROUTE_FAR);
            destEnt = firstMember;
          } else {
            destEnt = await briefForStored(lastStepRef, apiKey);
          }
        } else {
          destEnt = await briefForStored(lastStepRef, apiKey);
        }
        const excludeIds = [
          cliffRef.id,
          ...prefixRefs.map((r) => r.id),
        ];
        const rerouteBarrier =
          typeof sessionRaw.barrier === "string"
            ? sessionRaw.barrier
            : asStr(meta.barrier);
        const rerouteMotivation =
          typeof sessionRaw.motivation === "string"
            ? sessionRaw.motivation
            : asStr(meta.motivation);
        const rebuilt = await buildRouteBundle(
          seedEnts,
          destEnt,
          remaining,
          apiKey,
          rerouteBarrier,
          rerouteMotivation,
          {
            destPack,
            seedPacks: storedSeedPacks(meta),
            excludeIds,
            fixedPrefix:bundleSteps.slice(0,cliffIndex).map((step,i)=>effectiveEntryWork(step,sessionSteps[i])),
            // The tail obeys the constraints the route was built with
            // (stored on the meta, chips the user removed stay
            // removed); routes predating constraints re-parse. The
            // archived selectedMotivationIds state replays too: a
            // motivation preference cancelled at build time is
            // filtered out again here and never revives on a reroute.
            constraints: filterMotivationPrefsBySelection(
              storedConstraints(meta) ??
                parseConstraints(rerouteBarrier, rerouteMotivation),
              Array.isArray(meta.selected_motivation_ids)
                ? (meta.selected_motivation_ids as unknown[]).filter(
                    (x): x is string => typeof x === "string",
                  )
                : undefined,
            ),
            // Same for the motivation tag signals that entered the
            // original build (manual entries included).
            motivationSignals: storedMotivationSignals(meta),
          },
        );
        const newStepsRaw = rebuilt.steps;
        if (!Array.isArray(newStepsRaw) || newStepsRaw.length !== remaining) {
          return fail(REROUTE_FAR);
        }
        // Defence in depth: the excluded cliff entity must not be in
        // the new tail, and (single destination) the tail must still
        // end at the original destination.
        const newSteps: Record<string, unknown>[] = [];
        for (const raw of newStepsRaw) {
          const so = asObj(raw);
          if (asStr(so.entity_id) === cliffRef.id) return fail(REROUTE_FAR);
          newSteps.push(so);
        }
        if (!destPack) {
          const tailLast = newSteps[newSteps.length - 1];
          if (!tailLast || asStr(tailLast.entity_id) !== destId) {
            return fail(REROUTE_FAR);
          }
        }
        // Reroute sequence number for this session (client state is
        // authoritative going forward; the stored row seeds the count).
        const prevCount =
          typeof sessionRaw.rerouteCount === "number"
            ? sessionRaw.rerouteCount
            : Array.isArray(sessionRaw.rerouteLog)
              ? sessionRaw.rerouteLog.length
              : 0;
        const seq = prevCount + 1;
        const logLine = `第 ${cliffIndex + 1} 步好感 ${args.like_score} 分，触发第 ${seq} 次重修`;
        const renumbered = newSteps.map((so, j) => ({
          ...so,
          n: cliffIndex + j + 1,
          ...(j === 0 ? { rerouted: true } : {}),
        }));
        const splicedSteps = [
          ...bundleSteps.slice(0, cliffIndex),
          ...renumbered,
        ];
        const edgeScores: Record<string, { aff_from_seeds: number | null }> =
          {};
        for (const raw of splicedSteps) {
          const so = asObj(raw);
          const eid = asStr(so.entity_id);
          if (!eid) continue;
          const aff = so.aff_from_seeds;
          edgeScores[eid] = {
            aff_from_seeds: typeof aff === "number" ? aff : null,
          };
        }
        const provenance = asStr(meta.provenance);
        const {link_validation:_oldValidation,forward_links:_oldForward,destination_candidate_checks:_oldChecks,...retainedMeta}=meta;
        const finalBundle: Record<string, unknown> = {
          ...bundleRaw,
          steps: splicedSteps,
          edge_scores: edgeScores,
          meta: {
            ...retainedMeta,
            entry_policy: asObj(rebuilt.meta).entry_policy,
            destination_content_policy: asObj(rebuilt.meta).destination_content_policy,
            entry_exclusions: asObj(rebuilt.meta).entry_exclusions,
            series_order_policy: asObj(rebuilt.meta).series_order_policy,
            series_order_exclusions: asObj(rebuilt.meta).series_order_exclusions,
            ...rerouteQueryCoverage(meta,asObj(rebuilt.meta),bundleSteps.length,cliffIndex),
            ...rerouteMotivationMeta(meta,asObj(rebuilt.meta),cliffIndex,seq),
            routing_method: "destination_backtracking",
            reverse_links: [...(Array.isArray(meta.reverse_links)?meta.reverse_links:[]),...(Array.isArray(asObj(rebuilt.meta).reverse_links)?asObj(rebuilt.meta).reverse_links as unknown[]:[])],
            explanation_status: explanationStatusFor(splicedSteps),
            provenance: [provenance, `${logLine}。`]
              .filter(Boolean)
              .join(" "),
          },
        };
        return {
          ok: true,
          error: null,
          error_code: null,
          error_detail: null,
          bundle: JSON.stringify(finalBundle),
          log_line: logLine,
          contract_version: 2,
        };
      } catch (e) {
        if (e instanceof QlooRateLimitError || e instanceof QlooUpstreamError) {
          return failUpstream(e);
        }
        if (e instanceof QlooAuthError) {
          return fail("密钥不对或已失效，请检查后重新保存。");
        }
        if (e instanceof RouteBrokenError) {
          return fail(e.kind === "series_order"
            ? "排除续作早于前作的倒序组合后，本次候选不足以重修剩余路线；已走过的站点和原路线保留。"
            : e.kind === "entry_series"
            ? "排除终点本体、同系列及相关导读后，本次候选不足以重修剩余路线；原路线保留。"
            : REROUTE_FAR);
        }
        return fail(REROUTE_FAR);
      }
    },
  }),

  // --- measured step swap -------------------------------------------------
  //
  // Swapping a step used to be a client-side instant swap onto a cached
  // alternate whose link BACK to the previous station had never been
  // measured, and the swapped step carried no `why`. This action does
  // the swap on the server and measures both missing pieces first:
  //   1. Edge — a per-candidate oracle call (filter.results.entities)
  //      with the previous station's effective entity as the signal
  //      (for step 1 there is no previous station, so the seed set is
  //      the signal — the same convention as the first hop at build
  //      time). The result is written into the step's edge_note in the
  //      same format a built step carries; when Qloo returns no
  //      reading the note says so in words (「与上一站的连接：Qloo
  //      未测得」) instead of leaving the field blank or inventing a
  //      number. A measured affinity below the router's relaxed floor
  //      (0.72) is also recorded (prev_link_aff) so the client can show
  //      the weak-link note — it never blocks the swap.
  //   2. Why — the exact build-time pipeline (attachWhys: seed
  //      attribution + real shared / kin tags) run for just this step,
  //      stored on the step so it renders like any built step.
  // The action never writes the session: it returns the finished step
  // and the client applies it through the normal saveSession path. On
  // any measurement failure (network / Qloo error) it returns only a
  // plain-language error and the walker's step stays untouched.
  swapStepMeasured: defineAction({
    request: z.object({
      session_id: z.number().int().positive(),
      step_index: z.number().int().min(0).max(30),
      alt_entity_id: z.string().min(1).max(200),
    }),
    response: swapStepResponse,
    handler: async (ctx, args): Promise<z.infer<typeof swapStepResponse>> => {
      const fail = (error: string): z.infer<typeof swapStepResponse> => ({
        ok: false,
        error,
        error_code: null,
        error_detail: null,
        step: null,
      });
      const failUpstream = (
        e: QlooRateLimitError | QlooUpstreamError,
      ): z.infer<typeof swapStepResponse> => ({
        ok: false,
        error: qlooFailureMessage(qlooFailureCode(e)),
        error_code: qlooFailureCode(e),
        error_detail: upstreamDetailFor(e),
        step: null,
      });
      const apiKey = await getStoredQlooKey(ctx);
      if (!apiKey) return fail("请在站点设置配置 QLOO_API_KEY，再换步。");
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, args.session_id),sessionScope(ctx)))
        .limit(1);
      const row = rows[0];
      if (!row) return fail("找不到这次行走的记录，没法换步。");
      let sessionRaw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.data);
        if (parsed == null || typeof parsed !== "object") {
          return fail("这次行走的记录读不出来，没法换步。");
        }
        sessionRaw = parsed as Record<string, unknown>;
      } catch {
        return fail("这次行走的记录读不出来，没法换步。");
      }
      const routeDataStr = await resolveRouteData(ctx, row.data);
      if (!routeDataStr) return fail("这条路线的记录读不出来，没法换步。");
      let bundleRaw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(routeDataStr);
        if (parsed == null || typeof parsed !== "object") {
          return fail("这条路线的记录读不出来，没法换步。");
        }
        bundleRaw = parsed as Record<string, unknown>;
      } catch {
        return fail("这条路线的记录读不出来，没法换步。");
      }
      const bundleSteps = bundleRaw.steps;
      if (!Array.isArray(bundleSteps) || bundleSteps.length === 0) {
        return fail("这条路线的记录读不出来，没法换步。");
      }
      if (args.step_index >= bundleSteps.length) {
        return fail("这一步不在这条路上，没法换步。");
      }
      const bundleStep = asObj(bundleSteps[args.step_index]);
      const alternates = Array.isArray(bundleStep.alternates)
        ? bundleStep.alternates
        : [];
      const altRaw = alternates.find(
        (a) => asStr(asObj(a).entity_id) === args.alt_entity_id,
      );
      if (!altRaw) {
        return fail("这个备选不在这一步的备选里，没法换。");
      }
      const alt = asObj(altRaw);
      const altId = asStr(alt.entity_id);
      const altType = normEntType(asStr(alt.type)) || asStr(alt.type);
      const destinationStep = asObj(bundleSteps[bundleSteps.length - 1]);
      const seriesReason = entrySeriesReason(entryWorkOfStored(alt), entryWorkOfStored(destinationStep));
      if (seriesReason) return fail(`这个备选属于终点本体、同系列或相关配套内容，不适合作为入门桥梁：${seriesReason}。请重新生成路线，旧路线不会自动改写。`);
      // The previous station is the walker's EFFECTIVE entity there —
      // if that step was itself swapped, the link is measured against
      // what the walker actually visited.
      const sessionSteps = Array.isArray(sessionRaw.steps)
        ? sessionRaw.steps
        : [];
      const replacementOrder=bundleSteps.map((step,i)=>i===args.step_index?entryWorkOfStored(alt):effectiveEntryWork(step,sessionSteps[i]));
      const orderConflict=routeSeriesConflict(replacementOrder);
      if(orderConflict)return fail(`这个备选会造成系列倒序：${orderConflict.reason}。本次未换站，原进度保留。`);
      let prevRef: StoredEntRef | null = null;
      if (args.step_index > 0) {
        prevRef = effectiveStoredStep(
          bundleSteps[args.step_index - 1],
          sessionSteps[args.step_index - 1],
        );
        if (!prevRef) {
          return fail("上一站的记录读不出来，没法实测它和备选的连接。");
        }
      }
      try {
        const meta = asObj(bundleRaw.meta);
        const seeds = await reconstructSeedEnts(meta, bundleSteps, apiKey);
        // 1. Edge measurement: per-candidate oracle, previous station
        // (or, for step 1, the seed set) as the signal.
        let edgeNote: string;
        let edgeAff: number | null = null;
        if (prevRef) {
          const scores = await oracle(altType, [prevRef.id], [altId], apiKey);
          edgeAff = scores[altId] ?? null;
          edgeNote =
            edgeAff != null
              ? `从上一站《${prevRef.name}》→本步关联 ${fmtAff(edgeAff)}（Qloo正向实测）`
              : "与上一站的连接：Qloo 未测得";
        } else {
          if (seeds.length === 0) {
            return fail(
              "这条路线的种子读不出来，没法实测第一步和你口味的连接。",
            );
          }
          const scores = await oracle(
            altType,
            seeds.map((s) => s.id),
            [altId],
            apiKey,
          );
          edgeAff = scores[altId] ?? null;
          edgeNote =
            edgeAff != null
              ? `离家最近的一站：与你的口味亲和 ${fmtAff(edgeAff)}`
              : "离家最近的一站：与你的口味亲和 Qloo 未测得";
        }
        const nextRef=args.step_index+1<bundleSteps.length?effectiveStoredStep(bundleSteps[args.step_index+1],sessionSteps[args.step_index+1]):null;
        let reverseLink:ReverseLink|undefined;
        if(nextRef){
          const scores=await oracle(altType,[nextRef.id],[altId],apiKey,'swap_reverse');
          const affinity=scores[altId];
          if(affinity!=null)reverseLink={from_entity_id:nextRef.id,to_entity_id:altId,from_name:nextRef.name,to_name:asStr(alt.name),affinity,minimum:.72,signal_entity_ids:[nextRef.id],basis:'entity'};
          edgeNote=reverseLink?`以《${nextRef.name}》为信号找到《${asStr(alt.name)}》，关联 ${fmtAff(reverseLink.affinity)}（Qloo倒推实测）`:"本步的倒推关联暂未取得数值。";
        }
        // 2. Why: the build-time pipeline, run for this one step.
        let why: WhyObj | null = null;
        if (seeds.length > 0) {
          const holder: ExplainStep[] = [{entity_id:altId,type:altType,why:null,reverse_link:reverseLink,
            aff_from_seeds:prevRef?(typeof alt.aff_from_seeds==='number'?alt.aff_from_seeds:null):edgeAff}];
          await runExplanation(() => attachWhys(holder, seeds, apiKey));
          why = holder[0]?.why ?? null;
        } else {
          why = {
            // No seed records to attribute against: no measured
            // explanation facts exist, so no sentence is written.
            text: "",
            seed: null,
            seed_id: null,
            tags: [],
            via: null,
            cluster: null,
            pair: null,
            kin_affinity: null,
            explanation_status: "missing",
          };
        }
        if (seeds.length === 0) await runExplanation(async () => undefined);
        const stepObj = {
          n:
            typeof bundleStep.n === "number"
              ? bundleStep.n
              : args.step_index + 1,
          name: asStr(alt.name),
          type: asStr(alt.type),
          entity_id: altId,
          entrySeries: alt.entrySeries,
          image: asStr(alt.image),
          year: typeof alt.year === "number" ? alt.year : null,
          // For step 1 the seed-signal measurement IS the home
          // affinity; later steps keep the alternate's build-time home
          // affinity, which was itself measured when the route was
          // built.
          aff_from_seeds: prevRef
            ? typeof alt.aff_from_seeds === "number"
              ? alt.aff_from_seeds
              : null
            : edgeAff,
          bio: asStr(alt.bio),
          byline:asStr(alt.byline),
          edge_note: edgeNote,
          why,
          reverse_link: reverseLink,
          // Measured link back to the previous station (null aff =
          // Qloo returned no reading; the edge note says so). The
          // client shows the weak-link note when this is under the
          // router's relaxed floor 0.72; it never blocks the swap.
          prev_link_aff: prevRef ? edgeAff : null,
          prev_link_name: prevRef ? prevRef.name : null,
          tracks: Array.isArray(alt.tracks) ? alt.tracks : [],
        };
        return {
          ok: true,
          error: null,
          error_code: null,
          error_detail: null,
          step: JSON.stringify(stepObj),
        };
      } catch (e) {
        if (e instanceof QlooRateLimitError || e instanceof QlooUpstreamError) {
          return failUpstream(e);
        }
        if (e instanceof QlooAuthError) {
          return fail("密钥不对或已失效，请检查后重新保存——这一步没有换。");
        }
        return fail(
          "实测没跑通（网络或 Qloo 那边出了问题）——这一步没有换。稍后再试一次。",
        );
      }
    },
  }),

  // --- pack editor: manual member search + validity probe -----------------

  /** Search candidates for the pack editor's 「自己加一部」 box. Uses
   * the same /search pipeline as name resolution, scoped to the pack's
   * own range: a flavor pack only accepts its own content type; the
   * whole-series pack accepts the allowed entertainment types. No
   * name-containment gate — the whole point is that the user can add
   * works whose name does not contain the pack's label (e.g. The Dark
   * Knight into a batman pack). */
  searchPackCandidates: defineAction({
    request: z.object({
      query: z.string().min(1).max(200),
      // "all" (or absent) = whole-series pack scope; otherwise the
      // flavor's single content type.
      flavor: z.string().nullable().optional(),
    }),
    response: packSearchResponse,
    handler: async (ctx, args): Promise<z.infer<typeof packSearchResponse>> => {
      const apiKey = await getStoredQlooKey(ctx);
      if (!apiKey) {
        return { candidates: [], error: "请在站点设置配置 QLOO_API_KEY 服务端 Secret" };
      }
      const flavor =
        args.flavor && args.flavor !== "all" ? normEntType(args.flavor) : null;
      const types = flavor ? `urn:entity:${flavor}` : ALLOWED_SEARCH_TYPES;
      let results: EntBrief[];
      try {
        results = await searchEntities(args.query.trim(), apiKey, types);
      } catch (e) {
        if (e instanceof QlooAuthError) {
          return { candidates: [], error: "密钥不对或已失效，请检查后重新保存" };
        }
        return {
          candidates: [],
          error: e instanceof Error ? e.message : "搜索失败，请再试一次",
        };
      }
      const seen = new Set<string>();
      const candidates: PinnedEnt[] = [];
      for (const e of results) {
        const t = normEntType(e.type);
        if (!isAllowedType(t) || seen.has(e.id)) continue;
        if (flavor && t !== flavor) continue;
        seen.add(e.id);
        candidates.push(candidateCard({ ...e, type: t }));
        if (candidates.length >= 10) break;
      }
      return { candidates, error: null };
    },
  }),

  /** Validity probe for one manually added pack member: the same
   * signal-validity check automatic members pass through
   * (validatePackMembers). An invalid member is refused here, at add
   * time, with the reason stated — never silently dropped later. */
  validatePackMember: defineAction({
    request: z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(300),
      type: z.string().min(1).max(60),
    }),
    response: packValidateResponse,
    handler: async (ctx, args): Promise<z.infer<typeof packValidateResponse>> => {
      const apiKey = await getStoredQlooKey(ctx);
      if (!apiKey) {
        return { ok: false, error: "请在站点设置配置 QLOO_API_KEY 服务端 Secret" };
      }
      const unavailable = `《${args.name}》在 Qloo 侧暂时不可用——没有可用的品味数据，没能加进包里。`;
      const ent: EntBrief = {
        id: args.id,
        name: args.name,
        type: normEntType(args.type),
        desc: "",
        website: "",
        address: "",
        year: null,
        byline: "",
        image: "",
      };
      try {
        const { kept } = await validatePackMembers([ent], apiKey);
        if (kept.length === 1) return { ok: true, error: null };
        return { ok: false, error: unavailable };
      } catch (e) {
        if (e instanceof QlooAuthError) {
          return { ok: false, error: "密钥不对或已失效，请检查后重新保存" };
        }
        return { ok: false, error: unavailable };
      }
    },
  }),

  // --- intent signal pre-check -------------------------------------------
  //
  // A chosen entry's tags being readable does NOT mean Qloo can
  // compute with it as a signal. Before a confirmed destination/seed
  // is used, this pre-check spends exactly ONE entity insights call
  // (take=1): the entry counts as computable only when Qloo returns
  // a measured affinity (query.affinity or the top-level affinity).
  // No measured value → measurement_incomplete at stage signal_check;
  // a rejected query → signal_check_rejected with the entity named
  // in the detail. A failed pre-check stays on the confirmation
  // page: it never re-runs a whole route and never swaps the id.
  checkIntentSignal: defineAction({
    request: z.object({
      entityId: z.string().uuid(),
      targetType: z.enum(["movie", "tv_show", "artist", "book"]),
    }),
    response: signalCheckResponse,
    handler: async (ctx, args): Promise<z.infer<typeof signalCheckResponse>> => {
      const apiKey = await getStoredQlooKey(ctx);
      if (!apiKey) {
        return {
          ok: false,
          error: "请先在下方填入 Qloo 密钥",
          error_code: "signal_check_failed",
          error_detail: null,
        };
      }
      try {
        const d = await qlooGet(
          "/v2/insights",
          {
            "filter.type": `urn:entity:${args.targetType}`,
            "signal.interests.entities": args.entityId,
            take: "1",
          },
          apiKey,
          "signal_check",
        );
        const results = asObj(d.results);
        const entities = Array.isArray(results.entities)
          ? (results.entities as unknown[])
          : [];
        const first = entities[0] != null ? asObj(entities[0]) : null;
        const aff = first
          ? (asObj(first.query).affinity ?? first.affinity)
          : undefined;
        if (typeof aff === "number") {
          return { ok: true, error: null, error_code: null, error_detail: null };
        }
        throw new QlooMeasurementError(
          {
            ring: entities.length,
            eligible: 0,
            hop_measured: 0,
            home_measured: 0,
            complete: 0,
          },
          "signal_check",
        );
      } catch (e) {
        if (e instanceof QlooRequestError) {
          return {
            ok: false,
            error: qlooFailureMessage("signal_check_rejected"),
            error_code: "signal_check_rejected",
            error_detail: {
              ...upstreamDetailFor(e),
              signal_entity_ids: [args.entityId],
            },
          };
        }
        if (e instanceof QlooAuthError) {
          return {
            ok: false,
            error: qlooFailureMessage("auth"),
            error_code: "auth",
            error_detail: null,
          };
        }
        if (e instanceof QlooRateLimitError || e instanceof QlooUpstreamError) {
          const code = qlooFailureCode(e);
          return {
            ok: false,
            error: qlooFailureMessage(code),
            error_code: code,
            error_detail: upstreamDetailFor(e),
          };
        }
        return {
          ok: false,
          error: "信号预检查没跑通，请稍后再试。",
          error_code: "signal_check_failed",
          error_detail: null,
        };
      }
    },
  }),

  // --- route library -------------------------------------------------------

  listRoutes: defineAction({
    request: z.object({}),
    response: z.object({ routes: z.array(routeSummary) }),
    async handler(ctx) {
      await ensureSeeded(ctx);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.routes)
        .where(routeScope(ctx))
        .orderBy(asc(schema.routes.createdAt), asc(schema.routes.routeId));
      return {
        routes: rows.map((r) => ({
          route_id: r.routeId,
          title: r.title,
          destination: r.destination,
        })),
      };
    },
  }),

  getRoute: defineAction({
    request: z.object({ route_id: z.string().min(1) }),
    response: z.object({
      route: z.object({ route_id: z.string(), data: z.string() }).nullable(),
    }),
    async handler(ctx, args) {
      await ensureSeeded(ctx);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.routes)
        .where(and(eq(schema.routes.routeId, args.route_id),routeScope(ctx)))
        .limit(1);
      const row = rows[0];
      if (!row) return { route: null };
      return { route: { route_id: row.routeId, data: row.data } };
    },
  }),

  importRoute: defineAction({
    request: z.object({ data: z.string().min(2).max(500_000).refine(value=>new TextEncoder().encode(value).length<=500_000) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      route_id: z.string().nullable(),
      title: z.string().nullable(),
      destination: z.string().nullable(),
    }),
    async handler(ctx, args) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.data);
      } catch {
        return {
          ok: false,
          error: "不是有效的 JSON。",
          route_id: null,
          title: null,
          destination: null,
        };
      }
      const bad = (error: string) => ({
        ok: false,
        error,
        route_id: null,
        title: null,
        destination: null,
      });
      if (parsed == null || typeof parsed !== "object") return bad("路线必须是一个 JSON 对象。");
      const r = parsed as Record<string, unknown>;
      if (r.schema !== "acquired-route/2")
        return bad('schema 字段必须为 "acquired-route/2"。');
      if (!Array.isArray(r.steps) || r.steps.length === 0)
        return bad("缺少 steps（至少需要一步）。");
      if (typeof r.route_id !== "string" || r.route_id.length === 0)
        return bad("缺少 route_id。");
      if(new TextEncoder().encode(args.data).length>500_000)return bad("Route exceeds the public beta storage limit.");
      const row = parseRouteRow(args.data);
      if (!row) return bad("无法解析路线元信息。");
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.routes)
        .values({
          routeId: row.routeId,
          ownerId: ctx.ownerId ?? null,
          title: row.title,
          destination: row.destination,
          data: args.data,
        })
        .onConflictDoUpdate({
          target: schema.routes.routeId,
          set: { title: row.title, destination: row.destination, data: args.data },
          setWhere: routeScope(ctx),
        });
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        route_id: row.routeId,
        title: row.title,
        destination: row.destination,
      };
    },
  }),

  deleteRoute: defineAction({
    request: z.object({ route_id: z.string().min(1) }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.routes).where(and(eq(schema.routes.routeId, args.route_id),routeScope(ctx)));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // --- sessions --------------------------------------------------------------

  listSessions: defineAction({
    request: z.object({
      limit: z.number().int().positive().max(100).default(50),
    }),
    response: z.object({ sessions: z.array(sessionSummary) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(sessionScope(ctx))
        .orderBy(desc(schema.sessions.id))
        .limit(args.limit);
      return { sessions: rows.map(toSummary) };
    },
  }),

  createSession: defineAction({
    request: z.object({ data: z.string().min(2).max(500_000).refine(value=>new TextEncoder().encode(value).length<=500_000) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.sessions)
        .values({ data: args.data, finished: false, ownerId: ctx.ownerId ?? null })
        .returning({ id: schema.sessions.id });
      const inserted = result[0];
      if (!inserted) {
        throw new Error("createSession: insert returned no rows");
      }
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  getSession: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      session: sessionSummary
        .extend({ data: z.string(), route_data: z.string().nullable() })
        .nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, args.id),sessionScope(ctx)))
        .limit(1);
      const row = rows[0];
      if (!row) return { session: null };
      const routeData = await resolveRouteData(ctx, row.data);
      return { session: { ...toSummary(row), data: row.data, route_data: routeData } };
    },
  }),

  saveSession: defineAction({
    request:z.object({id:z.number().int().positive(),data:z.string().min(2).max(500_000).refine(value=>new TextEncoder().encode(value).length<=500_000),finished:z.boolean(),expected_data:z.string().min(2).max(500_000)}),
    response:z.object({ok:z.boolean(),error_code:z.string().optional(),current_data:z.string().optional()}),
    async handler(ctx,args){
      const db=ctx.db<typeof schema>();
      if(typeof args.expected_data!=='string')return {ok:false,error_code:'expected_data_required'};
      const updated=await db.update(schema.sessions).set({data:args.data,finished:args.finished,updatedAt:new Date()})
        .where(and(eq(schema.sessions.id,args.id),eq(schema.sessions.data,args.expected_data),sessionScope(ctx))).returning({id:schema.sessions.id});
      if(updated.length){ctx.invalidateQueries();return {ok:true};}
      const rows=await db.select().from(schema.sessions).where(and(eq(schema.sessions.id,args.id),sessionScope(ctx))).limit(1);
      if(rows[0]?.data===args.data)return {ok:true}; // Acknowledgement lost: idempotent retry.
      return {ok:false,error_code:rows.length?'session_conflict':'session_missing',current_data:rows[0]?.data};
    },
  }),

} satisfies ActionsModule;

// Sites preflight: reuse the core resolver before spending the route budget,
// so the owner can confirm the exact destination and its intent signals.
export const SitesIntentActions = {
  checkIntentSignal: defineAction({
    request:z.object({entityId:z.string().uuid(),targetType:z.enum(['movie','tv_show','artist','book'])}),
    response:z.object({ok:z.boolean(),error:z.string().nullable(),error_code:z.string().nullable(),error_detail:errorDetailSchema.nullable()}),
    handler:async(ctx,args)=>{
      const key=await getStoredQlooKey(ctx);
      if(!key)return {ok:false,error:'请在站点设置配置 QLOO_API_KEY 服务端 Secret',error_code:'no_key',error_detail:null};
      try{
        // One association query, not a tag lookup or a route. A catalogue
        // tag profile can exist even when this id cannot be used as a signal.
        const rows=await insightsEntities(args.targetType,[args.entityId],key,1);
        if(!rows.some(row=>typeof asObj(asObj(row).query).affinity==='number'||typeof asObj(row).affinity==='number')){
          throw new QlooMeasurementError({ring:rows.length,eligible:rows.length,hop_measured:0,home_measured:0,complete:0},'signal_check');
        }
        return {ok:true,error:null,error_code:null,error_detail:null};
      }catch(e){
        if(e instanceof QlooRequestError)return {ok:false,error:'Qloo 没有接受这个条目的关联检查。请核对同名记录；目标和条件会保留。',error_code:'signal_check_rejected',error_detail:{...upstreamDetailFor(e),signal_entity_ids:[args.entityId]}};
        if(e instanceof QlooRateLimitError||e instanceof QlooUpstreamError)return {ok:false,error:qlooFailureMessage(e),error_code:qlooFailureCode(e),error_detail:upstreamDetailFor(e)};
        return {ok:false,error:'暂时没能核查这个条目的关联数据，请稍后重试。',error_code:e instanceof QlooAuthError?'auth':'signal_check_failed',error_detail:null};
      }
    },
  }),
  getIntentOptions: defineAction({
    request:z.object({}),
    response:z.object({options:z.array(z.object({concept:z.string(),tagId:z.string(),tagName:z.string(),pending:z.boolean()}))}),
    handler:async()=>({options:MOTIVATION_TAG_MAP.map(e=>({concept:e.concept,tagId:e.tagId,tagName:e.tagName,pending:e.pending===true}))}),
  }),
  resolveIntentDestination: defineAction({
    request:z.object({query:z.string().min(1).max(200),field:z.enum(["destination","seed"]).optional(),index:z.number().int().min(0).max(19).optional()}),
    response:z.object({ok:z.boolean(),error:z.string().nullable(),error_code:z.string().nullable(),error_detail:errorDetailSchema.nullable(),need_choice:needChoiceSchema.nullable()}),
    handler:async(ctx,args)=>{
      const key=await getStoredQlooKey(ctx);
      if(!key)return {ok:false,error:'请在站点设置配置 QLOO_API_KEY 服务端 Secret',error_code:'no_key',error_detail:null,need_choice:null};
      try{
        const field=args.field??'destination',index=field==='seed'?(args.index??0):null;
        const expanded=await confirmationCandidates(args.query,field,key);
        if(expanded)return {ok:true,error:null,error_code:null,error_detail:null,need_choice:{field,index,query:args.query,hint:'请选择具体作品；小说、电影等版本分别列出。可以按类型筛选或查看更多本次候选。',candidates:expanded.ents.map(candidateCard),packs:null,tier:'choices' as const,scope_type_label:null,closest:[],via_translation:expanded.translation}};
        const res=await resolveOne(args.query,null,field,index,key);
        if(!res.ok)return {ok:true,error:null,error_code:null,error_detail:null,need_choice:res.choice};
        if(res.pack)return {ok:false,error:'这次识别为整个系列；当前界面请先确认一个具体作品，系列编辑暂未接入。',error_code:'pack_not_available',error_detail:null,need_choice:null};
        return {ok:true,error:null,error_code:null,error_detail:null,need_choice:{field,index,query:args.query,hint:'请确认具体条目；同名同年也可能是不同记录，不会自动替换你的选择。',candidates:identityChoices(res.ents).map(candidateCard),packs:null,tier:'choices' as const,scope_type_label:null,closest:[],via_translation:res.via?.translation??null}};
      }catch(e){
        if(e instanceof QlooRateLimitError||e instanceof QlooUpstreamError)return {ok:false,error:qlooFailureMessage(e),error_code:qlooFailureCode(e),error_detail:upstreamDetailFor(e),need_choice:null};
        return {ok:false,error:'暂时没能确认目的地，请稍后重试。',error_code:e instanceof QlooAuthError?'auth':'resolve_failed',error_detail:null,need_choice:null};
      }
    },
  }),
};

/** Offline self-check hooks (not part of the action contract): the
 * pure parsers and the route builder, so the parser counterexamples
 * and the stub-endpoint routing tests can run without a client. */
export const __test = {
  parseConstraints,
  parseHorrorGore,
  parseMotivationSignals,
  genericPendingPlaceholder,
  filterMotivationPrefsBySelection,
  parseRetryAfter,
  rejectedSignalIds,
  MOTIVATION_TAG_MAP,
  profileHasHorror,
  profileHasGore,
  profileHasTagId,
  mergeManualConstraints,
  vetManualTagConstraints,
  verifyTagExists,
  destinationHorrorEvidence,
  storedConstraints,
  storedMotivationSignals,
  buildRouteBundle,
  catalogHorrorLabels,
  catalogTasteTags,
  entBrief,
  attachWhys,
  // Signal patch (batch: call reduction): typed errors, the failure
  // mapping, and the raw transport for stub-level assertions.
  qlooGet,
  QlooSignalError,
  QlooMeasurementError,
  QlooRequestError,
  QlooUpstreamError,
  QlooRateLimitError,
  qlooFailureCode,
  qlooFailureMessage,
  upstreamDetailFor,
  /** Run fn inside a fresh per-request Qloo generation (the same
   * request slot the action entries enter), so the signal-failure
   * send-block can be asserted directly. */
  withQlooContext<T>(fn: () => Promise<T>): Promise<T> {
    return traceStorage.run(newTrace({minIntervalMs:0,cache:false}), fn);
  },
};

