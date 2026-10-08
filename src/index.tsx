#!/usr/bin/env bun
import { loadEnv } from './utils/env.js';
import { runCli } from './cli.js';

// Load environment variables（env.example の仮の値 `your-...` は未設定として扱う）
loadEnv();

await runCli();
