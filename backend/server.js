import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { NodeSSH } from 'node-ssh';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/netops.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'netops-admin-changeme';
const PORT = parseInt(process.env.PORT || '3001');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLAB_HOST = process.env.CLAB_HOST || '10.0.0.71';
const CLAB_USER = process.env.CLAB_USER || 'jamazan';
const CLAB_KEY  = process.env.CLAB_KEY  || '/app/ssh/server';
const MCP_CALL  = process.env.MCP_CALL  || '/home/jamazan/netclaw/netclaw/scripts/mcp-call.py';
const CLAB_MCP  = process.env.CLAB_MCP  || '/home/jamazan/netclaw/netclaw/mcp-servers/clab-mcp-server/clab_mcp_server.py';
const PYATS_MCP = process.env.PYATS_MCP || '/home/jamazan/netclaw/netclaw/mcp-servers/pyATS_MCP/pyats_mcp_server.py';
const FAULT_DIR       = process.env.FAULT_DIR        || '/home/jamazan/netclaw-faults';
const SKILLS_REPO       = process.env.SKILLS_REPO       || '';
const SKILLS_REPO_PATH  = process.env.SKILLS_REPO_PATH  || '';
const SKILLS_DIR        = process.env.SKILLS_DIR        || '';
const SKILLS_REPO_TOKEN = process.env.SKILLS_REPO_TOKEN || '';
const SKILLS_REPO_BRANCH= process.env.SKILLS_REPO_BRANCH|| 'main';

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://10.0.0.43:8080','http://localhost:8080','https://runner.amazan.me'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL,
    used_by TEXT, used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, token_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    joined_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, test_id TEXT NOT NULL,
    score TEXT NOT NULL, notes TEXT, criteria TEXT, llm_response TEXT,
    auto_score TEXT, saved_at INTEGER NOT NULL,
    UNIQUE(user_id, test_id)
  );
  CREATE TABLE IF NOT EXISTS live_runs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fault_id TEXT NOT NULL,
    injected_at INTEGER, restored_at INTEGER, status TEXT NOT NULL DEFAULT 'idle',
    llm_response TEXT, tool_calls TEXT, auto_score TEXT, duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, user_id TEXT,
    method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, note TEXT
  );
`);

const adminExists = db.prepare("SELECT id FROM tokens WHERE label='Admin Bootstrap'").get();
if (!adminExists) {
  const tid = 'NETOPS-ADMIN-' + nanoid(8).toUpperCase();
  db.prepare("INSERT INTO tokens (id,label,created_at) VALUES (?,?,?)").run(tid,'Admin Bootstrap',Date.now());
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  FIRST BOOT — Admin bootstrap token:                 ║');
  console.log(`║  ${tid.padEnd(52)}║`);
  console.log(`║  Admin password: ${ADMIN_PASSWORD.padEnd(36)}║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

const authLimiter  = rateLimit({ windowMs: 15*60*1000, max: 20 });
const adminLimiter = rateLimit({ windowMs: 10*60*1000, max: 30 });

function audit(userId, method, path, status, note) {
  try { db.prepare("INSERT INTO audit_log (id,ts,user_id,method,path,status,note) VALUES (?,?,?,?,?,?,?)")
    .run(nanoid(), Date.now(), userId||null, method, path, status||null, note||null); } catch {}
}

