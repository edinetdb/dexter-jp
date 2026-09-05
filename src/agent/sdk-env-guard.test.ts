import { describe, expect, test } from 'bun:test';
import {
  detectAuthRoutes,
  evaluateEnvGuard,
  buildSdkEnv,
  METERED_ROUTES,
} from './sdk-env-guard.js';

/** Build a minimal fake env; every field optional. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { HOME: '/home/x', PATH: '/usr/bin', ...overrides } as NodeJS.ProcessEnv;
}

describe('detectAuthRoutes', () => {
  test('classifies bare environment as Claude Code login (non-metered)', () => {
    const routes = detectAuthRoutes(env());
    expect(routes).toHaveLength(1);
    expect(routes[0].route).toBe('claude-code-login');
    expect(routes[0].metered).toBe(false);
  });

  test('classifies ANTHROPIC_API_KEY as metered api-key', () => {
    const routes = detectAuthRoutes(env({ ANTHROPIC_API_KEY: 'sk-abc' }));
    const apiKey = routes.find((r) => r.route === 'api-key');
    expect(apiKey).toBeDefined();
    expect(apiKey?.metered).toBe(true);
  });

  test('classifies OAuth token as non-metered', () => {
    const routes = detectAuthRoutes(env({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok' }));
    const oauth = routes.find((r) => r.route === 'oauth-token');
    expect(oauth).toBeDefined();
    expect(oauth?.metered).toBe(false);
  });

  test.each([
    ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
    ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
    ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
    ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropic-aws'],
  ])('classifies %s=1 as metered %s', (flag, route) => {
    const routes = detectAuthRoutes(env({ [flag]: '1' }));
    const hit = routes.find((r) => r.route === route);
    expect(hit).toBeDefined();
    expect(hit?.metered).toBe(true);
    expect(METERED_ROUTES as readonly string[]).toContain(route);
  });

  test('treats flag=0/false/empty as disabled', () => {
    for (const val of ['0', 'false', '', 'no']) {
      const routes = detectAuthRoutes(env({ CLAUDE_CODE_USE_BEDROCK: val }));
      expect(routes.some((r) => r.route === 'bedrock')).toBe(false);
    }
  });
});

describe('evaluateEnvGuard', () => {
  test('login-only env requires no confirmation', () => {
    const r = evaluateEnvGuard({ env: env() });
    expect(r.hasMetered).toBe(false);
    expect(r.requiresConfirmation).toBe(false);
  });

  test('api-key present requires confirmation unless opted in', () => {
    const withKey = env({ ANTHROPIC_API_KEY: 'sk-abc' });
    expect(evaluateEnvGuard({ env: withKey }).requiresConfirmation).toBe(true);
    expect(evaluateEnvGuard({ env: withKey, allowMetered: true }).requiresConfirmation).toBe(false);
  });

  test('conflict (api-key + oauth token) requires confirmation even when opted in', () => {
    const conflicting = env({ ANTHROPIC_API_KEY: 'sk-abc', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    const r = evaluateEnvGuard({ env: conflicting, allowMetered: true });
    expect(r.hasConflict).toBe(true);
    expect(r.requiresConfirmation).toBe(true);
    expect(r.detail).toBeDefined();
  });

  test('two metered providers at once is a conflict', () => {
    const two = env({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' });
    expect(evaluateEnvGuard({ env: two, allowMetered: true }).hasConflict).toBe(true);
  });

  test('summary is always populated', () => {
    expect(evaluateEnvGuard({ env: env() }).summary).toContain('Claude Code login');
  });
});

describe('buildSdkEnv', () => {
  test('forwards OS baseline + Claude Code OAuth context', () => {
    const out = buildSdkEnv({
      env: env({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_ENTRYPOINT: 'cli' }),
    });
    expect(out.HOME).toBe('/home/x');
    expect(out.PATH).toBe('/usr/bin');
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
  });

  test('strips metered vars when not opted in', () => {
    const out = buildSdkEnv({
      env: env({
        ANTHROPIC_API_KEY: 'sk-abc',
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_ACCESS_KEY_ID: 'AKIA',
      }),
      allowMetered: false,
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  test('forwards metered vars when opted in', () => {
    const out = buildSdkEnv({
      env: env({ ANTHROPIC_API_KEY: 'sk-abc' }),
      allowMetered: true,
    });
    expect(out.ANTHROPIC_API_KEY).toBe('sk-abc');
  });

  test('does not forward unrelated secrets (search/finance keys)', () => {
    const out = buildSdkEnv({
      env: env({ EDINETDB_API_KEY: 'edb', OPENAI_API_KEY: 'oai', TAVILY_API_KEY: 'tav' }),
    });
    expect(out.EDINETDB_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.TAVILY_API_KEY).toBeUndefined();
  });
});
