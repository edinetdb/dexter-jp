/**
 * Environment + auth guard for the Claude Agent SDK mode.
 *
 * The Agent SDK resolves its own credentials (Claude Code login / OAuth token /
 * ANTHROPIC_API_KEY / Bedrock / Vertex / Foundry). Dexter does NOT implement any
 * auth flow. This module's job is narrow and defensive:
 *
 *   1. Classify which credential path the SDK will most likely take, from env.
 *   2. Build an allowlisted env object to hand the SDK (never `process.env` whole),
 *      so we don't silently forward a metered provider path we didn't intend.
 *   3. Fail loud when a metered path is present but the user hasn't opted into it,
 *      or when signals conflict (e.g. an API key AND a Bedrock flag).
 *
 * "Fail loud" here means: return a guard result the caller surfaces to the user
 * and blocks on, rather than quietly running on an unexpected billing path.
 */

/** How the SDK will most likely authenticate, inferred from the environment. */
export type AuthRoute =
  | 'claude-code-login' // no explicit key/flags → SDK uses local Claude Code login / OAuth
  | 'oauth-token' // CLAUDE_CODE_OAUTH_TOKEN present
  | 'api-key' // ANTHROPIC_API_KEY present (metered)
  | 'bedrock' // CLAUDE_CODE_USE_BEDROCK (metered via AWS)
  | 'vertex' // CLAUDE_CODE_USE_VERTEX (metered via GCP)
  | 'foundry' // CLAUDE_CODE_USE_FOUNDRY (metered)
  | 'anthropic-aws'; // CLAUDE_CODE_USE_ANTHROPIC_AWS (metered)

/** Credential paths that incur usage-based billing rather than subscription/login. */
export const METERED_ROUTES: readonly AuthRoute[] = [
  'api-key',
  'bedrock',
  'vertex',
  'foundry',
  'anthropic-aws',
] as const;

export interface DetectedRoute {
  route: AuthRoute;
  /** The env var (or absence) that triggered this classification. */
  signal: string;
  metered: boolean;
  /** Human-readable label for display. */
  label: string;
}

const ROUTE_LABELS: Record<AuthRoute, string> = {
  'claude-code-login': 'Claude Code login',
  'oauth-token': 'OAuth token (CLAUDE_CODE_OAUTH_TOKEN)',
  'api-key': 'API key (ANTHROPIC_API_KEY) — usage-based billing',
  bedrock: 'Amazon Bedrock — usage-based billing',
  vertex: 'Google Vertex AI — usage-based billing',
  foundry: 'Azure AI Foundry — usage-based billing',
  'anthropic-aws': 'Anthropic on AWS — usage-based billing',
};

/**
 * Provider-selecting env flags. Presence (truthy, not '0'/'false') means the SDK
 * routes to that provider.
 */
const PROVIDER_FLAGS: Array<{ envVar: string; route: AuthRoute }> = [
  { envVar: 'CLAUDE_CODE_USE_BEDROCK', route: 'bedrock' },
  { envVar: 'CLAUDE_CODE_USE_VERTEX', route: 'vertex' },
  { envVar: 'CLAUDE_CODE_USE_FOUNDRY', route: 'foundry' },
  { envVar: 'CLAUDE_CODE_USE_ANTHROPIC_AWS', route: 'anthropic-aws' },
];

function isFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * Detect every credential signal present in `env`. Order does not imply the SDK's
 * internal precedence; we report all of them so conflicts can be flagged.
 */
export function detectAuthRoutes(env: NodeJS.ProcessEnv = process.env): DetectedRoute[] {
  const routes: DetectedRoute[] = [];

  for (const { envVar, route } of PROVIDER_FLAGS) {
    if (isFlagEnabled(env[envVar])) {
      routes.push({ route, signal: envVar, metered: true, label: ROUTE_LABELS[route] });
    }
  }

  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== '') {
    routes.push({ route: 'api-key', signal: 'ANTHROPIC_API_KEY', metered: true, label: ROUTE_LABELS['api-key'] });
  }

  if (env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN.trim() !== '') {
    routes.push({
      route: 'oauth-token',
      signal: 'CLAUDE_CODE_OAUTH_TOKEN',
      metered: false,
      label: ROUTE_LABELS['oauth-token'],
    });
  }

  // If nothing explicit is set, the SDK falls back to the local Claude Code login.
  if (routes.length === 0) {
    routes.push({
      route: 'claude-code-login',
      signal: '(no credential env vars set)',
      metered: false,
      label: ROUTE_LABELS['claude-code-login'],
    });
  }

  return routes;
}