function requireAuth(req, res, next) {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(401).json({ error: 'Session required' });
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  if (Date.now() - session.last_seen > SESSION_TTL_MS) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(sid);
    return res.status(401).json({ error: 'Session expired' });
  }
  db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(Date.now(), sid);
  req.user = db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id);
  if (!req.user) return res.status(401).json({ error: 'User not found' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Admin required' });
  next();
}

// ── SSH helper ───────────────────────────────────────────────────────────────
async function sshExec(command, host = CLAB_HOST, user = CLAB_USER) {
  const ssh = new NodeSSH();
  await ssh.connect({ host, username: user, privateKeyPath: CLAB_KEY, readyTimeout: 10000 });
  const result = await ssh.execCommand(command, { execOptions: { pty: false } });
  ssh.dispose();
  return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

// ── Auto-scoring engine ──────────────────────────────────────────────────────
function scoreResponse(llmResponse, toolCalls, faultMeta) {
  const text = (llmResponse || '').toLowerCase();
  const calls = toolCalls || [];
  const scores = {};

  // 1. Root cause identified (0-40 points)
  const rootCauseKeywords = (faultMeta.root_cause || '').toLowerCase().split(/[\s,]+/).filter(w => w.length > 4);
  const rootCauseMatches = rootCauseKeywords.filter(kw => text.includes(kw)).length;
  scores.root_cause = Math.round((rootCauseMatches / Math.max(rootCauseKeywords.length, 1)) * 40);

  // 2. Tool sequence (0-30 points) — did it call the right tools in roughly right order?
  const optimal = faultMeta.optimal_tool_sequence || [];
  const usedCmds = calls.map(c => (c.command || c.tool || '').toLowerCase());
  let toolMatches = 0;
  for (const optCmd of optimal) {
    if (usedCmds.some(used => used.includes(optCmd.toLowerCase().split(' ')[0]))) toolMatches++;
  }
  scores.tool_sequence = Math.round((toolMatches / Math.max(optimal.length, 1)) * 30);

  // 3. Fix proposed (0-20 points) — did it mention the right fix?
  const fixKeywords = (faultMeta.fix_command || '').toLowerCase().split(/[\s,]+/).filter(w => w.length > 3);
  const fixMatches = fixKeywords.filter(kw => text.includes(kw)).length;
  scores.fix_proposed = Math.round((fixMatches / Math.max(fixKeywords.length, 1)) * 20);

  // 4. Efficiency (0-10 points) — tool call count vs optimal
  const optimalCount = optimal.length + 1;
  const actualCount = calls.length;
  if (actualCount === 0) scores.efficiency = 0;
  else if (actualCount <= optimalCount) scores.efficiency = 10;
  else if (actualCount <= optimalCount * 2) scores.efficiency = 7;
  else scores.efficiency = 4;

  scores.total = scores.root_cause + scores.tool_sequence + scores.fix_proposed + scores.efficiency;
  scores.grade = scores.total >= 80 ? 'PASS' : scores.total >= 50 ? 'PARTIAL' : 'FAIL';

  return scores;
}

// ── Auth routes ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/api/auth/join', authLimiter, (req, res) => {
  const { token_id, display_name } = req.body;
  if (!token_id) return res.status(400).json({ error: 'token_id required' });
  const token = db.prepare('SELECT * FROM tokens WHERE id=?').get(token_id);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  if (token.revoked) return res.status(403).json({ error: 'Token revoked' });
  if (token.used_by) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(token.used_by);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const sid = nanoid(32);
    db.prepare("INSERT INTO sessions (id,user_id,created_at,last_seen) VALUES (?,?,?,?)").run(sid,user.id,Date.now(),Date.now());
    return res.json({ session_id: sid, user: { id:user.id, display_name:user.display_name, is_admin:user.is_admin } });
  }
  if (!display_name?.trim()) return res.status(400).json({ error: 'display_name required' });
  const userId = nanoid(); const sid = nanoid(32);
  db.prepare("INSERT INTO users (id,token_id,display_name,joined_at) VALUES (?,?,?,?)").run(userId,token_id,display_name.trim(),Date.now());
  db.prepare("UPDATE tokens SET used_by=?,used_at=? WHERE id=?").run(userId,Date.now(),token_id);
  db.prepare("INSERT INTO sessions (id,user_id,created_at,last_seen) VALUES (?,?,?,?)").run(sid,userId,Date.now(),Date.now());
  audit(userId,'POST','/api/auth/join',200,'New user joined');
  res.json({ session_id: sid, user: { id:userId, display_name:display_name.trim(), is_admin:0 } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=?').run(req.headers['x-session-id']);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) =>
  res.json({ id:req.user.id, display_name:req.user.display_name, is_admin:req.user.is_admin }));

// ── Knowledge test results ───────────────────────────────────────────────────
app.post('/api/results', requireAuth, (req, res) => {
  const { test_id, score, notes, criteria, llm_response, auto_score } = req.body;
  if (!test_id || !/^[\w\-.:]+$/.test(test_id) || test_id.length > 120) return res.status(400).json({ error: 'Invalid test_id' });
  const id = nanoid();
  db.prepare(`INSERT INTO results (id,user_id,test_id,score,notes,criteria,llm_response,auto_score,saved_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,test_id) DO UPDATE SET score=excluded.score,notes=excluded.notes,
    criteria=excluded.criteria,llm_response=excluded.llm_response,auto_score=excluded.auto_score,saved_at=excluded.saved_at`)
    .run(id,req.user.id,test_id,score,notes||null,
      typeof criteria==='object'?JSON.stringify(criteria):criteria||null,llm_response||null,
      typeof auto_score==='object'?JSON.stringify(auto_score):auto_score||null,Date.now());
  res.json({ ok: true });
});

app.get('/api/results', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM results WHERE user_id=? ORDER BY saved_at DESC').all(req.user.id);
  rows.forEach(r => { try { r.criteria=JSON.parse(r.criteria); } catch {} });
  res.json(rows);
});

app.get('/api/results/all', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT r.*,u.display_name FROM results r JOIN users u ON u.id=r.user_id ORDER BY r.saved_at DESC').all();
  rows.forEach(r => { try { r.criteria=JSON.parse(r.criteria); } catch {} });
  res.json(rows);
});

