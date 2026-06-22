#!/usr/bin/env node
'use strict';
// Claude Code PermissionRequest hook for claude-autoapprove.
// Invoked by Claude Code before every tool use.
// Exits immediately with no output if CLIDECK_SESSION_ID is absent —
// the plugin is intentionally inert outside of clideck sessions.
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');
const http = require('http');

const port = parseInt(process.argv[2], 10) || 0;
const clideckId = process.env.CLIDECK_SESSION_ID || '';

if (!clideckId) process.exit(0);

const signalFile = join(os.homedir(), '.clideck', 'autoapprove', clideckId);

const SUPERVISED_GATES = new Set(['ExitPlanMode', 'AskUserQuestion']);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  if (!existsSync(signalFile)) process.exit(0);

  let hook = {};
  try { hook = JSON.parse(stdin); } catch {}
  const toolName = hook.tool_name || hook.toolName || '';

  let mode = 'supervised';
  try { mode = readFileSync(signalFile, 'utf8').trim() || 'supervised'; } catch {}

  if (mode === 'supervised' && SUPERVISED_GATES.has(toolName)) {
    // Let Claude Code handle these normally — plan approval and direct questions stay interactive
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  }));

  // Fire-and-forget telemetry to clideck (non-blocking)
  if (port) {
    const body = JSON.stringify({ clideck_id: clideckId, tool_name: toolName });
    const req = http.request({
      hostname: 'localhost',
      port,
      path: '/hook/plugin/claude-autoapprove/approve',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    });
    req.on('error', () => {});
    req.end(body);
  }
});
process.stdin.resume();
