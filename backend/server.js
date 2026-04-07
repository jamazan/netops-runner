import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { NodeSSH } from 'node-ssh';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, '../data/netops.db');
const PORT       = parseInt(process.env.PORT || '3001');
const BCRYPT_ROUNDS   = 12;
const SESSION_SECRET  = process.env.SESSION_SECRET || 'netops-runner-secret-change-me';
const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

const CLAB_HOST      = process.env.CLAB_HOST      || '10.0.0.71';
const CLAB_USER      = process.env.CLAB_USER      || 'jamazan';
const CLAB_KEY       = process.env.CLAB_KEY       || '/app/ssh/server';
const FAULT_DIR      = process.env.FAULT_DIR      || '/home/jamazan/netops-faults';
const LOCAL_SKILLS_DIR = process.env.LOCAL_SKILLS_DIR || '/app/faults/skills';
const CEOS_MCP_URL   = process.env.CEOS_MCP_URL   || 'http://10.0.0.71:8085';
const CRPD_MCP_URL   = process.env.CRPD_MCP_URL   || 'http://10.0.0.71:8084';
const SKILLS_MCP_URL = process.env.SKILLS_MCP_URL || 'http://10.0.0.71:8083';
const SKILLS_REPO      = process.env.SKILLS_REPO      || '';
const SKILLS_REPO_PATH = process.env.SKILLS_REPO_PATH || '';
const SKILLS_DIR       = process.env.SKILLS_DIR       || '';
const SKILLS_REPO_TOKEN  = process.env.SKILLS_REPO_TOKEN  || '';
const SKILLS_REPO_BRANCH = process.env.SKILLS_REPO_BRANCH || 'main';
const OLLAMA_BASE_URL    = process.env.OLLAMA_BASE_URL    || 'http://10.0.0.58:11434';
const CLAB_LAB_NAME      = process.env.CLAB_LAB_NAME      || 'multi-site-fabric';

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://10.0.0.43:8080','http://localhost:8080','https://lab-tester.amazan.me'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, last_login INTEGER
  );
  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, test_id TEXT NOT NULL,
    score TEXT NOT NULL, notes TEXT, criteria TEXT, llm_response TEXT,
    auto_score TEXT, saved_at INTEGER NOT NULL, UNIQUE(user_id,test_id)
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

// Migrate: add must_change_password if missing, rename old roles
try { db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("UPDATE users SET role='user' WHERE role='student' OR role='teacher'"); } catch {}

const firstAdmin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!firstAdmin) {
  const adminPw = process.env.ADMIN_PASSWORD || 'changeme';
  db.prepare("INSERT INTO users (id,username,pw_hash,role,created_at,must_change_password) VALUES (?,?,?,?,?,?)")
    .run(nanoid(), 'admin', bcrypt.hashSync(adminPw, BCRYPT_ROUNDS), 'admin', Date.now(), 0);
  console.log(`\n[boot] Default admin created — username: admin  password: ${adminPw}\n`);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  name: 'netops_session', cookie: { httpOnly: true, sameSite: 'lax', maxAge: IDLE_TIMEOUT_MS }
}));

const authLimiter  = rateLimit({ windowMs: 15*60*1000, max: 30 });
const adminLimiter = rateLimit({ windowMs: 10*60*1000, max: 60 });

function audit(userId, method, p, status, note) {
  try { db.prepare("INSERT INTO audit_log (id,ts,user_id,method,path,status,note) VALUES (?,?,?,?,?,?,?)")
    .run(nanoid(), Date.now(), userId||null, method, p, status||null, note||null); } catch {}
}

function validatePassword(pw) {
  if (!pw || pw.length < 10)  return 'Password must be at least 10 characters';
  if (!/[A-Z]/.test(pw))     return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(pw))     return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(pw))     return 'Password must contain a number';
  return null;
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) { req.session.destroy(()=>{}); return res.status(401).json({ error: 'User not found' }); }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.pw_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), user.id);
  req.session.userId = user.id;
  audit(user.id,'POST','/api/auth/login',200,'Login');
  res.json({ ok: true, username: user.username, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('netops_session'); res.json({ ok: true }); });
});

app.get('/api/auth/status', (req, res) => {
  if (!req.session?.userId) return res.json({ authenticated: false });
  const user = db.prepare('SELECT id,username,role,must_change_password FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: user.username, role: user.role, must_change_password: !!user.must_change_password });
});

app.get('/api/me', requireAuth, (req, res) =>
  res.json({ id:req.user.id, username:req.user.username, role:req.user.role,
             is_admin: req.user.role==='admin', display_name: req.user.username, must_change_password: !!req.user.must_change_password }));

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  // If must_change_password is set (first login / admin reset), skip current password check
  if (!req.user.must_change_password) {
    if (!current_password) return res.status(400).json({ error: 'current_password required' });
    if (!bcrypt.compareSync(current_password, req.user.pw_hash))
      return res.status(401).json({ error: 'Current password incorrect' });
  }
  const err = validatePassword(new_password);
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE users SET pw_hash=?, must_change_password=0 WHERE id=?')
    .run(bcrypt.hashSync(new_password, BCRYPT_ROUNDS), req.user.id);
  res.json({ ok: true });
});

// ── Admin user management ────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, adminLimiter, (req, res) => {
  const users = db.prepare(`SELECT u.id, u.username, u.role, u.created_at, u.last_login,
    COUNT(r.id) as result_count, MAX(lr.created_at) as last_run
    FROM users u LEFT JOIN results r ON r.user_id=u.id LEFT JOIN live_runs lr ON lr.user_id=u.id
    GROUP BY u.id ORDER BY u.created_at`).all();
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, adminLimiter, (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'username required' });
  const validRoles = ['admin','user'];
  const userRole = validRoles.includes(role) ? role : 'user';
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username.trim().toLowerCase()))
    return res.status(400).json({ error: 'Username already taken' });
  const defaultPw = password?.trim() || 'changeme';
  const id = nanoid();
  db.prepare("INSERT INTO users (id,username,pw_hash,role,created_at,must_change_password) VALUES (?,?,?,?,?,?)")
    .run(id, username.trim().toLowerCase(), bcrypt.hashSync(defaultPw, BCRYPT_ROUNDS), userRole, Date.now(), 1);
  audit(req.user.id,'POST','/api/admin/users',200,`Created: ${username}`);
  res.json({ ok: true, id, username: username.trim().toLowerCase(), role: userRole });
});

app.patch('/api/admin/users/:id/role', requireAdmin, adminLimiter, (req, res) => {
  const { role } = req.body;
  if (!['admin','user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id/password', requireAdmin, adminLimiter, (req, res) => {
  const { new_password } = req.body;
  const err = validatePassword(new_password || '');
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE users SET pw_hash=?, must_change_password=1 WHERE id=?')
    .run(bcrypt.hashSync(new_password, BCRYPT_ROUNDS), req.params.id);
  audit(req.user.id,'PATCH',`/api/admin/users/${req.params.id}/password`,200,'Reset pw');
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, adminLimiter, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM results WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM live_runs WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  audit(req.user.id,'DELETE',`/api/admin/users/${req.params.id}`,200,`Deleted: ${target.username}`);
  res.json({ ok: true });
});

app.get('/api/admin/export', requireAdmin, adminLimiter, (req, res) => {
  res.setHeader('Content-Disposition',`attachment; filename="netops-export-${Date.now()}.json"`);
  res.json({ exported_at: Date.now(),
    users: db.prepare('SELECT id,username,role,created_at,last_login FROM users').all(),
    results: db.prepare('SELECT * FROM results').all(),
    live_runs: db.prepare('SELECT * FROM live_runs').all() });
});

app.get('/api/admin/audit', requireAdmin, adminLimiter, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||200, 1000);
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit));
});