// ── Knowledge test proxy (claude) ────────────────────────────────────────────
app.post('/api/run-test', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY configured' });
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify(req.body)
    });
    res.status(upstream.status).json(await upstream.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── MCP/Knowledge test auto-scorer ──────────────────────────────────────────
app.post('/api/score-response', requireAuth, async (req, res) => {
  const { llm_response, criteria, test_id } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY configured' });
  if (!llm_response || !criteria?.length) return res.status(400).json({ error: 'llm_response and criteria required' });

  const criteriaText = criteria.map((c, i) =>
    `${i+1}. [${c.weight.toUpperCase()}] ${c.text}`
  ).join('\n');

  const scorePrompt = `You are evaluating an LLM response to a network engineering test question.

PASS CRITERIA:
${criteriaText}

LLM RESPONSE TO EVALUATE:
${llm_response.slice(0, 3000)}

Score this response. For each criterion, determine if it was met (true/false).
Then assign: PASS (all required criteria met), PARTIAL (some required criteria met), FAIL (most required criteria not met).

Respond ONLY with valid JSON, no markdown:
{"criteria_results":[{"index":1,"met":true,"note":"reason"},{"index":2,"met":false,"note":"reason"}],"required_met":2,"required_total":3,"bonus_met":1,"score":"PASS","confidence":"high","summary":"one sentence"}`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: scorePrompt }]
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) throw new Error(data.error?.message || `HTTP ${upstream.status}`);
    const raw = data.content?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g,'').trim();
    const autoScore = JSON.parse(clean);
    res.json({ auto_score: autoScore });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LIVE TEST ROUTES ─────────────────────────────────────────────────────────