export interface EnvGuardResult {
  /** Every credential signal detected in the source env. */
  detected: DetectedRoute[];
  /** True when at least one usage-based path is present. */
  hasMetered: boolean;
  /** True when both a metered and a login/OAuth path are present (ambiguous billing). */
  hasConflict: boolean;
  /**
   * When true, the caller must stop and confirm with the user before running
   * (a metered path is present, or signals conflict). Cleared by opting in.
   */
  requiresConfirmation: boolean;
  /** One-line human summary for display. */
  summary: string;
  /** Longer, multi-line explanation for the confirm prompt (present when requiresConfirmation). */
  detail?: string;
}

/**
 * Evaluate the env for billing-path safety.
 *
 * @param opts.env            Source environment (defaults to process.env).
 * @param opts.allowMetered   User has explicitly opted into a usage-based path
 *                            (e.g. chose to use their API key). When true, a
 *                            metered path alone does not require confirmation,
 *                            but a *conflict* still does.
 */
export function evaluateEnvGuard(opts: { env?: NodeJS.ProcessEnv; allowMetered?: boolean } = {}): EnvGuardResult {
  const env = opts.env ?? process.env;
  const allowMetered = opts.allowMetered ?? false;
  const detected = detectAuthRoutes(env);

  const meteredRoutes = detected.filter((d) => d.metered);
  const nonMeteredRoutes = detected.filter((d) => !d.metered);
  const hasMetered = meteredRoutes.length > 0;
  // A conflict is a metered path co-existing with an explicit login/OAuth path,
  // OR two different metered providers set at once.
  const hasExplicitLogin = nonMeteredRoutes.some((d) => d.route === 'oauth-token');
  const hasConflict =
    (hasMetered && hasExplicitLogin) || new Set(meteredRoutes.map((d) => d.route)).size > 1;

  const requiresConfirmation = hasConflict || (hasMetered && !allowMetered);

  const summary =
    detected.length === 1
      ? `Auth route: ${detected[0].label}`
      : `Auth routes detected: ${detected.map((d) => d.label).join('; ')}`;

  let detail: string | undefined;
  if (requiresConfirmation) {
    const lines: string[] = [];
    if (hasConflict) {
      lines.push(
        'Conflicting credential signals are present. The SDK may run on an unexpected billing path:',
      );
    } else {
      lines.push('A usage-based (billable) credential path is present in your environment:');
    }
    for (const d of detected) {
      lines.push(`  - ${d.signal}: ${d.label}${d.metered ? '  [BILLABLE]' : ''}`);
    }
    lines.push('');
    lines.push(
      'Claude Agent SDK mode does not manage credentials — the SDK will use whatever it resolves.',
    );
    lines.push(
      'If you intend to use a usage-based path, confirm to proceed. Otherwise unset the variable(s) above',
    );
    lines.push('to run on your Claude Code login, then try again.');
    detail = lines.join('\n');
  }

  return { detected, hasMetered, hasConflict, requiresConfirmation, summary, detail };
}

/**
 * Env var name prefixes that carry the Claude Code / SDK login + OAuth context.
 * These must reach the SDK subprocess for the login path to work.
 */
const OAUTH_ENV_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_', 'ANTHROPIC_'] as const;

/**
 * Baseline OS env keys the SDK subprocess needs to spawn/run. We forward these
 * unconditionally (they are not credentials).
 */
const BASE_ENV_KEYS = [
  'HOME',
  'PATH',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'NODE_OPTIONS',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
] as const;

/**
 * Build the allowlisted env to hand the SDK. This REPLACES process.env for the
 * SDK subprocess (the SDK's `env` option does not merge), so we must include the
 * OS baseline plus the credential/OAuth context. Provider metered flags are
 * forwarded ONLY when the user opted in — otherwise they are stripped so an
 * unintended billable path cannot activate.
 *
 * @param opts.allowMetered  When true, metered provider flags/keys are forwarded
 *                          as-is (user chose a usage-based path). When false,
 *                          they are omitted from the SDK env.
 */
export function buildSdkEnv(opts: { env?: NodeJS.ProcessEnv; allowMetered?: boolean } = {}): Record<string, string | undefined> {
  const source = opts.env ?? process.env;
  const allowMetered = opts.allowMetered ?? false;

  const meteredEnvVars = new Set<string>([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    ...PROVIDER_FLAGS.map((f) => f.envVar),
    // AWS/GCP credential material only matters when a provider flag is on; strip
    // when not opted in so we never half-configure a metered path.
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_PROFILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLOUD_ML_REGION',
  ]);

  const out: Record<string, string | undefined> = {};

  for (const key of BASE_ENV_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }

  for (const [key, value] of Object.entries(source)) {
    const isOauthContext = OAUTH_ENV_PREFIXES.some((p) => key.startsWith(p));
    if (!isOauthContext) continue;
    if (meteredEnvVars.has(key) && !allowMetered) continue; // strip metered unless opted in
    out[key] = value;
  }

  // Belt-and-suspenders: when not opted into metering, ensure no metered var slips
  // through under a prefix we didn't special-case.
  if (!allowMetered) {
    for (const key of meteredEnvVars) delete out[key];
  }

  return out;
}