// ── SSH helper ────────────────────────────────────────────────────────────────
async function sshExec(command, host=CLAB_HOST, user=CLAB_USER) {
  const ssh = new NodeSSH();
  await ssh.connect({ host, username:user, privateKeyPath:CLAB_KEY, readyTimeout:10000 });
  const result = await ssh.execCommand(command, { execOptions:{ pty:false } });
  ssh.dispose();
  return { stdout:result.stdout, stderr:result.stderr, code:result.code };
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function scoreResponse(llmResponse, toolCalls, faultMeta) {
  const text  = (llmResponse||'').toLowerCase();
  const calls = toolCalls||[];
  const scores = {};

  // Root cause: 35pts (keyword match)
  const rcKw = (faultMeta.root_cause||'').toLowerCase().split(/[\s,]+/).filter(w=>w.length>4);
  scores.root_cause = Math.round((rcKw.filter(kw=>text.includes(kw)).length / Math.max(rcKw.length,1)) * 35);

  // Tool sequence: 25pts (optimal tool match)
  const optimal   = faultMeta.optimal_tool_sequence||[];
  const usedTools = calls.map(c=>(c.command||c.tool||'').toLowerCase());
  let toolMatches = 0;
  for (const opt of optimal) {
    const ol = opt.toLowerCase();
    if (usedTools.some(u => u===ol || u.includes(ol.replace('get_','').replace('_health','')))) toolMatches++;
  }
  scores.tool_sequence = Math.round((toolMatches / Math.max(optimal.length,1)) * 25);

  // Fix proposed: 20pts (fix keyword match)
  const fixKw = (faultMeta.fix_command||'').toLowerCase().split(/[\s,]+/).filter(w=>w.length>3);
  scores.fix_proposed = Math.round((fixKw.filter(kw=>text.includes(kw)).length / Math.max(fixKw.length,1)) * 20);

  // Efficiency: 10pts
  const optCount = optimal.length+1, actualCount = calls.length;
  scores.efficiency = actualCount===0 ? 0 : actualCount<=optCount ? 10 : actualCount<=optCount*2 ? 7 : 4;

  // Skill activation: 10pts (NEW — did the right skills get read_skill()-called?)
  const expectedSkills = faultMeta.expected_skills || [];
  const skillsRead = calls
    .filter(c => c.command === 'read_skill')
    .map(c => (c.node || '').toLowerCase());
  if (expectedSkills.length === 0) {
    scores.skill_activation = 10; // no expectation defined, full credit
  } else {
    const matches = expectedSkills.filter(e =>
      skillsRead.some(s => s === e.toLowerCase() || s.includes(e.toLowerCase()) || e.toLowerCase().includes(s))
    );
    const ratio = matches.length / expectedSkills.length;
    scores.skill_activation = ratio >= 1.0 ? 10 : ratio >= 0.5 ? 6 : ratio > 0 ? 3 : 0;
  }

  scores.total = scores.root_cause + scores.tool_sequence + scores.fix_proposed
               + scores.efficiency + scores.skill_activation;
  scores.grade = scores.total>=80 ? 'PASS' : scores.total>=50 ? 'PARTIAL' : 'FAIL';

  // Separate pass/fail dimensions (Step 3)
  scores.quality_pass = scores.total >= 80;
  scores.time_pass    = null; // populated by caller with duration
  scores.token_pass   = true; // placeholder until token counting added
  scores.overall      = scores.quality_pass; // AND of all three once all implemented

  // ── EVPN NOC 3-part grading (trigger + chain + output) ──────────────────
  // Extracts SKILLS_INVOKED line from the LLM response and compares against
  // expected_skills and must_not_invoke from the fault JSON.
  const rawText = llmResponse || '';
  const skillsMatch = rawText.match(/SKILLS_INVOKED:\s*(.+)/i);
  if (skillsMatch && faultMeta.expected_skills) {
    // Parse actual skills from SKILLS_INVOKED line
    const invokedRaw = skillsMatch[1].trim();
    const actual = invokedRaw.split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const expected = (faultMeta.expected_skills || []).map(s => s.toLowerCase());
    const mustNot  = (faultMeta.must_not_invoke || []).map(s => s.toLowerCase());

    // Trigger: recall + precision
    const missing     = expected.filter(e => !actual.includes(e));
    const falsePos    = mustNot.filter(m => actual.includes(m));
    scores.trigger_pass      = missing.length === 0 && falsePos.length === 0;
    scores.trigger_recall    = expected.length > 0 ? (expected.length - missing.length) / expected.length : 1;
    scores.trigger_precision = mustNot.length === 0 ? 1 : (mustNot.length - falsePos.length) / mustNot.length;
    scores.trigger_missing   = missing;
    scores.trigger_fp        = falsePos;

    // Chain: correct relative ordering of skills that fired
    const actualOrdered   = actual.filter(s => expected.includes(s));
    const expectedFiltered = expected.filter(s => actual.includes(s));
    scores.chain_pass = JSON.stringify(actualOrdered) === JSON.stringify(expectedFiltered);
    scores.chain_actual   = actualOrdered;
    scores.chain_expected = expectedFiltered;

    // Boost/penalise total score based on trigger+chain
    if (scores.trigger_pass && scores.chain_pass) {
      scores.total = Math.min(100, scores.total + 10);  // bonus: full skill compliance
    } else if (!scores.trigger_pass) {
      scores.total = Math.max(0, scores.total - 20);    // penalty: wrong skills fired
    }
    scores.total = Math.min(100, scores.total);
    scores.grade = scores.total>=80 ? 'PASS' : scores.total>=50 ? 'PARTIAL' : 'FAIL';
  }

  return scores;
}

// ── Knowledge test results ────────────────────────────────────────────────────
app.post('/api/results', requireAuth, (req, res) => {
  const { test_id, score, notes, criteria, llm_response, auto_score } = req.body;
  if (!test_id || !/^[\w\-.:]+$/.test(test_id) || test_id.length>120)
    return res.status(400).json({ error: 'Invalid test_id' });
  db.prepare(`INSERT INTO results (id,user_id,test_id,score,notes,criteria,llm_response,auto_score,saved_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,test_id) DO UPDATE SET
    score=excluded.score, notes=excluded.notes, criteria=excluded.criteria,
    llm_response=excluded.llm_response, auto_score=excluded.auto_score, saved_at=excluded.saved_at`)
    .run(nanoid(), req.user.id, test_id, score, notes||null,
      typeof criteria==='object'?JSON.stringify(criteria):criteria||null, llm_response||null,
      typeof auto_score==='object'?JSON.stringify(auto_score):auto_score||null, Date.now());
  res.json({ ok: true });
});

app.get('/api/results', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM results WHERE user_id=? ORDER BY saved_at DESC').all(req.user.id);
  rows.forEach(r => { try { r.criteria=JSON.parse(r.criteria); } catch {} });
  res.json(rows);
});