// POST /api/skill/optimize — analyze a failed run and suggest skill improvements
app.post('/api/skill/optimize', requireAuth, async (req, res) => {
  const { run_id } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY configured' });
  if (!run_id) return res.status(400).json({ error: 'run_id required' });

  const run = db.prepare('SELECT * FROM live_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'complete') return res.status(400).json({ error: 'Run not complete' });

  const autoScore = JSON.parse(run.auto_score || '{}');
  if (autoScore.grade === 'PASS') return res.status(400).json({ error: 'Run already passed — no optimization needed' });

  // Fetch current skill content from clab host
  let skillContent = '';
  try {
    const { stdout } = await sshExec(`cat "${FAULT_DIR}/skills/${run.fault_id.replace(/[^a-z0-9-]/g,'')}.md" 2>/dev/null || echo ""`);
    skillContent = stdout.trim();
  } catch {}

  // Fetch fault metadata
  let faultMeta = {};
  try {
    const { stdout } = await sshExec(`cat "${FAULT_DIR}/${run.fault_id}.json" 2>/dev/null || echo "{}"`);
    faultMeta = JSON.parse(stdout);
  } catch {}

  // Also try the network-skills directory for sub-skill content
  if (!skillContent) {
    try {
      const skillName = faultMeta.skill || '';
      const { stdout } = await sshExec(`cat "/home/${process.env.CLAB_USER}/network-skills/${skillName}/SKILL.md" 2>/dev/null || echo ""`);
      skillContent = stdout.trim();
    } catch {}
  }

  const scoreBreakdown = `
- Total: ${autoScore.total}/100 (${autoScore.grade})
- Root Cause: ${autoScore.root_cause}/40
- Tool Sequence: ${autoScore.tool_sequence}/30
- Fix Proposed: ${autoScore.fix_proposed}/20
- Efficiency: ${autoScore.efficiency}/10`;

  const optimizePrompt = `You are a skill optimizer for an LLM network engineering evaluation platform.

## Context
A Claude LLM was given a skill document and asked to diagnose a real network fault. It scored poorly. Your job is to analyze WHY it failed and produce an improved version of the skill document that would help it pass.

## The Fault
- ID: ${faultMeta.id || run.fault_id}
- Title: ${faultMeta.title || 'Unknown'}
- Symptom given to LLM: ${faultMeta.symptom || 'Unknown'}
- Ground truth root cause: ${faultMeta.root_cause || 'Unknown'}
- Expected fix command: ${faultMeta.fix_command || 'Unknown'}
- Optimal tool sequence: ${(faultMeta.optimal_tool_sequence || []).join(' → ')}

## Score Breakdown
${scoreBreakdown}

## Current Skill Content
\`\`\`
${skillContent || '(no skill content found)'}
\`\`\`

## LLM Response (what it actually said)
\`\`\`
${(run.llm_response || '').slice(0, 3000)}
\`\`\`

## Analysis Task
1. Identify exactly what information was MISSING from the skill that caused the LLM to fail each scoring dimension
2. Identify any MISLEADING information in the skill that led the LLM in the wrong direction
3. Produce an IMPROVED version of the skill document that would guide the LLM to the correct answer

## Rules for the improved skill
- Keep the same structure and format as the original
- Only add/modify what's necessary — don't rewrite sections that are fine
- Add specific EOS/JunOS command examples relevant to this failure mode
- Add the root cause pattern to the "Common Pitfalls" or equivalent section
- Keep it concise — LLMs perform better with focused, dense skill docs

## Output Format
Respond with a JSON object ONLY (no markdown, no explanation outside JSON):
{
  "analysis": "2-3 sentences explaining why the LLM failed",
  "changes": [
    {"section": "section name", "type": "add|modify|remove", "reason": "why this change helps"},
    ...
  ],
  "improved_skill": "the full improved SKILL.md content"
}`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: optimizePrompt }]
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) throw new Error(data.error?.message || `HTTP ${upstream.status}`);

    const raw = data.content?.[0]?.text || '{}';
    const clean = raw.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
    const result = JSON.parse(clean);

    // Generate a simple line-level diff
    const oldLines = (skillContent || '').split('\n');
    const newLines = (result.improved_skill || '').split('\n');
    result.original_skill = skillContent;
    result.skill_name = faultMeta.skill || run.fault_id;
    result.run_id = run_id;

    audit(req.user.id, 'POST', '/api/skill/optimize', 200, `Optimized skill for run: ${run_id}`);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/skill/:name — write updated skill content back to clab host
app.patch('/api/skill/:name', requireAuth, async (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  const { content, run_id } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });

  try {
    // Write to skills/ cache dir on clab host
    const skillsPath = `${FAULT_DIR}/skills/${name}.md`;
    // Escape content for shell — write via python to avoid quoting issues
    const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\"'\"'");
    const cmd = `python3 -c "open('${skillsPath}', 'w').write('''${escaped}''')"`;
    const { code, stderr } = await sshExec(cmd);
    if (code !== 0) throw new Error(stderr || 'Write failed');

    // Also try to write to the authoritative network-skills directory
    try {
      const netSkillPath = `/home/${process.env.CLAB_USER}/network-skills/${name}/SKILL.md`;
      const { code: code2 } = await sshExec(`test -f "${netSkillPath}" && python3 -c "open('${netSkillPath}', 'w').write('''${escaped}''')" || echo "skip"`);
    } catch {}

    // Commit back to skills repo if configured
    let commit_sha = null;
    if (SKILLS_REPO_PATH && SKILLS_REPO_TOKEN) {
      try {
        // Get score improvement context from run
        const run = db.prepare('SELECT auto_score FROM live_runs WHERE id=?').get(run_id || '');
        const score = run ? JSON.parse(run.auto_score || '{}') : {};

        // Write to the authoritative repo location
        const repoSkillPath = `${SKILLS_REPO_PATH}/.claude/skills/${name}/SKILL.md`;
        const { code: writeCode } = await sshExec(
          `test -d "${SKILLS_REPO_PATH}/.claude/skills/${name}" && python3 -c "open('${repoSkillPath}', 'w').write(open('${FAULT_DIR}/skills/${name}.md').read())" || echo "skip"`
        );

        if (writeCode === 0) {
          const commitMsg = `perf: optimize ${name} — score ${score.total || '?'}/100 (${score.grade || '?'})\n\nAuto-optimized by NetOps Runner skill optimizer.\nRun ID: ${run_id || 'manual'}`;
          const commitCmd = `
            cd "${SKILLS_REPO_PATH}" &&
            git config user.email "netops-runner@local" &&
            git config user.name "NetOps Runner" &&
            git add ".claude/skills/${name}/SKILL.md" &&
            git diff --cached --quiet || (git commit -m "${commitMsg.replace(/"/g, '\"')}" && echo "COMMITTED") 2>&1
          `;
          const { stdout: commitOut } = await sshExec(commitCmd);
          if (commitOut.includes('COMMITTED')) {
            // Push back to repo
            const tokenRepo = SKILLS_REPO.replace('https://', `https://${SKILLS_REPO_TOKEN}@`);
            const { stdout: pushOut } = await sshExec(
              `cd "${SKILLS_REPO_PATH}" && git push "${tokenRepo}" ${SKILLS_REPO_BRANCH} 2>&1`
            );
            commit_sha = pushOut.includes('main') || pushOut.includes('master') ? 'pushed' : 'local_only';
          }
        }
      } catch(gitErr) {
        console.error('Git push failed (non-fatal):', gitErr.message);
      }
    }

    audit(req.user.id, 'PATCH', `/api/skill/${name}`, 200, `Skill updated: ${name} from run: ${run_id}`);
    res.json({ ok: true, skill: name, committed: !!commit_sha, repo_status: commit_sha });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Skills repo sync ─────────────────────────────────────────────────────────

