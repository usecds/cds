#!/usr/bin/env node
// PreToolUse hook: blocks git commits, merge requests and pull requests whose
// message mentions Claude, Anthropic or another coding agent / LLM tool.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN =
  /\b(claude|anthropic|chatgpt|openai|gpt-?\d|copilot|gemini|codex|cursor\s?ai|windsurf|aider|devin|llm-generated|ai-generated)\b|co-authored-by|generated (with|by)\b/i;
const RELEVANT = /\bgit\s+(-\S+\s+)*(commit|tag|notes|merge)\b|\b(glab|gh)\s+(mr|pr)\b/;

let input = '';
for await (const chunk of process.stdin) input += chunk;
let data;
try { data = JSON.parse(input); } catch { process.exit(0); }

const command = data?.tool_input?.command;
if (typeof command !== 'string' || !RELEVANT.test(command)) process.exit(0);

// Check only message text: -m/--message/--title/--description/--body values,
// heredoc bodies and files passed with -F/--file (not paths or other arguments).
const cwd = data.cwd || process.cwd();
const parts = [];
const value = /"((?:[^"\\]|\\.)*)"|'([^']*)'|@'([\s\S]*?)'@|@"([\s\S]*?)"@|(\S+)/.source;
const flag = /(?:^|\s)(?:-m|--message|-t|--title|-d|--description|-b|--body)(?:\s+|=)/.source;
for (const m of command.matchAll(new RegExp(`${flag}(?:${value})`, 'g'))) {
  parts.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '');
}
for (const m of command.matchAll(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/g)) parts.push(m[2]);
for (const m of command.matchAll(/(?:^|\s)(?:-F|--file)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
  const name = m[1] ?? m[2] ?? m[3];
  if (name === '-') continue;
  const file = resolve(cwd, name);
  if (existsSync(file)) {
    try { parts.push(readFileSync(file, 'utf8')); } catch {}
  }
}
const text = parts.join('\n');

const hit = text.match(FORBIDDEN);
if (hit) {
  process.stderr.write(
    `Blocked: the commit/MR/PR text mentions "${hit[0]}". Never mention Claude, Anthropic or any other ` +
      'coding agent or AI tool in commit messages, MR/PR titles or descriptions (no Co-Authored-By trailers, ' +
      'no "Generated with" lines). Reword and retry.\n',
  );
  process.exit(2);
}