app.post('/api/run-test', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY configured' });
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify(req.body)
    });
    res.status(upstream.status).json(await upstream.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/score-response', requireAuth, async (req, res) => {
  const { llm_response, criteria } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY configured' });
  if (!llm_response || !criteria?.length) return res.status(400).json({ error: 'llm_response and criteria required' });
  const criteriaText = criteria.map((c,i) => `${i+1}. [${c.weight.toUpperCase()}] ${c.text}`).join('\n');
  const prompt = `You are evaluating an LLM response to a network engineering test.
PASS CRITERIA:\n${criteriaText}\nLLM RESPONSE:\n${llm_response.slice(0,3000)}
Respond ONLY with valid JSON: {"criteria_results":[{"index":1,"met":true,"note":"reason"}],"required_met":2,"required_total":3,"bonus_met":1,"score":"PASS","confidence":"high","summary":"one sentence"}`;
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:512,
        messages:[{role:'user',content:prompt}] })
    });
    const data = await upstream.json();
    if (!upstream.ok) throw new Error(data.error?.message||`HTTP ${upstream.status}`);
    res.json({ auto_score: JSON.parse(data.content?.[0]?.text?.replace(/```json|```/g,'')||'{}') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Skill loading ─────────────────────────────────────────────────────────────
// Priority: 1) netops-faults/skills/{name}.md  (optimizer patches land here — wins if present)
//           2) network-skills/{name}/SKILL.md   (authoritative 54-skill library)
//           3) container bundled fallback
app.get('/api/skill/:name', requireAuth, async (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  try {
    const { stdout, code } = await sshExec(`cat "${FAULT_DIR}/skills/${name}.md" 2>/dev/null`);
    if (code===0 && stdout.trim()) return res.json({ name, content:stdout, source:'patched' });
  } catch(e) {}
  try {
    const { stdout, code } = await sshExec(`cat "/home/${CLAB_USER}/network-skills/${name}/SKILL.md" 2>/dev/null`);
    if (code===0 && stdout.trim()) return res.json({ name, content:stdout, source:'network-skills' });
  } catch(e) {}
  try {
    const localPath = `${LOCAL_SKILLS_DIR}/${name}.md`;
    if (fs.existsSync(localPath)) return res.json({ name, content:fs.readFileSync(localPath,'utf8'), source:'bundled' });
  } catch(e) {}
  res.status(404).json({ error: `Skill not found: ${name}` });
});

// Optimizer writes patch to BOTH locations so next GET picks it up immediately
app.patch('/api/skill/:name', requireAuth, async (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  const { content, run_id } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  try {
    const b64 = Buffer.from(content).toString('base64');
    // 1. Write to patched cache (fast, always works)
    await sshExec(`mkdir -p "${FAULT_DIR}/skills" && echo '${b64}' | base64 -d > "${FAULT_DIR}/skills/${name}.md"`);
    // 2. Write to authoritative network-skills dir (GET reads this next time if no patch)
    try {
      const netDir  = `/home/${CLAB_USER}/network-skills/${name}`;
      await sshExec(`mkdir -p "${netDir}" && echo '${b64}' | base64 -d > "${netDir}/SKILL.md"`);
      console.log(`[skill patch] updated network-skills/${name}/SKILL.md`);
    } catch(we) { console.error('network-skills write (non-fatal):', we.message); }
    // 3. Git push to skills repo if configured
    let commit_sha = null;
    if (SKILLS_REPO_PATH && SKILLS_REPO_TOKEN) {
      try {
        const run   = db.prepare('SELECT auto_score FROM live_runs WHERE id=?').get(run_id||'');
        const score = run ? JSON.parse(run.auto_score||'{}') : {};
        const repoPath = `${SKILLS_REPO_PATH}/.claude/skills/${name}/SKILL.md`;
        const { code: wc } = await sshExec(
          `test -d "${SKILLS_REPO_PATH}/.claude/skills/${name}" && cp "${FAULT_DIR}/skills/${name}.md" "${repoPath}" || echo skip`);
        if (wc===0) {
          const msg = `perf: optimize ${name} score=${score.total||'?'}/100 run=${run_id||'manual'}`;
          const { stdout: co } = await sshExec(
            `cd "${SKILLS_REPO_PATH}" && git config user.email "netops@local" && git config user.name "NetOps Runner" && git add ".claude/skills/${name}/SKILL.md" && git diff --cached --quiet || (git commit -m "${msg}" && echo COMMITTED) 2>&1`);
          if (co.includes('COMMITTED')) {
            const tokenRepo = SKILLS_REPO.replace('https://',`https://${SKILLS_REPO_TOKEN}@`);
            await sshExec(`cd "${SKILLS_REPO_PATH}" && git push "${tokenRepo}" ${SKILLS_REPO_BRANCH} 2>&1`);
            commit_sha = 'pushed';
          }
        }
      } catch(gitErr) { console.error('Git push (non-fatal):', gitErr.message); }
    }
    audit(req.user.id,'PATCH',`/api/skill/${name}`,200,`Patched: ${name} run:${run_id}`);
    res.json({ ok:true, skill:name, committed:!!commit_sha, repo_status:commit_sha });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Skills repo sync
async function syncSkillsFromRepo() {
  if (!SKILLS_REPO || !SKILLS_REPO_PATH || !SKILLS_DIR) return { ok:false, message:'Not configured' };
  const tokenRepo = SKILLS_REPO.replace('https://',`https://${SKILLS_REPO_TOKEN}@`);
  const { stdout:pullOut, code:pullCode } = await sshExec(
    `if [ -d "${SKILLS_REPO_PATH}/.git" ]; then cd "${SKILLS_REPO_PATH}" && git pull origin ${SKILLS_REPO_BRANCH} 2>&1; else git clone --depth 1 -b ${SKILLS_REPO_BRANCH} "${tokenRepo}" "${SKILLS_REPO_PATH}" 2>&1; fi`);
  if (pullCode!==0) return { ok:false, message:pullOut };
  const { stdout:syncOut, code:syncCode } = await sshExec(
    `mkdir -p "${SKILLS_DIR}" && rsync -a --delete "${SKILLS_REPO_PATH}/.claude/skills/" "${SKILLS_DIR}/" 2>&1`);
  if (syncCode!==0) return { ok:false, message:syncOut };
  const { stdout:cnt } = await sshExec(`ls "${SKILLS_DIR}" | wc -l`);
  return { ok:true, message:pullOut.trim().split('\n').slice(-1)[0], skills_count:parseInt(cnt)||0 };
}

app.post('/api/skills/sync', requireAdmin, async (req, res) => {
  try {
    const result = await syncSkillsFromRepo();
    audit(req.user.id,'POST','/api/skills/sync',result.ok?200:500,result.message);
    result.ok ? res.json(result) : res.status(500).json({ error:result.message });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/skills/status', requireAuth, async (req, res) => {
  if (!SKILLS_REPO_PATH) return res.json({ configured:false });
  try {
    const { stdout:logOut } = await sshExec(`cd "${SKILLS_REPO_PATH}" 2>/dev/null && git log -1 --format="%H %ai %s" 2>/dev/null || echo not_cloned`);
    const { stdout:cnt } = await sshExec(`ls "${SKILLS_DIR}" 2>/dev/null | wc -l`);
    const parts = logOut.trim().split(' ');
    res.json({ configured:true, repo:SKILLS_REPO.replace(/\/\/.*@/,'//'), branch:SKILLS_REPO_BRANCH,
      last_commit: parts[0]==='not_cloned'?null:parts[0]?.slice(0,8),
      last_sync:   parts[0]==='not_cloned'?null:parts.slice(1,3).join(' '),
      last_message:parts[0]==='not_cloned'?'Not yet cloned':parts.slice(3).join(' '),
      skills_count: parseInt(cnt)||0 });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Faults ────────────────────────────────────────────────────────────────────
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Live fault inject / run / restore ────────────────────────────────────────
app.post('/api/live/inject', requireAuth, async (req, res) => {
  const { fault_id } = req.body;
  if (!fault_id || !/^[\w-]+$/.test(fault_id)) return res.status(400).json({ error:'Invalid fault_id' });
  const runId = nanoid();
  db.prepare("INSERT INTO live_runs (id,user_id,fault_id,status,created_at) VALUES (?,?,?,?,?)")
    .run(runId, req.user.id, fault_id, 'injecting', Date.now());
  try {
    const { stdout, stderr, code } = await sshExec(`bash "${FAULT_DIR}/${fault_id}-inject.sh" 2>&1`);
    if (code!==0) {
      db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('inject_failed', runId);
      return res.status(500).json({ error:'Inject script failed', detail:stderr||stdout });
    }
    db.prepare("UPDATE live_runs SET status=?,injected_at=? WHERE id=?").run('injected',Date.now(),runId);
    audit(req.user.id,'POST','/api/live/inject',200,`Injected: ${fault_id}`);
    res.json({ run_id:runId, output:stdout });
  } catch(e) {
    db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('inject_failed',runId);
    res.status(500).json({ error:e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared diagnostic engine — used by /api/live/run AND /api/eval/suite/run
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the system prompt for a diagnostic run.
 */
function buildSystemPrompt(fault_meta, skillIndex) {
  const faultVendor = fault_meta?.vendor || (
    /^dc1-|^campus/.test(fault_meta?.device||'') ? 'arista' : 'juniper'
  );
  return `You are a senior network engineer working a live network ticket.
Your job: choose the right skill, read it, then diagnose the fault with live tools.

## Lab
Lab: ${CLAB_LAB_NAME}  |  Device: ${fault_meta?.device||'unknown'}  |  Vendor: ${faultVendor}
Call list_nodes() to see all devices.

## Workflow — FOLLOW THIS ORDER
1. If **noc-triage** is in the skill catalog, call read_skill(noc-triage) FIRST.
2. Otherwise pick the best matching orchestrator-* skill and read it first.
3. Follow the skill's phased workflow exactly. Do NOT skip phases.
4. Identify the exact misconfiguration from tool output.
5. Propose fix CLI (READ-ONLY — do NOT apply config).

Aim for 6-10 total tool calls as directed by the triage skill.

## Skill Catalog
${skillIndex}

## Tools
list_skills() — Refresh the catalog.
read_skill(name) — Load a full skill. ALWAYS call before diagnostics.
list_nodes() — List all lab nodes.
get_bgp_health(node) — BGP sessions, neighbor detail, policy.
get_overlay_health(node) — EVPN/VXLAN overlay (Arista).
get_underlay_health(node) — Interfaces, IP BGP, routes (Arista).
get_bfd_health(node) — BFD session states.
get_hardware_health(node) — CPU, memory, uptime.
get_ospf_health(node) — OSPF adjacency, LSDB (Juniper).
get_ldp_mpls_health(node) — LDP sessions, MPLS table (Juniper).
get_evpn_health(node) — EVPN database, RT config (Juniper).
get_l3vpn_health(node) — VPN instances, VPNv4 table (Juniper).
ping(node, destination, [source], [vrf]) — Test reachability.
run_command(node, command) — Any show command.`;
}

/**
 * Core diagnostic loop: build prompt, run agentic LLM loop with real tools.
 * Does NOT touch DB, inject, or restore faults.
 * Returns { llmResponse, toolCalls, skillsFired, durationMs }.
 */
async function runDiagnostic(fault_meta, model, apiKey, customUserPrompt) {
  const startMs = Date.now();

  // Build skill index
  let skillIndex = '';
  try {
    const { stdout: skillDirs } = await sshExec(`ls /home/${CLAB_USER}/network-skills/`);
    const skillNames = skillDirs.trim().split('\n').filter(Boolean);
    const lines = [];
    for (const sn of skillNames) {
      const { stdout: head } = await sshExec(
        `head -20 /home/${CLAB_USER}/network-skills/${sn}/SKILL.md 2>/dev/null`
      );
      const dm = head.match(/^description:\s*>?\s*\n?(.*)/m);
      lines.push(`- **${sn}**: ${dm ? dm[1].trim().slice(0,100) : 'Troubleshooting skill'}`);
    }
    skillIndex = lines.join('\n');
  } catch(e) { skillIndex = '(use list_skills tool to refresh)'; }

  const systemPrompt = buildSystemPrompt(fault_meta, skillIndex);

  const defaultUserPrompt = `Network ticket:
Device: ${fault_meta?.device||'unknown'} (${fault_meta?.mgmt_ip||''})
Symptom: "${fault_meta?.symptom||'degraded network operation'}"
Skill assigned: ${fault_meta?.skill||'general'}

Troubleshoot this fault. Call your diagnostic tools, identify the root cause, and propose a fix.`;
  const userPrompt = (customUserPrompt && customUserPrompt.trim()) ? customUserPrompt.trim() : defaultUserPrompt;

  const toolCalls = [];
  const skillsFired = [];
  let llmResponse = '';

  // ── Tool executor ──────────────────────────────────────────────────────────
  async function execTool(toolName, input) {
    const node = input.node || input.device || '';
    const LAB  = CLAB_LAB_NAME;
    const ctr  = `clab-${LAB}-${node}`;
    const nodeFaultVendor = fault_meta?.vendor || fault_meta?.platform
      || (/^dc1-|^campus/.test(node) ? 'arista' : 'juniper');
    const isAristaNode = nodeFaultVendor === 'arista' || nodeFaultVendor === 'ceos';
    const cli = isAristaNode ? 'Cli -p 15' : 'cli';

    if (toolName === 'list_skills') {
      try {
        const { stdout } = await sshExec(`ls /home/${CLAB_USER}/network-skills/`);
        const names = stdout.trim().split('\n').filter(Boolean);
        const skills = [];
        for (const name of names) {
          const { stdout: head } = await sshExec(
            `head -20 /home/${CLAB_USER}/network-skills/${name}/SKILL.md 2>/dev/null`
          );
          const dm = head.match(/^description:\s*>?\s*\n?(.*)/m);
          skills.push({ name, description: dm ? dm[1].trim() : '' });
        }
        return JSON.stringify({ skills });
      } catch(e) { return JSON.stringify({ error: e.message }); }
    }

    if (toolName === 'read_skill') {
      const sname = input.name || '';
      if (!/^[\w-]+$/.test(sname)) return JSON.stringify({ error: 'Invalid skill name' });
      try {
        const { stdout: p1, code: c1 } = await sshExec(`cat "${FAULT_DIR}/skills/${sname}.md" 2>/dev/null`);
        if (c1===0 && p1.trim()) return JSON.stringify({ name:sname, content:p1, source:'patched' });
        const { stdout: p2, code: c2 } = await sshExec(`cat "/home/${CLAB_USER}/network-skills/${sname}/SKILL.md" 2>/dev/null`);
        if (c2===0 && p2.trim()) return JSON.stringify({ name:sname, content:p2, source:'network-skills' });
        return JSON.stringify({ error: `Skill not found: ${sname}` });
      } catch(e) { return JSON.stringify({ error: e.message }); }
    }

    if (toolName === 'list_nodes') {
      try {
        const { stdout } = await sshExec(
          `docker ps --format '{{.Names}}\t{{.Image}}' --filter 'name=clab-${LAB}-'`
        );
        const nodes = { arista: [], juniper: [], other: [] };
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [name, image] = line.split('\t');
          const nodeName = name.replace(`clab-${LAB}-`, '');
          if (image && image.includes('ceos')) nodes.arista.push(nodeName);
          else if (image && image.includes('crpd')) nodes.juniper.push(nodeName);
          else nodes.other.push(nodeName);
        }
        return JSON.stringify({ lab: LAB, nodes });
      } catch(e) { return JSON.stringify({ lab: LAB, error: e.message }); }
    }

    if (toolName === 'ping') {
      const dest = input.destination || '';
      const cnt  = input.count || 5;
      const src  = input.source ? ` source ${input.source}` : '';
      const vrf  = input.vrf ? ` vrf ${input.vrf}` : (input.routing_instance ? ` routing-instance ${input.routing_instance}` : '');
      const cmd = isAristaNode
        ? `ping ${dest} repeat ${cnt}${src}${vrf}`
        : `ping ${dest} count ${cnt} rapid${src}${vrf}`;
      const { stdout } = await sshExec(`docker exec ${ctr} ${cli} -c "${cmd.replace(/\n/g,'\\n')}"`);
      return JSON.stringify({ node, destination: dest, output: stdout.trim() });
    }

    if (toolName === 'run_command') {
      const cmd = input.command || '';
      const { stdout } = await sshExec(`docker exec ${ctr} ${cli} -c "${cmd.replace(/\n/g,'\\n')}"`);
      return JSON.stringify({ node, command: cmd, output: stdout.trim() });
    }

    const CMDS = {
      arista: {
        get_bgp_health:      ['show bgp summary vrf all','show bgp evpn summary','show run section router bgp | include peer-group|password|neighbor'],
        get_overlay_health:  ['show bgp evpn summary','show vxlan vni','show vxlan vtep','show vxlan address-table','show run section router bgp | include route-target|vni|redistribute'],
        get_underlay_health: ['show interfaces status','show ip bgp summary','show ip route summary','show run section router bgp | include maximum-paths|ecmp'],
        get_bfd_health:      ['show bfd peers','show bfd peers detail','show run | include bfd'],
        get_hardware_health: ['show version | include memory|uptime','show processes top once | head -15'],
      },
      juniper: {
        get_bgp_health:      ['show bgp summary','show bgp neighbor','show configuration protocols bgp | display inheritance | match export|policy','show route advertising-protocol bgp all | head -30','show route summary'],
        get_ospf_health:     ['show ospf neighbor','show ospf interface detail','show ospf database summary','show route protocol ospf','show configuration protocols ospf | display inheritance'],
        get_ldp_mpls_health: ['show ldp session','show ldp neighbor','show ldp statistics','show route table inet.3','show mpls lsp'],
        get_evpn_health:     ['show evpn database','show bgp summary','show route table bgp.evpn.0','show configuration routing-instances | display inheritance | match vrf-target|route-distinguisher|vni','show route instance'],
        get_l3vpn_health:    ['show route instance','show route table bgp.l3vpn.0','show bgp summary','show configuration routing-instances | display inheritance'],
      }
    };

    const vdr  = isAristaNode ? 'arista' : 'juniper';
    const cmds = (CMDS[vdr] || {})[toolName] || [];
    if (!cmds.length) return JSON.stringify({ error: `Unknown tool: ${toolName} for vendor ${vdr}` });

    const results = {};
    for (const cmd of cmds) {
      try {
        const { stdout } = await sshExec(`docker exec ${ctr} ${cli} -c "${cmd.replace(/\n/g,'\\n')}"`);
        results[cmd] = stdout.trim();
      } catch(e) { results[cmd] = `ERROR: ${e.message}`; }
    }
    return JSON.stringify({ node, tool: toolName, data: results }, null, 2);
  }

  // ── Full tool definitions ──────────────────────────────────────────────────
  const nodeParam = { type:'object', properties:{ node:{ type:'string', description:'Device name, e.g. dc1-leaf1b, pe1, rr1' }}, required:['node'] };
  const TOOL_DEFS = [
    { name:'list_skills',        description:'List all available troubleshooting skills. Call first to choose the right skill.', input_schema:{ type:'object', properties:{}, required:[] } },
    { name:'read_skill',         description:'Load a full skill document by name. ALWAYS call before any diagnostics.', input_schema:{ type:'object', properties:{ name:{ type:'string' }}, required:['name'] } },
    { name:'get_bgp_health',     description:'BGP health: sessions, neighbor detail, peer-group config, prefix counts.', input_schema: nodeParam },
    { name:'get_overlay_health', description:'EVPN/VXLAN overlay health: BGP EVPN routes, VNI table, VTEP peers, route-target config.', input_schema: nodeParam },
    { name:'get_underlay_health',description:'Underlay health: interface status, IP BGP sessions, route summary, ECMP config.', input_schema: nodeParam },
    { name:'get_bfd_health',     description:'BFD health: session states, timers, protocol bindings.', input_schema: nodeParam },
    { name:'get_hardware_health',description:'System health: CPU, memory, uptime.', input_schema: nodeParam },
    { name:'get_ospf_health',    description:'OSPF health: adjacency states, interface detail, LSDB summary, routes.', input_schema: nodeParam },
    { name:'get_ldp_mpls_health',description:'LDP/MPLS health: session state, neighbor table, inet.3 table, kernel MPLS.', input_schema: nodeParam },
    { name:'get_evpn_health',    description:'EVPN health: EVPN database, BGP EVPN routes, VRF route-target config.', input_schema: nodeParam },
    { name:'get_l3vpn_health',   description:'L3VPN health: VPN instances, VPNv4 BGP table, RD/RT config.', input_schema: nodeParam },
    { name:'ping',               description:'Ping from a node to test reachability.', input_schema:{ type:'object', properties:{ node:{type:'string'}, destination:{type:'string'}, count:{type:'number'}, source:{type:'string'}, vrf:{type:'string'}, routing_instance:{type:'string'} }, required:['node','destination'] }},
    { name:'run_command',        description:'Run any show command on a node.', input_schema:{ type:'object', properties:{ node:{type:'string'}, command:{type:'string'} }, required:['node','command'] }},
    { name:'list_nodes',         description:'List all available lab nodes.', input_schema:{ type:'object', properties:{}, required:[] }},
  ];

  // ── Agentic loop ───────────────────────────────────────────────────────────
  const isOllama = model && !model.startsWith('claude');

  if (isOllama) {
    const ollamaTools = TOOL_DEFS.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
    const omsg = [{ role:'system', content: systemPrompt }, { role:'user', content: userPrompt }];
    let oiter = 0;
    while (oiter < 12) {
      oiter++;
      const r = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer ollama'},
        body: JSON.stringify({ model, max_tokens:4096, tools:ollamaTools, tool_choice:'auto', messages:omsg })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message||'Ollama HTTP '+r.status);
      const m = d.choices?.[0]?.message;
      if (!m) break;
      omsg.push(m);
      if (!m.tool_calls || !m.tool_calls.length) { llmResponse = m.content||''; break; }
      const tres = [];
      for (const tc of m.tool_calls) {
        const tname = tc.function?.name||'';
        let tinput = {};
        try { tinput = JSON.parse(tc.function?.arguments||'{}'); } catch {}
        console.log('[ollama-tool] '+tname+'('+JSON.stringify(tinput)+')');
        let result;
        try {
          result = await execTool(tname, tinput);
          toolCalls.push({ command:tname, node:tinput.node||tinput.name||'', type:'ollama_tool', tool_call_id:tc.id });
        } catch(e) { result = JSON.stringify({ error:e.message }); }
        tres.push({ role:'tool', tool_call_id:tc.id, content:result });
      }
      omsg.push(...tres);
    }
    if (!llmResponse)
      llmResponse = '[Max iter] ' + omsg.filter(m=>m.role==='assistant'&&m.content).map(m=>m.content).join('\n');
  } else {
    // Claude agentic loop
    const messages = [{ role:'user', content: userPrompt }];
    let iterations = 0;
    while (iterations < 8) {
      iterations++;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 4096, system: systemPrompt, tools: TOOL_DEFS, messages })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
      messages.push({ role:'assistant', content: d.content });

      if (d.stop_reason === 'end_turn') {
        llmResponse = d.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
        break;
      }
      if (d.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of d.content) {
          if (block.type !== 'tool_use') continue;
          console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
          let result;
          try {
            result = await execTool(block.name, block.input);
            toolCalls.push({ command:block.name, node:block.input.node||block.input.name||'', type:'mcp_composite', tool_use_id:block.id });
            if (block.name === 'read_skill' && block.input.name) {
              if (!skillsFired.includes(block.input.name)) skillsFired.push(block.input.name);
            }
          } catch(e) { result = JSON.stringify({ error: e.message }); }
          toolResults.push({ type:'tool_result', tool_use_id:block.id, content:result });
        }
        messages.push({ role:'user', content: toolResults });
        continue;
      }
      llmResponse = d.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      break;
    }
    if (!llmResponse) {
      llmResponse = '[Max iterations reached] Partial diagnosis: ' +
        messages.filter(m=>m.role==='assistant')
          .flatMap(m => Array.isArray(m.content) ? m.content.filter(b=>b.type==='text').map(b=>b.text) : [m.content])
          .join('\n');
    }
  }

  const durationMs = Date.now() - startMs;
  return { llmResponse, toolCalls, skillsFired, durationMs };
}

// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/live/run', requireAuth, async (req, res) => {
  const { run_id, skill_content, fault_meta, model, custom_user_prompt } = req.body;
  if (!run_id) return res.status(400).json({ error:'run_id required' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error:'No ANTHROPIC_API_KEY configured' });

  const run = db.prepare('SELECT * FROM live_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error:'Run not found' });
  const recoverableStatuses = ['injected','run_failed','inject_failed','complete'];
  if (!recoverableStatuses.includes(run.status))
    return res.status(400).json({ error:`Run status is ${run.status}` });

  db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('running', run_id);
  const startMs = Date.now();

  // Determine vendor from device name to route to correct MCP
  try {
    const { llmResponse, toolCalls, skillsFired, durationMs } = await runDiagnostic(
      fault_meta, model, apiKey, custom_user_prompt
    );
    const autoScore  = scoreResponse(llmResponse, toolCalls, fault_meta||{});
    autoScore.time_pass = durationMs <= 120000; // 120s soft SLA
    autoScore.overall   = autoScore.quality_pass && autoScore.time_pass;
    autoScore.duration_ms = durationMs;
    db.prepare("UPDATE live_runs SET status=?,llm_response=?,tool_calls=?,auto_score=?,duration_ms=?,skills_fired=? WHERE id=?")
      .run('complete', llmResponse, JSON.stringify(toolCalls), JSON.stringify(autoScore), durationMs, JSON.stringify(skillsFired), run_id);

    // ── p90 regression baseline update ────────────────────────────────────────
    try {
      const faultIdForBaseline = run_id ? (db.prepare('SELECT fault_id FROM live_runs WHERE id=?').get(run_id) || {}).fault_id : null;
      if (faultIdForBaseline) {
        const existingBaseline = db.prepare('SELECT * FROM eval_baseline WHERE fault_id=?').get(faultIdForBaseline);
        const allRuns = db.prepare(
          "SELECT duration_ms FROM live_runs WHERE fault_id=? AND status='complete' ORDER BY created_at DESC LIMIT 20"
        ).all(faultIdForBaseline).map(r => r.duration_ms).filter(d => d != null).sort((a,b)=>a-b);
        if (allRuns.length >= 3) {
          const p90idx = Math.floor(allRuns.length * 0.9);
          const p90 = allRuns[Math.min(p90idx, allRuns.length-1)];
          db.prepare(`INSERT INTO eval_baseline (fault_id,p90_duration_ms,sample_count,last_updated)
            VALUES (?,?,?,?) ON CONFLICT(fault_id) DO UPDATE SET
            p90_duration_ms=excluded.p90_duration_ms, sample_count=excluded.sample_count,
            last_updated=excluded.last_updated`)
            .run(faultIdForBaseline, p90, allRuns.length, Date.now());
          if (existingBaseline && durationMs > existingBaseline.p90_duration_ms * 1.2) {
            const pct = Math.round((durationMs/existingBaseline.p90_duration_ms - 1)*100);
            autoScore.time_regression = `+${pct}% vs baseline`;
            autoScore.time_pass = false;
            // persist updated score with regression flag
            db.prepare("UPDATE live_runs SET auto_score=? WHERE id=?")
              .run(JSON.stringify(autoScore), run_id);
          }
        }
      }
    } catch(baselineErr) { console.error('baseline update error:', baselineErr.message); }

    audit(req.user.id,'POST','/api/live/run',200,`score=${autoScore.total} run=${run_id}`);
    res.json({ llm_response:llmResponse, tool_calls:toolCalls, auto_score:autoScore, duration_ms:durationMs });
  } catch(e) {
    db.prepare("UPDATE live_runs SET status=? WHERE id=?").run('run_failed', run_id);
    res.status(500).json({ error:e.message });
  }
});


app.post('/api/live/restore', requireAuth, async (req, res) => {
  const { run_id } = req.body;
  const run = db.prepare('SELECT * FROM live_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error:'Run not found' });
  try {
    const { stdout, code } = await sshExec(`bash "${FAULT_DIR}/${run.fault_id}-restore.sh" 2>&1`);
    if (code!==0) return res.status(500).json({ error:'Restore failed', detail:stdout });
    db.prepare("UPDATE live_runs SET status=?,restored_at=? WHERE id=?").run('restored',Date.now(),run_id);
    audit(req.user.id,'POST','/api/live/restore',200,`Restored: ${run.fault_id}`);
    res.json({ ok:true, output:stdout });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/live/runs', requireAuth, (req, res) => {
  const runs = db.prepare('SELECT * FROM live_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  runs.forEach(r => { try { r.auto_score=JSON.parse(r.auto_score); } catch {} try { r.tool_calls=JSON.parse(r.tool_calls); } catch {} });
  res.json(runs);
});

app.get('/api/eval/baseline', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM eval_baseline ORDER BY last_updated DESC').all();
  // Annotate with latest run info
  const enriched = rows.map(r => {
    const latest = db.prepare(
      "SELECT auto_score, duration_ms, created_at FROM live_runs WHERE fault_id=? AND status='complete' ORDER BY created_at DESC LIMIT 1"
    ).get(r.fault_id);
    if (latest) {
      try { latest.auto_score = JSON.parse(latest.auto_score); } catch {}
      r.latest_score = latest.auto_score?.total;
      r.latest_duration_ms = latest.duration_ms;
      r.latest_run_at = latest.created_at;
      // flag regression on latest run
      if (latest.duration_ms && r.p90_duration_ms && latest.duration_ms > r.p90_duration_ms * 1.2) {
        r.regression = `+${Math.round((latest.duration_ms/r.p90_duration_ms - 1)*100)}%`;
      }
    }
    return r;
  });
  res.json(enriched);
});

app.get('/api/live/leaderboard', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT u.username, l.fault_id, l.auto_score, l.duration_ms, l.created_at
    FROM live_runs l JOIN users u ON u.id=l.user_id WHERE l.status='complete'
    ORDER BY l.created_at DESC LIMIT 50`).all();
  rows.forEach(r => { try { r.auto_score=JSON.parse(r.auto_score); } catch {} });
  res.json(rows);
});

// ── Skill optimizer ───────────────────────────────────────────────────────────
app.post('/api/skill/optimize', requireAuth, async (req, res) => {
  const { run_id } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error:'No ANTHROPIC_API_KEY' });
  if (!run_id) return res.status(400).json({ error:'run_id required' });
  const run = db.prepare('SELECT * FROM live_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error:'Run not found' });
  if (run.status!=='complete') return res.status(400).json({ error:'Run not complete' });
  const autoScore = JSON.parse(run.auto_score||'{}');
  if (autoScore.grade==='PASS') return res.status(400).json({ error:'Run already passed' });

  // Load current skill and fault meta from clab host
  let skillContent='', faultMeta={};
  try { const {stdout}=await sshExec(`cat "${FAULT_DIR}/skills/${run.fault_id}.md" 2>/dev/null`); skillContent=stdout.trim(); } catch {}
  try { const {stdout}=await sshExec(`cat "${FAULT_DIR}/${run.fault_id}.json" 2>/dev/null`); faultMeta=JSON.parse(stdout); } catch {}
  // Fallback to network-skills if no patched version yet
  if (!skillContent && faultMeta.skill) {
    try { const {stdout}=await sshExec(`cat "/home/${CLAB_USER}/network-skills/${faultMeta.skill}/SKILL.md" 2>/dev/null`); skillContent=stdout.trim(); } catch {}
  }

  const skillType = faultMeta.skill_type_map?.[faultMeta.skill] || 'EP';
  const scoreBreakdown = `Total: ${autoScore.total}/100 (${autoScore.grade})
- Root Cause: ${autoScore.root_cause}/35  Tool Sequence: ${autoScore.tool_sequence}/25
- Fix Proposed: ${autoScore.fix_proposed}/20  Efficiency: ${autoScore.efficiency}/10
- Skill Activation: ${autoScore.skill_activation}/10`;

  const optimizePrompt = `You are a skill optimizer for an LLM network troubleshooting trainer.

A student LLM was given this skill and asked to diagnose a real network fault. It scored poorly.
Your job: analyze WHY it failed and produce an improved skill that would help it pass.

## The Fault
ID: ${faultMeta.id||run.fault_id} | Title: ${faultMeta.title||'Unknown'}
Symptom: ${faultMeta.symptom||'Unknown'}
Root cause: ${faultMeta.root_cause||'Unknown'}
Correct fix: ${faultMeta.fix_command||'Unknown'}
Optimal tool sequence: ${(faultMeta.optimal_tool_sequence||[]).join(' → ')}

## Score
${scoreBreakdown}

## Current Skill
\`\`\`
${skillContent||'(none found)'}
\`\`\`

## Student LLM Response
\`\`\`
${(run.llm_response||'').slice(0,3000)}
\`\`\`

## Skill Type: ${skillType}
${skillType === 'CU' ? `This is a CAPABILITY UPLIFT skill — it gives the agent access to data it cannot get otherwise.
Failure analysis: Look for MISSING TOOL CALLS, insufficient data retrieval, or the agent using
the wrong tool for the data source. The fix is usually adding explicit tool-call instructions.` :
`This is an ENCODED PREFERENCE skill — it shapes HOW the agent reasons over data it already has.
Failure analysis: Look for WRONG DECISION LOGIC, missed diagnostic conditions, incorrect check
ordering, or the agent stopping too early. The fix is usually clarifying decision rules or
adding missed check steps.`}

Produce an improved SKILL.md. Call submit_skill_optimization with analysis, changes[], improved_skill.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:4096,
        tools:[{ name:'submit_skill_optimization', description:'Submit the skill optimization results',
          input_schema:{ type:'object', properties:{
            analysis:{type:'string'}, changes:{type:'array',items:{type:'object',
              properties:{section:{type:'string'},type:{type:'string',enum:['add','modify','remove']},reason:{type:'string'}},
              required:['section','type','reason']}},
            improved_skill:{type:'string'}}, required:['analysis','changes','improved_skill'] }}],
        tool_choice:{type:'tool',name:'submit_skill_optimization'},
        messages:[{role:'user',content:optimizePrompt}] })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message||`HTTP ${r.status}`);
    const toolBlock = data.content?.find(b=>b.type==='tool_use'&&b.name==='submit_skill_optimization');
    if (!toolBlock) throw new Error('No tool_use block in response');
    const result = toolBlock.input;
    result.original_skill = skillContent;
    result.skill_name = faultMeta.skill || run.fault_id;
    result.run_id = run_id;
    audit(req.user.id,'POST','/api/skill/optimize',200,`Optimized: ${run.fault_id}`);
    res.json(result);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── DB migrations (idempotent) ───────────────────────────────────────────────
try { db.prepare("ALTER TABLE live_runs ADD COLUMN skills_fired TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE live_runs ADD COLUMN token_count INTEGER").run(); } catch(e) {}
try { db.prepare(`CREATE TABLE IF NOT EXISTS eval_baseline (
  fault_id TEXT PRIMARY KEY, p90_duration_ms REAL, p90_tokens INTEGER,
  sample_count INTEGER DEFAULT 0, last_updated INTEGER)`).run(); } catch(e) {}


// ── Eval Suite — full automated run across all faults ────────────────────────
const suiteState = { running: false, results: [], progress: 0, total: 0, startedAt: null };

app.get('/api/eval/suite/status', requireAuth, (req, res) => {
  res.json({ ...suiteState, results: suiteState.results });
});

app.post('/api/eval/suite/run', requireAuth, async (req, res) => {
  if (suiteState.running) return res.status(409).json({ error: 'Suite already running' });

  const suiteModel = process.env.SUITE_MODEL || 'claude-haiku-4-5-20251001';
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY' });

  // Load all fault JSONs
  let faultFiles = [];
  try {
    const { stdout } = await sshExec(`ls ${FAULT_DIR}/*.json 2>/dev/null`);
    faultFiles = stdout.trim().split('\n').filter(Boolean);
  } catch(e) { return res.status(500).json({ error: 'Cannot list faults: ' + e.message }); }

  const faults = [];
  for (const file of faultFiles) {
    try {
      const { stdout } = await sshExec(`cat "${file}"`);
      const f = JSON.parse(stdout);
      if (f.id) faults.push(f);
    } catch {}
  }
  if (!faults.length) return res.status(400).json({ error: 'No valid fault JSONs found' });

  suiteState.running = true;
  suiteState.results = [];
  suiteState.progress = 0;
  suiteState.total = faults.length;
  suiteState.startedAt = Date.now();
  res.json({ ok: true, total: faults.length, model: suiteModel });

  // Run faults sequentially in background
  (async () => {
    for (const fault of faults) {
      const result = { fault_id: fault.id, fault_domain: fault.fault_domain || 'unknown',
                       title: fault.title, status: 'pending', auto_score: null,
                       skills_fired: [], duration_ms: null, error: null };
      try {
        // Inject
        const runId = nanoid();
        db.prepare("INSERT INTO live_runs (id,user_id,fault_id,status,created_at) VALUES (?,?,?,?,?)")
          .run(runId, req.user.id, fault.id, 'injecting', Date.now());
        const inj = await sshExec(`bash "${FAULT_DIR}/${fault.id}-inject.sh" 2>&1`);
        if (inj.code !== 0) { result.status = 'inject_failed'; result.error = inj.stdout; suiteState.results.push(result); suiteState.progress++; continue; }
        db.prepare("UPDATE live_runs SET status=?,injected_at=? WHERE id=?").run('injected', Date.now(), runId);

        // Run real diagnostic — full tool set, real SSH execution, shared system prompt
        const { llmResponse, toolCalls, skillsFired, durationMs } = await runDiagnostic(
          fault, suiteModel, apiKey
        );
        const autoScore = scoreResponse(llmResponse, toolCalls, fault);
        autoScore.time_pass = durationMs <= 120000;
        autoScore.overall = autoScore.quality_pass && autoScore.time_pass;
        autoScore.duration_ms = durationMs;

        db.prepare("UPDATE live_runs SET status=?,llm_response=?,tool_calls=?,auto_score=?,duration_ms=?,skills_fired=? WHERE id=?")
          .run('complete', llmResponse, JSON.stringify(toolCalls), JSON.stringify(autoScore), durationMs, JSON.stringify(skillsFired), runId);

        // Restore lab
        try { await sshExec(`bash "${FAULT_DIR}/${fault.id}-restore.sh" 2>&1`); } catch {}
        db.prepare("UPDATE live_runs SET status=?,restored_at=? WHERE id=?").run('restored', Date.now(), runId);

        result.status = 'complete';
        result.auto_score = autoScore;
        result.skills_fired = skillsFired;
        result.duration_ms = durationMs;
        result.run_id = runId;
      } catch(e) {
        result.status = 'error';
        result.error = e.message;
      }
      suiteState.results.push(result);
      suiteState.progress++;
      // Small gap between faults to avoid hammering the lab
      await new Promise(r => setTimeout(r, 3000));
    }
    suiteState.running = false;
  })().catch(e => { suiteState.running = false; console.error('Suite run error:', e); });
});


// ════════════════════════════════════════════════════════════════════════════
// ── EVPN NOC EVAL — Standalone endpoints, no dependency on FAULT_DIR ────────
// All 20 dc1 fault definitions embedded here. Inject/restore via direct
// sshExec → docker exec on 10.0.0.71. Completely separate from /api/live/.
// ════════════════════════════════════════════════════════════════════════════

const DOCKER = `docker exec clab-${CLAB_LAB_NAME}`;

const EVPN_NOC_FAULTS = {
  'evpn-noc-01': {
    id:'evpn-noc-01', title:'Underlay Neighbor Down — dc1-spine1 ↔ dc1-leaf1a',
    device:'dc1-spine1', difficulty:'easy', fault_domain:'underlay',
    symptom:'BGP neighbor 10.255.255.1 (dc1-leaf1a) stuck in Active on dc1-spine1.',
    root_cause:'Ethernet1 on dc1-spine1 (uplink to dc1-leaf1a) is shut.',
    fix_command:'interface Ethernet1\nno shutdown',
    inject:  `${DOCKER}-dc1-spine1 Cli -p 15 -c "configure\ninterface Ethernet1\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-spine1 Cli -p 15 -c "configure\ninterface Ethernet1\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp summary','show bgp neighbors 10.255.255.1','show interfaces Ethernet1'],
  },
  'evpn-noc-02': {
    id:'evpn-noc-02', title:'Remote VTEP Unreachable — leaf2 pair',
    device:'dc1-leaf1a', difficulty:'medium', fault_domain:'underlay',
    symptom:'VTEP 10.255.1.5 (dc1-leaf2a/2b) unreachable from dc1-leaf1a.',
    root_cause:'Both uplinks on dc1-leaf2a (Ethernet1 to spine1, Ethernet2 to spine2) are shut.',
    fix_command:'interface Ethernet1,Ethernet2\nno shutdown',
    inject:  `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Ethernet1\nshutdown\ninterface Ethernet2\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Ethernet1\nno shutdown\ninterface Ethernet2\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show vxlan vtep','show bgp evpn summary','show ip route 10.255.1.5'],
  },
  'evpn-noc-03': {
    id:'evpn-noc-03', title:'Interface Flap and Route Loss — dc1-leaf2a Et1',
    device:'dc1-leaf2a', difficulty:'easy', fault_domain:'underlay',
    symptom:'Ethernet1 on dc1-leaf2a flapped; BGP prefix count to dc1-spine1 dropped.',
    root_cause:'Ethernet1 on dc1-leaf2a is shut (final state after flap simulation).',
    fix_command:'interface Ethernet1\nno shutdown',
    inject:  `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Ethernet1\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Ethernet1\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show interfaces Ethernet1','show interfaces Ethernet1 counters','show bgp summary'],
  },
  'evpn-noc-04': {
    id:'evpn-noc-04', title:'CP CPU Spike — Multi-Adjacency Drop dc1-spine1',
    device:'dc1-spine1', difficulty:'medium', fault_domain:'underlay',
    symptom:'3 BGP adjacencies dropped simultaneously on dc1-spine1.',
    root_cause:'All four leaf uplinks (Et1-Et4) on dc1-spine1 shut simultaneously.',
    fix_command:'interface Ethernet1,Ethernet2,Ethernet3,Ethernet4\nno shutdown',
    inject:  `${DOCKER}-dc1-spine1 Cli -p 15 -c "configure\ninterface Ethernet1\nshutdown\ninterface Ethernet2\nshutdown\ninterface Ethernet3\nshutdown\ninterface Ethernet4\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-spine1 Cli -p 15 -c "configure\ninterface Ethernet1\nno shutdown\ninterface Ethernet2\nno shutdown\ninterface Ethernet3\nno shutdown\ninterface Ethernet4\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp summary','show processes top','show interfaces status'],
  },
  'evpn-noc-05': {
    id:'evpn-noc-05', title:'EVPN BGP Session Down — dc1-leaf2a L2VPN EVPN AF',
    device:'dc1-leaf2a', difficulty:'easy', fault_domain:'overlay-evpn',
    symptom:'L2VPN EVPN session from dc1-leaf2a to dc1-spine1 (10.255.0.1) is Connect. Underlay IPv4 sessions all Established.',
    root_cause:'EVPN-OVERLAY-PEERS deactivated under address-family evpn on dc1-leaf2a.',
    fix_command:'router bgp 65102\naddress-family evpn\nneighbor EVPN-OVERLAY-PEERS activate',
    inject:  `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\nrouter bgp 65102\naddress-family evpn\nno neighbor EVPN-OVERLAY-PEERS activate\nend"`,
    restore: `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\nrouter bgp 65102\naddress-family evpn\nneighbor EVPN-OVERLAY-PEERS activate\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp evpn summary','show bgp neighbors 10.255.0.1','show run section router bgp | include activate'],
  },
  'evpn-noc-06': {
    id:'evpn-noc-06', title:'EVPN Route Withdrawal Flap — VNI 10011 dc1-leaf1a',
    device:'dc1-leaf1a', difficulty:'medium', fault_domain:'overlay-evpn',
    symptom:'Type-2 routes for VNI 10011 from dc1-leaf1a repeatedly withdrawn. EVPN session Established.',
    root_cause:'vxlan vlan 11 vni 10011 binding removed from Vxlan1 on dc1-leaf1a.',
    fix_command:'interface Vxlan1\nvxlan vlan 11 vni 10011',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Vxlan1\nno vxlan vlan 11 vni 10011\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Vxlan1\nvxlan vlan 11 vni 10011\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp evpn summary','show vxlan vni','show bgp evpn route-type mac-ip vni 10011'],
  },
  'evpn-noc-07': {
    id:'evpn-noc-07', title:'Missing Type-2 Route — VNI 10011 RT Mismatch dc1-leaf1a',
    device:'dc1-leaf1a', difficulty:'medium', fault_domain:'overlay-evpn',
    symptom:'Host MAC in VLAN 11 locally learned on dc1-leaf1a but not seen on remote VTEPs. EVPN sessions Established.',
    root_cause:'Route-target for VLAN 11/VNI 10011 changed to 10011:99999 on dc1-leaf1a. Remote leaves reject routes (expect 10011:10011).',
    fix_command:'router bgp 65101\nvlan 11\nno route-target both 10011:99999\nroute-target both 10011:10011',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\nrouter bgp 65101\nvlan 11\nno route-target both 10011:10011\nroute-target both 10011:99999\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\nrouter bgp 65101\nvlan 11\nno route-target both 10011:99999\nroute-target both 10011:10011\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','evpn.check-vni-and-vtep','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp evpn route-type mac-ip vni 10011','show run section router bgp | include vlan 11'],
  },
  'evpn-noc-08': {
    id:'evpn-noc-08', title:'Missing Type-5 Route — VRF11 redistribute removed dc1-leaf1a',
    device:'dc1-leaf1a', difficulty:'medium', fault_domain:'overlay-evpn',
    symptom:'VRF VRF11 inter-subnet routing failing on dc1-leaf1a. No Type-5 routes originated. L2 within VRF11 works.',
    root_cause:'redistribute connected removed from VRF VRF11 BGP config on dc1-leaf1a.',
    fix_command:'router bgp 65101\nvrf VRF11\nredistribute connected route-map RM-CONN-2-BGP-VRFS',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\nrouter bgp 65101\nvrf VRF11\nno redistribute connected route-map RM-CONN-2-BGP-VRFS\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\nrouter bgp 65101\nvrf VRF11\nredistribute connected route-map RM-CONN-2-BGP-VRFS\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp evpn route-type ip-prefix','show run section router bgp | section VRF11'],
  },
  'evpn-noc-09': {
    id:'evpn-noc-09', title:'Route-Target Mismatch — VLAN 12/VNI 10012 dc1-leaf2a',
    device:'dc1-leaf2a', difficulty:'medium', fault_domain:'overlay-evpn',
    symptom:'VLAN 12 hosts on dc1-leaf1a cannot reach dc1-leaf2a. 0 MAC entries for VNI 10012 on dc1-leaf2a.',
    root_cause:'Route-target for VLAN 12/VNI 10012 changed to 10012:88888 on dc1-leaf2a.',
    fix_command:'router bgp 65102\nvlan 12\nno route-target both 10012:88888\nroute-target both 10012:10012',
    inject:  `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\nrouter bgp 65102\nvlan 12\nno route-target both 10012:10012\nroute-target both 10012:88888\nend"`,
    restore: `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\nrouter bgp 65102\nvlan 12\nno route-target both 10012:88888\nroute-target both 10012:10012\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp evpn route-type mac-ip vni 10012','show run section router bgp | section vlan 12'],
  },
  'evpn-noc-10': {
    id:'evpn-noc-10', title:'VNI Not Active — VNI 10022 removed from dc1-leaf1b',
    device:'dc1-leaf1b', difficulty:'easy', fault_domain:'overlay-evpn',
    symptom:'VLAN 22 hosts unreachable from remote leaves via dc1-leaf1b. EVPN sessions Established. VNI 10022 shows inactive.',
    root_cause:'vxlan vlan 22 vni 10022 binding removed from Vxlan1 on dc1-leaf1b.',
    fix_command:'interface Vxlan1\nvxlan vlan 22 vni 10022',
    inject:  `${DOCKER}-dc1-leaf1b Cli -p 15 -c "configure\ninterface Vxlan1\nno vxlan vlan 22 vni 10022\nend"`,
    restore: `${DOCKER}-dc1-leaf1b Cli -p 15 -c "configure\ninterface Vxlan1\nvxlan vlan 22 vni 10022\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-vni-and-vtep','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-control-plane','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show vxlan vni','show vxlan vtep','show run section vxlan'],
  },
  'evpn-noc-11': {
    id:'evpn-noc-11', title:'MLAG Peer-Link Degradation — DC1_L3_LEAF1 Po3',
    device:'dc1-leaf1a', difficulty:'medium', fault_domain:'mlag',
    symptom:'Port-Channel3 peer-link in DC1_L3_LEAF1 lost a member. Bandwidth degraded, utilization high.',
    root_cause:'Ethernet3 on dc1-leaf1a (one of two Port-Channel3 members) is shut.',
    fix_command:'interface Ethernet3\nno shutdown',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Ethernet3\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Ethernet3\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','diagnose-mlag','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-endpoint'],
    optimal_tool_sequence:['show mlag','show port-channel summary','show interfaces Ethernet3,Ethernet4'],
  },
  'evpn-noc-12': {
    id:'evpn-noc-12', title:'MLAG Consistency Mismatch — DC1_L3_LEAF2 Po5',
    device:'dc1-leaf2a', difficulty:'medium', fault_domain:'mlag',
    symptom:'DC1_L3_LEAF2 MLAG config-sanity reports inconsistency. Peer-link up. Asymmetric forwarding causing drops.',
    root_cause:'VLAN 21 removed from Port-Channel5 trunk allowed list on dc1-leaf2b only.',
    fix_command:'interface Port-Channel5\nswitchport trunk allowed vlan add 21',
    inject:  `${DOCKER}-dc1-leaf2b Cli -p 15 -c "configure\ninterface Port-Channel5\nswitchport trunk allowed vlan remove 21\nend"`,
    restore: `${DOCKER}-dc1-leaf2b Cli -p 15 -c "configure\ninterface Port-Channel5\nswitchport trunk allowed vlan add 21\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-mlag','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-endpoint'],
    optimal_tool_sequence:['show mlag','show mlag config-sanity','show interfaces Port-Channel5 trunk'],
  },
  'evpn-noc-13': {
    id:'evpn-noc-13', title:'Orphan Port Symptom — Po24 on dc1-leaf1a only',
    device:'dc1-leaf1a', difficulty:'hard', fault_domain:'mlag',
    symptom:'Server on Po24 unreachable. Po24 active on dc1-leaf1a but absent from DC1_L3_LEAF1 peer dc1-leaf1b. MLAG peer-link up.',
    root_cause:'Port-Channel24 with mlag 24 created on dc1-leaf1a only — orphan port.',
    fix_command:'no interface Port-Channel24',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Port-Channel24\ndescription ORPHAN-TEST\nswitchport access vlan 11\nmlag 24\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Port-Channel24\nno mlag 24\nno description\nend\nconfigure\nno interface Port-Channel24\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-mlag','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-endpoint'],
    optimal_tool_sequence:['show mlag','show mlag interfaces','show mlag config-sanity'],
  },
  'evpn-noc-14': {
    id:'evpn-noc-14', title:'Remote MAC Not Learned — VNI 10011 RT Import Break dc1-leaf1a',
    device:'dc1-leaf1a', difficulty:'hard', fault_domain:'endpoint',
    symptom:'Local MAC in VLAN 11 present but remote MACs from dc1-leaf2a not appearing in MAC table for VNI 10011.',
    root_cause:'RT import for VNI 10011 on dc1-leaf1a changed to 10011:77777 — blocks dc1-leaf2a Type-2 routes.',
    fix_command:'router bgp 65101\nvlan 11\nno route-target export 10011:10011\nno route-target import 10011:77777\nroute-target both 10011:10011',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\nrouter bgp 65101\nvlan 11\nno route-target both 10011:10011\nroute-target export 10011:10011\nroute-target import 10011:77777\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\nrouter bgp 65101\nvlan 11\nno route-target export 10011:10011\nno route-target import 10011:77777\nroute-target both 10011:10011\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-endpoint','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','diagnose-mlag'],
    optimal_tool_sequence:['show bgp evpn route-type mac-ip vni 10011','show run section router bgp | section vlan 11','show vxlan address-table vlan 11'],
  },
  'evpn-noc-15': {
    id:'evpn-noc-15', title:'ARP Resolution Failure — Host Silent dc1-leaf2b',
    device:'dc1-leaf2b', difficulty:'easy', fault_domain:'endpoint',
    symptom:'Host on dc1-leaf2b showing ARP incomplete. Port Ethernet8 connected (line protocol up). No fabric faults. No MAC entry.',
    root_cause:'Ethernet8 on dc1-leaf2b is shut — simulates silent endpoint (NIC up, OS not responding).',
    fix_command:'interface Ethernet8\nno shutdown',
    inject:  `${DOCKER}-dc1-leaf2b Cli -p 15 -c "configure\ninterface Ethernet8\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-leaf2b Cli -p 15 -c "configure\ninterface Ethernet8\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-endpoint','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-mlag'],
    optimal_tool_sequence:['show mac address-table vlan 21','show arp vrf VRF11','show interfaces Ethernet8','show interfaces Ethernet8 counters'],
  },
  'evpn-noc-16': {
    id:'evpn-noc-16', title:'Tenant Reachability Failure — VRF11 L3VNI Removed dc1-leaf2a',
    device:'dc1-leaf2a', difficulty:'medium', fault_domain:'endpoint',
    symptom:'VRF VRF11 inter-subnet routing broken on dc1-leaf2a. Type-5 routes present. Local host MAC/ARP resolved. Remote host ARP incomplete.',
    root_cause:'vxlan vrf VRF11 vni 11 removed from Vxlan1 on dc1-leaf2a. VRF11 L3 encap/decap broken.',
    fix_command:'interface Vxlan1\nvxlan vrf VRF11 vni 11',
    inject:  `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Vxlan1\nno vxlan vrf VRF11 vni 11\nend"`,
    restore: `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Vxlan1\nvxlan vrf VRF11 vni 11\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','diagnose-endpoint','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-vni-and-vtep','diagnose-mlag'],
    optimal_tool_sequence:['show vxlan vni','show ip route vrf VRF11','show bgp evpn route-type ip-prefix'],
  },
  'evpn-noc-17': {
    id:'evpn-noc-17', title:'Noisy Logs — Single Root Cause — dc1-spine2 Et3',
    device:'dc1-spine2', difficulty:'medium', fault_domain:'underlay',
    symptom:'dc1-spine2 generating syslog storm. 1 BGP session (dc1-leaf2a, 10.255.255.10) actually down.',
    root_cause:'Ethernet3 on dc1-spine2 (uplink to dc1-leaf2a) is shut — produces BGP notification storm.',
    fix_command:'interface Ethernet3\nno shutdown',
    inject:  `${DOCKER}-dc1-spine2 Cli -p 15 -c "configure\ninterface Ethernet3\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-spine2 Cli -p 15 -c "configure\ninterface Ethernet3\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show interfaces Ethernet3','show bgp neighbors 10.255.255.10','show logging last 100'],
  },
  'evpn-noc-18': {
    id:'evpn-noc-18', title:'Stale NetBox Intent — dc1-leaf1b RT Mismatch',
    device:'dc1-leaf1b', difficulty:'medium', fault_domain:'overlay-evpn',
    symptom:'Host MAC not seen on remote VTEPs from dc1-leaf1b. EVPN sessions Established. NetBox may be stale after recent cabling change.',
    root_cause:'RT for VNI 10012 changed on dc1-leaf1b to 10012:55555 — simulates post-provisioning error not yet in NetBox.',
    fix_command:'router bgp 65101\nvlan 12\nno route-target both 10012:55555\nroute-target both 10012:10012',
    inject:  `${DOCKER}-dc1-leaf1b Cli -p 15 -c "configure\nrouter bgp 65101\nvlan 12\nno route-target both 10012:10012\nroute-target both 10012:55555\nend"`,
    restore: `${DOCKER}-dc1-leaf1b Cli -p 15 -c "configure\nrouter bgp 65101\nvlan 12\nno route-target both 10012:55555\nroute-target both 10012:10012\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp evpn summary','show vxlan vni','show run section router bgp | section vlan 12'],
  },
  'evpn-noc-19': {
    id:'evpn-noc-19', title:'Multi-Symptom Cascade — dc1-leaf2a Et1',
    device:'dc1-leaf2a', difficulty:'hard', fault_domain:'underlay',
    symptom:'5 simultaneous alerts: spine1 BGP down, leaf2a EVPN routes withdrawn, VTEP tunnel down, leaf1a/1b VLAN11 hosts unreachable. NOC-CR-982 open for dc1-leaf2a Et1 maintenance.',
    root_cause:'Ethernet1 on dc1-leaf2a (uplink to dc1-spine1) shut — maintenance action matching NOC-CR-982.',
    fix_command:'interface Ethernet1\nno shutdown',
    inject:  `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Ethernet1\nshutdown\nend"`,
    restore: `${DOCKER}-dc1-leaf2a Cli -p 15 -c "configure\ninterface Ethernet1\nno shutdown\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-underlay','evpn.check-control-plane','correlate-with-change','produce-rca'],
    must_not_invoke:['evpn.check-vni-and-vtep','diagnose-mlag','diagnose-endpoint'],
    optimal_tool_sequence:['show bgp summary','show bgp evpn summary','show vxlan vtep','show interfaces Ethernet1'],
  },
  'evpn-noc-20': {
    id:'evpn-noc-20', title:'False Positive — Endpoint Fault, Fabric Healthy (Known Failure)',
    device:'dc1-leaf1a', difficulty:'hard', fault_domain:'endpoint',
    symptom:'Host 10.11.10.77 unreachable from all leaves. Ethernet9 connected (NIC up, OS down for upgrade). Zero ingress counters. Fabric completely healthy.',
    root_cause:'Ethernet9 on dc1-leaf1a (host access port) is shut — host is down for OS upgrade. Fabric has no fault.',
    fix_command:'interface Ethernet9\nno shutdown',
    inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Ethernet9\nshutdown\ndescription HOST-DOWN-OS-UPGRADE\nend"`,
    restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\ninterface Ethernet9\nno shutdown\nno description\nend"`,
    expected_skills:['get-intent','get-fabric-state','logs.build-evidence','diagnose-endpoint','correlate-with-change','produce-rca'],
    must_not_invoke:['diagnose-underlay','evpn.check-control-plane','evpn.check-vni-and-vtep','diagnose-mlag'],
    optimal_tool_sequence:['show mac address-table vlan 11','show interfaces Ethernet9','show interfaces Ethernet9 counters','show arp vrf VRF10'],
  },
};

// Ensure evpn_runs table exists
db.exec(`CREATE TABLE IF NOT EXISTS evpn_runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fault_id TEXT NOT NULL,
  injected_at INTEGER, restored_at INTEGER, status TEXT NOT NULL DEFAULT 'idle',
  llm_response TEXT, tool_calls TEXT, auto_score TEXT, duration_ms INTEGER,
  skills_fired TEXT, created_at INTEGER NOT NULL
)`);

// GET /api/evpn/cases — return all 20 case metadata (no inject/restore commands)
app.get('/api/evpn/cases', requireAuth, (req, res) => {
  const cases = Object.values(EVPN_NOC_FAULTS).map(f => {
    const { inject, restore, ...safe } = f;
    return safe;
  });
  res.json(cases);
});

// POST /api/evpn/inject — inject fault directly via sshExec docker exec
app.post('/api/evpn/inject', requireAuth, async (req, res) => {
  const { fault_id } = req.body;
  if (!fault_id || !EVPN_NOC_FAULTS[fault_id]) return res.status(400).json({ error: 'Unknown fault_id' });
  const fault = EVPN_NOC_FAULTS[fault_id];
  const runId = nanoid();
  db.prepare("INSERT INTO evpn_runs (id,user_id,fault_id,status,created_at) VALUES (?,?,?,?,?)")
    .run(runId, req.user.id, fault_id, 'injecting', Date.now());
  try {
    const { stdout, code } = await sshExec(fault.inject);
    if (code !== 0) {
      db.prepare("UPDATE evpn_runs SET status=? WHERE id=?").run('inject_failed', runId);
      return res.status(500).json({ error: 'Inject failed', detail: stdout });
    }
    db.prepare("UPDATE evpn_runs SET status=?,injected_at=? WHERE id=?").run('injected', Date.now(), runId);
    audit(req.user.id, 'POST', '/api/evpn/inject', 200, `Injected: ${fault_id}`);
    res.json({ run_id: runId, output: stdout, fault_id });
  } catch(e) {
    db.prepare("UPDATE evpn_runs SET status=? WHERE id=?").run('inject_failed', runId);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/evpn/run — run diagnostic against injected fault
app.post('/api/evpn/run', requireAuth, async (req, res) => {
  const { run_id, model } = req.body;
  if (!run_id) return res.status(400).json({ error: 'run_id required' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'No ANTHROPIC_API_KEY' });
  const run = db.prepare('SELECT * FROM evpn_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const fault = EVPN_NOC_FAULTS[run.fault_id];
  if (!fault) return res.status(400).json({ error: 'Fault definition missing' });
  const recoverableStatuses = ['injected','run_failed','inject_failed','complete'];
  if (!recoverableStatuses.includes(run.status))
    return res.status(400).json({ error: `Run status is ${run.status}` });
  db.prepare("UPDATE evpn_runs SET status=? WHERE id=?").run('running', run_id);
  try {
    const { llmResponse, toolCalls, skillsFired, durationMs } = await runDiagnostic(
      { ...fault, skill: 'evpn-noc-triage', vendor: 'arista' },
      model || 'claude-sonnet-4-6', apiKey
    );
    const autoScore = scoreResponse(llmResponse, toolCalls, fault);
    autoScore.time_pass = durationMs <= 120000;
    autoScore.overall = autoScore.quality_pass && autoScore.time_pass;
    autoScore.duration_ms = durationMs;
    db.prepare("UPDATE evpn_runs SET status=?,llm_response=?,tool_calls=?,auto_score=?,duration_ms=?,skills_fired=? WHERE id=?")
      .run('complete', llmResponse, JSON.stringify(toolCalls), JSON.stringify(autoScore), durationMs, JSON.stringify(skillsFired), run_id);
    audit(req.user.id, 'POST', '/api/evpn/run', 200, `score=${autoScore.total} run=${run_id}`);
    res.json({ llm_response: llmResponse, tool_calls: toolCalls, auto_score: autoScore, duration_ms: durationMs });
  } catch(e) {
    db.prepare("UPDATE evpn_runs SET status=? WHERE id=?").run('run_failed', run_id);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/evpn/restore — restore dc1 fabric
app.post('/api/evpn/restore', requireAuth, async (req, res) => {
  const { run_id } = req.body;
  const run = db.prepare('SELECT * FROM evpn_runs WHERE id=? AND user_id=?').get(run_id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const fault = EVPN_NOC_FAULTS[run.fault_id];
  if (!fault) return res.status(400).json({ error: 'Fault definition missing' });
  try {
    const { stdout, code } = await sshExec(fault.restore);
    if (code !== 0) return res.status(500).json({ error: 'Restore failed', detail: stdout });
    db.prepare("UPDATE evpn_runs SET status=?,restored_at=? WHERE id=?").run('restored', Date.now(), run_id);
    audit(req.user.id, 'POST', '/api/evpn/restore', 200, `Restored: ${run.fault_id}`);
    res.json({ ok: true, output: stdout });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/evpn/runs — recent runs for current user
app.get('/api/evpn/runs', requireAuth, (req, res) => {
  const runs = db.prepare('SELECT * FROM evpn_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  runs.forEach(r => {
    try { r.auto_score = JSON.parse(r.auto_score); } catch {}
    try { r.tool_calls = JSON.parse(r.tool_calls); } catch {}
    try { r.skills_fired = JSON.parse(r.skills_fired); } catch {}
  });
  res.json(runs);
});

// GET /api/evpn/runs/all — all users' runs (admin only, for leaderboard)
app.get('/api/evpn/runs/all', requireAdmin, (req, res) => {
  const runs = db.prepare(`SELECT e.*, u.username FROM evpn_runs e
    JOIN users u ON u.id=e.user_id WHERE e.status='complete'
    ORDER BY e.created_at DESC LIMIT 100`).all();
  runs.forEach(r => { try { r.auto_score=JSON.parse(r.auto_score); } catch {} });
  res.json(runs);
});

app.listen(PORT, () => console.log(`netops-runner backend on :${PORT}`));