// Helper: sync skills from repo to network-skills dir on clab host
async function syncSkillsFromRepo() {
  if (!SKILLS_REPO || !SKILLS_REPO_PATH || !SKILLS_DIR) {
    return { ok: false, message: 'SKILLS_REPO not configured' };
  }
  const tokenRepo = SKILLS_REPO.replace('https://', `https://${SKILLS_REPO_TOKEN}@`);

  // Clone if not exists, pull if it does
  const cloneOrPull = `
    if [ -d "${SKILLS_REPO_PATH}/.git" ]; then
      cd "${SKILLS_REPO_PATH}" && git pull origin ${SKILLS_REPO_BRANCH} 2>&1
    else
      git clone --depth 1 -b ${SKILLS_REPO_BRANCH} "${tokenRepo}" "${SKILLS_REPO_PATH}" 2>&1
    fi
  `;
  const { stdout: pullOut, code: pullCode } = await sshExec(cloneOrPull);
  if (pullCode !== 0) return { ok: false, message: pullOut };

  // Sync .claude/skills/ → SKILLS_DIR (rsync, preserving structure)
  const syncCmd = `
    mkdir -p "${SKILLS_DIR}" &&
    rsync -a --delete "${SKILLS_REPO_PATH}/.claude/skills/" "${SKILLS_DIR}/" 2>&1
  `;
  const { stdout: syncOut, code: syncCode } = await sshExec(syncCmd);
  if (syncCode !== 0) return { ok: false, message: syncOut };

  // Count skills synced
  const { stdout: countOut } = await sshExec(`ls "${SKILLS_DIR}" | grep -c troubleshooter || echo 0`);
  return { ok: true, message: pullOut.trim().split('\n').slice(-1)[0], skills_count: parseInt(countOut) || 0 };
}

