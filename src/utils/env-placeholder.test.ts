/**
 * `cp env.example .env` のあと鍵を入れなかった行（`your-...`）を未設定として扱うことを測る。
 *
 * 新規環境で README どおりに動かしたとき、仮の値が残った `.env` で
 * ①Claude Agent SDK モードが「従量課金の鍵がある」と止まり、②起動時の送信先一覧に
 * 使っていない送信先が並んだ（2026-10-08 の実走）。読み込みの入口で取り除くので、
 * ここでは入口の関数と、その後ろの読み手（ガード・送信先一覧）が仮の値を見ないことを測る。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ENV_EXAMPLE_PLACEHOLDERS, dropPlaceholderEnv, isPlaceholderValue, saveApiKeyToEnv } from './env.js';
import { evaluateEnvGuard } from '../agent/sdk-env-guard.js';
import { activeDestinations } from '../config/egress.js';

const ROOT = join(import.meta.dir, '..', '..');

/** env.example を、cp したまま何も書き換えていない `.env` として読む。 */
function envFromExample(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(join(ROOT, 'env.example'), 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...v] = t.split('=');
    env[k.trim()] = v.join('=').trim();
  }
  return env;
}

describe('仮の値（your-...）は未設定として扱う', () => {
  test('判定: env.example の「変数名と仮の値の組」に完全一致するものだけが仮の値', () => {
    expect(isPlaceholderValue('OPENAI_API_KEY', 'your-openai-api-key')).toBe(true);
    expect(isPlaceholderValue('OPENAI_API_KEY', '  your-openai-api-key ')).toBe(true);
    expect(isPlaceholderValue('OPENAI_API_KEY', 'sk-real')).toBe(false);
    expect(isPlaceholderValue('OPENAI_API_KEY', '')).toBe(false);
    expect(isPlaceholderValue('OPENAI_API_KEY', undefined)).toBe(false);
    // たまたま your- で始まる正当な設定は消さない（Codex r1 M2）
    expect(isPlaceholderValue('LANGSMITH_PROJECT', 'your-team-research')).toBe(false);
    expect(isPlaceholderValue('NO_PROXY', 'your-internal-host')).toBe(false);
    expect(isPlaceholderValue('OPENAI_API_KEY', 'your-other-value')).toBe(false);
  });

  test('仮の値の表は env.example の your- の行と一致する（片方だけ足すと赤）', () => {
    const fromExample: Record<string, string> = {};
    for (const [k, v] of Object.entries(envFromExample())) {
      if (v && v.startsWith('your-')) fromExample[k] = v;
    }
    expect({ ...ENV_EXAMPLE_PLACEHOLDERS }).toEqual(fromExample);
  });

  test('env.example をそのまま読むと仮の値の行は全部消え、実値の行は残る', () => {
    const env = envFromExample();
    expect(env.ANTHROPIC_API_KEY).toBe('your-anthropic-api-key'); // 前提: 例示ファイルに仮の値がある
    const dropped = dropPlaceholderEnv(env);
    expect(dropped).toContain('OPENAI_API_KEY');
    expect(dropped).toContain('ANTHROPIC_API_KEY');
    expect(dropped).toContain('EDINETDB_API_KEY');
    expect(Object.entries(env).some(([k, v]) => isPlaceholderValue(k, v))).toBe(false);
    expect(Object.values(env).some(v => typeof v === 'string' && v.startsWith('your-'))).toBe(false);
    expect(env.DEXTER_SKIP_BROWSER).toBe('1');
  });

  test('仮の値を取り除いた後、Agent SDK のガードは従量課金の鍵を検出しない', () => {
    const env = envFromExample();
    dropPlaceholderEnv(env);
    const res = evaluateEnvGuard({ env, allowMetered: false });
    expect(res.hasMetered).toBe(false);
    expect(res.requiresConfirmation).toBe(false);
  });

  test('仮の値を取り除いた後、送信先一覧に OpenAI 等の未設定の送信先は出ない', () => {
    const env = envFromExample();
    dropPlaceholderEnv(env);
    const ids = activeDestinations(env).map(d => d.id);
    for (const id of ['edinetdb', 'typesafe-jev', 'jquants', 'web-search', 'x-search', 'openrouter', 'moonshot', 'deepseek']) {
      expect({ id, active: ids.includes(id) }).toEqual({ id, active: false });
    }
  });

  test('鍵を保存した後の読み直しでも仮の値は戻らない（Codex r1 M1）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-env-'));
    const prevCwd = process.cwd();
    const touched = [...Object.keys(ENV_EXAMPLE_PLACEHOLDERS), 'DEXTER_SKIP_BROWSER', 'OLLAMA_BASE_URL', 'DEXTER_AGENT_SDK_ALLOW_METERED',
      'WEBHOOK_PORT', 'LANGSMITH_ENDPOINT', 'LANGSMITH_PROJECT', 'LANGSMITH_TRACING'];
    const saved: Record<string, string | undefined> = {};
    for (const k of touched) saved[k] = process.env[k];
    try {
      writeFileSync(join(dir, '.env'), readFileSync(join(ROOT, 'env.example'), 'utf-8'));
      process.chdir(dir);
      expect(saveApiKeyToEnv('TAVILY_API_KEY', 'tvly-test-value')).toBe(true);
      expect(process.env.TAVILY_API_KEY).toBe('tvly-test-value');
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(evaluateEnvGuard({ env: process.env, allowMetered: false }).hasMetered).toBe(false);
    } finally {
      process.chdir(prevCwd);
      for (const k of touched) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.env の読み込み口（src/index.tsx）は仮の値を取り除く loadEnv を通る', () => {
    const src = readFileSync(join(ROOT, 'src', 'index.tsx'), 'utf-8');
    expect(src).toContain('loadEnv()');
    expect(src).not.toMatch(/config\(\{\s*quiet/);
  });
});

describe('起動時の送信先一覧が画面の作り直しで消えない', () => {
  test('restoreMainView も送信先一覧を積む（起動直後に必ず通るため）', () => {
    const cli = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
    const start = cli.indexOf('const restoreMainView = () => {');
    expect(start).toBeGreaterThan(-1);
    const body = cli.slice(start, cli.indexOf('};', start));
    expect(body).toContain('root.addChild(egressText)');
    expect(body.indexOf('root.addChild(intro)')).toBeLessThan(body.indexOf('root.addChild(egressText)'));
  });

  test('restoreMainView は送信先一覧と警告を今の環境から作り直す（Codex r1 M3）', () => {
    const cli = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf-8');
    const start = cli.indexOf('const restoreMainView = () => {');
    const body = cli.slice(start, cli.indexOf('};', start));
    expect(body).toContain('egressText.setText(theme.muted(renderEgressScreen(process.env)');
    expect(body).toContain('warningText.setText(renderWarnings(');
    expect(body.indexOf('egressText.setText(')).toBeLessThan(body.indexOf('root.addChild(egressText)'));
  });
});