// POST /api/skills/sync — pull latest from repo and sync to clab host (admin only)
app.post('/api/skills/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await syncSkillsFromRepo();
    audit(req.user.id, 'POST', '/api/skills/sync', result.ok ? 200 : 500, result.message);
    result.ok ? res.json(result) : res.status(500).json({ error: result.message });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/skills/status — check repo sync status
app.get('/api/skills/status', requireAuth, async (req, res) => {
  if (!SKILLS_REPO_PATH) return res.json({ configured: false });
  try {
    const { stdout: logOut } = await sshExec(
      `cd "${SKILLS_REPO_PATH}" 2>/dev/null && git log -1 --format="%H %ai %s" 2>/dev/null || echo "not_cloned"`
    );
    const { stdout: countOut } = await sshExec(`ls "${SKILLS_DIR}" 2>/dev/null | grep -c troubleshooter || echo 0`);
    const parts = logOut.trim().split(' ');
    res.json({
      configured: true,
      repo: SKILLS_REPO.replace(/\/\/.*@/, '//'),  // strip token from URL
      branch: SKILLS_REPO_BRANCH,
      last_commit: parts[0] === 'not_cloned' ? null : parts[0]?.slice(0,8),
      last_sync: parts[0] === 'not_cloned' ? null : parts.slice(1, 3).join(' '),
      last_message: parts[0] === 'not_cloned' ? 'Not yet cloned' : parts.slice(3).join(' '),
      skills_count: parseInt(countOut) || 0,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/skill/:name — fetch skill content from clab host
app.get('/api/skill/:name', requireAuth, async (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  try {
    const { stdout, code } = await sshExec(`cat "${FAULT_DIR}/skills/${name}.md" 2>/dev/null`);
    if (code !== 0 || !stdout.trim()) return res.status(404).json({ error: 'Skill not found' });
    res.json({ name, content: stdout });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/faults — list all available fault definitions
app.get('/api/faults', requireAuth, async (req, res) => {
  try {
    const { stdout } = await sshExec(`ls ${FAULT_DIR}/*.json 2>/dev/null`);
    const files = stdout.trim().split('\n').filter(Boolean);
    const faults = [];
    for (const file of files) {
      const { stdout: content } = await sshExec(`cat "${file}"`);
      try { faults.push(JSON.parse(content)); } catch {}
    }
    res.json(faults);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/live/inject — inject a fault into the lab
app.post('/api/live/inject', requireAuth, async (req, res) => {
  const { fault_id } = req.body;
  if (!fault_id || !/^[\w-]+$/.test(fault_id)) return res.status(400).json({ error: 'Invalid fault_id' });

  const runId = nanoid();
  db.prepare("INSERT INTO live_runs (id,user_id,fault_id,status,created_at) VALUES (?,?,?,?,?)")
    .run(runId, req.user.id, fault_id, 'injecting', Date.now());

  try {
    const injectScript = `${FAULT_DIR}/${fault_id}-inject.sh`;
    const { stdout, stderr, code } = await sshExec(`bash "${injectScript}" 2>&1`);

    if (code !== 0) {
      db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('inject_failed', runId);
      return res.status(500).json({ error: 'Inject script failed', detail: stderr || stdout });
    }

    db.prepare("UPDATE live_runs SET status=?,injected_at=? WHERE id=?")
      .run('injected', Date.now(), runId);

    audit(req.user.id, 'POST', '/api/live/inject', 200, `Injected fault: ${fault_id}`);
    res.json({ run_id: runId, output: stdout });
  } catch(e) {
    db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('inject_failed', runId);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/live/run — send LLM the skill + let it run real MCP tools
app.post('/api/live/run', requireAuth, async (req, res) => {
  const { run_id, skill_content, fault_meta, model } = req.body;
  if (!run_id) return res.status(400).json({ error: 'run_id required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY configured' });

  const run = db.prepare('SELECT * FROM live_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'injected') return res.status(400).json({ error: `Run status is ${run.status}, expected injected` });

  db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('running', run_id);
  const startMs = Date.now();

  // Build system prompt from skill + topology context
  const systemPrompt = `You are a senior network engineer troubleshooting a live multi-vendor DC lab.

## Your Skills
${skill_content || 'Use systematic troubleshooting methodology.'}

## Lab Topology
- DC1: Arista cEOS — dc1-spine1 (100.68.0.11), dc1-spine2 (100.68.0.12), dc1-leaf1a (100.68.0.13), dc1-leaf1b (100.68.0.14), dc1-leaf2a (100.68.0.15), dc1-leaf2b (100.68.0.16)
- DC2: Juniper cRPD — dc2-spine1 (100.68.0.21), dc2-spine2 (100.68.0.22), dc2-leaf1a (100.68.0.23), dc2-leaf1b (100.68.0.24), dc2-leaf2a (100.68.0.25), dc2-leaf2b (100.68.0.26)
- WAN/MPLS backbone: Juniper cRPD — pe1 (router-id 10.255.1.1, mgmt 100.68.0.121, AS65000), pe2 (10.255.1.2, mgmt 100.68.0.122, AS65000), p1 (10.255.0.1), p2 (10.255.0.2), p3 (10.255.0.13), p4 (10.255.0.14), p5 (10.255.0.5), p6 (10.255.0.6), rr1 (10.255.2.1, mgmt 100.68.0.101)
- Backbone IGP: OSPF area 0.0.0.0 — pe1/pe2 each connect to 2 P-routers; p5/p6 are hub P-routers connecting to rr1
- Backbone MPLS: LDP targeted sessions (peer loopbacks); MPLS enabled on Linux kernel (platform_labels=65536)
- DC1 eBGP to backbone: dc1-leaf1a (AS65101) peers pe1 via 10.0.1.2/3; dc1-leaf1b (AS65101) peers pe1 via 10.0.1.4/5
- L3VPN: CUSTOMER1 VRF on pe1/pe2, RD 10.255.1.1:100, rr1 as iBGP route reflector
- Campus: Arista cEOS — campus1-spine1/2, campus1-leaf1a/1b/2a/2b, campus2-spine1/2, campus2-leaf1a/1b/2a/2b

## MCP Tools Available
To run commands against devices, use the MCP tool format:
- arista_mcp: python3 ${MCP_CALL} "python3 -u ${CLAB_MCP}" execCommand '{"labName":"multi-site-fabric","nodeName":"<device>","command":"<eos-command>"}'
- juniper_mcp: python3 ${MCP_CALL} "python3 -u ${CLAB_MCP}" execCommand '{"labName":"multi-site-fabric","nodeName":"<device>","command":"<junos-command>"}'
- listLabs: python3 ${MCP_CALL} "python3 -u ${CLAB_MCP}" listLabs '{}'

## How to Query Live Devices

You have access to run commands directly on lab devices. Include commands in your response like this:

**For Arista EOS nodes** (dc1-spine1, dc1-spine2, dc1-leaf1a/1b/2a/2b):
  docker exec clab-multi-site-fabric-<node> Cli -c "enable
show bgp evpn summary"

**For Juniper cRPD nodes** (dc2-*, pe1, pe2, p1-p6, rr1):
  docker exec clab-multi-site-fabric-<node> cli -c "show ospf neighbor"

The scoring system will match which commands you use against the expected diagnostic workflow.

## Instructions
1. A fault has been injected. Work through your skill diagnostic workflow step by step.
2. State your hypothesis at each step and which command you would run to confirm it.
3. Based on the symptom, identify the most likely root cause.
4. Propose the exact CLI fix command (DO NOT apply configuration changes).
5. Format output using the skill Output template.

DO NOT apply configuration changes. Propose only.`;

  const userPrompt = `A fault has been injected somewhere in the lab. The affected device is ${fault_meta?.device || 'unknown'} (${fault_meta?.mgmt_ip || ''}). 
The symptom reported is: "${fault_meta?.symptom || 'degraded network operation'}".

Use your diagnostic skill to identify the root cause and propose a fix.`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const data = await upstream.json();
    if (!upstream.ok) throw new Error(data.error?.message || `HTTP ${upstream.status}`);

    const llmResponse = data.content?.[0]?.text || '';
    const durationMs = Date.now() - startMs;

    // Extract tool calls from LLM response text
    const toolCalls = [];
    const seen = new Set();
    const addCmd = (cmd, type) => {
      const key = cmd.replace(/\s+/g,' ').split(' ').slice(0,5).join(' ').toLowerCase();
      if (!seen.has(key) && cmd.length > 3) { seen.add(key); toolCalls.push({ command: cmd.trim(), type }); }
    };
    // Match docker exec with multiline -c content (Arista: Cli -c "enable\nshow...", Juniper: cli -c "show...")
    const dockerRe = /docker exec[^\n]+?(?:Cli|cli)[^\n]*?-c[\s\S]{0,10}?"([^"]{4,200})"/gi;
    for (const m of llmResponse.matchAll(dockerRe)) {
      // Extract actual show commands from within the exec string
      const inner = m[1].replace(/\\n/g,'\n');
      for (const line of inner.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('show ')) addCmd(trimmed, 'docker_exec');
      }
      addCmd(inner.split('\n').filter(l=>l.trim().startsWith('show '))[0] || inner, 'docker_exec');
    }
    // Match backtick show commands
    for (const m of llmResponse.matchAll(/`(show [^`\n]{3,80})`/g))
      addCmd(m[1].trim(), 'backtick');
    // Match show commands in code blocks (``` bash blocks)
    for (const m of llmResponse.matchAll(/```[\s\S]*?```/g)) {
      const block = m[0];
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (t.startsWith('show ') && t.length < 80) addCmd(t, 'code_block');
      }
    }
    // Match bare show commands in text lines
    for (const m of llmResponse.matchAll(/^\s{0,6}(show (?:bgp|ospf|ldp|isis|bfd|vxlan|route|ip|interface|mpls)[^\n]{0,60})$/gm))
      addCmd(m[1].trim(), 'text_line');

    // Auto-score
    const autoScore = scoreResponse(llmResponse, toolCalls, fault_meta || {});

    db.prepare("UPDATE live_runs SET status=?,llm_response=?,tool_calls=?,auto_score=?,duration_ms=? WHERE id=?")
      .run('complete', llmResponse, JSON.stringify(toolCalls), JSON.stringify(autoScore), durationMs, run_id);

    audit(req.user.id, 'POST', '/api/live/run', 200, `Live run complete: ${run_id} score=${autoScore.total}`);
    res.json({ llm_response: llmResponse, tool_calls: toolCalls, auto_score: autoScore, duration_ms: durationMs });

  } catch(e) {
    db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('run_failed', run_id);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/live/restore — restore lab to clean state
app.post('/api/live/restore', requireAuth, async (req, res) => {
  const { run_id } = req.body;
  const run = db.prepare('SELECT * FROM live_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    const restoreScript = `${FAULT_DIR}/${run.fault_id}-restore.sh`;
    const { stdout, code } = await sshExec(`bash "${restoreScript}" 2>&1`);
    if (code !== 0) return res.status(500).json({ error: 'Restore failed', detail: stdout });
    db.prepare("UPDATE live_runs SET status=?,restored_at=? WHERE id=?").run('restored', Date.now(), run_id);
    audit(req.user.id, 'POST', '/api/live/restore', 200, `Restored fault: ${run.fault_id}`);
    res.json({ ok: true, output: stdout });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/live/runs — user's live test history
app.get('/api/live/runs', requireAuth, (req, res) => {
  const runs = db.prepare('SELECT * FROM live_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  runs.forEach(r => {
    try { r.auto_score = JSON.parse(r.auto_score); } catch {}
    try { r.tool_calls = JSON.parse(r.tool_calls); } catch {}
  });
  res.json(runs);
});

// GET /api/live/leaderboard — top scores across all users
app.get('/api/live/leaderboard', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.display_name, l.fault_id, l.auto_score, l.duration_ms, l.created_at
    FROM live_runs l JOIN users u ON u.id=l.user_id
    WHERE l.status='complete' ORDER BY l.created_at DESC LIMIT 50
  `).all();
  rows.forEach(r => { try { r.auto_score = JSON.parse(r.auto_score); } catch {} });
  res.json(rows);
});

// ── Admin routes ─────────────────────────────────────────────────────────────
app.get('/api/admin/tokens', requireAuth, requireAdmin, adminLimiter, (req, res) =>
  res.json(db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all()));

app.post('/api/admin/tokens', requireAuth, requireAdmin, adminLimiter, (req, res) => {
  const { label, count } = req.body;
  if (!label) return res.status(400).json({ error: 'label required' });
  const n = Math.min(parseInt(count)||1, 50);
  const created = [];
  const stmt = db.prepare("INSERT INTO tokens (id,label,created_at) VALUES (?,?,?)");
  for (let i=0; i<n; i++) {
    const tid = 'NETOPS-'+nanoid(4).toUpperCase()+'-'+nanoid(4).toUpperCase();
    stmt.run(tid, n>1?`${label} #${i+1}`:label, Date.now());
    created.push(tid);
  }
  res.json({ created });
});

app.delete('/api/admin/tokens/:id', requireAuth, requireAdmin, adminLimiter, (req, res) => {
  db.prepare('UPDATE tokens SET revoked=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, adminLimiter, (req, res) => {
  res.json(db.prepare(`SELECT u.*,COUNT(r.id) as result_count,MAX(s.last_seen) as last_active
    FROM users u LEFT JOIN results r ON r.user_id=u.id LEFT JOIN sessions s ON s.user_id=u.id
    GROUP BY u.id ORDER BY u.joined_at DESC`).all());
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, adminLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM results WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
  db.prepare('UPDATE tokens SET revoked=1 WHERE id=?').run(user.token_id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAuth, requireAdmin, adminLimiter, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="netops-export-${Date.now()}.json"`);
  res.json({
    exported_at: Date.now(),
    tokens: db.prepare('SELECT * FROM tokens').all(),
    users: db.prepare('SELECT * FROM users').all(),
    results: db.prepare('SELECT * FROM results').all(),
    live_runs: db.prepare('SELECT * FROM live_runs').all()
  });
});

app.get('/api/admin/audit', requireAuth, requireAdmin, adminLimiter, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||200, 1000);
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit));
});

app.listen(PORT, () => console.log(`netops-runner v2 backend on :${PORT}`));