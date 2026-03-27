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
const OLLAMA_BASE_URL    = process.env.OLLAMA_BASE_URL    || 'http://10.0.0.87:11434';
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
  req.session.destroy(() => res.clearCookie('netops_session'));
  res.json({ ok: true });
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

  const rcKw = (faultMeta.root_cause||'').toLowerCase().split(/[\s,]+/).filter(w=>w.length>4);
  scores.root_cause = Math.round((rcKw.filter(kw=>text.includes(kw)).length / Math.max(rcKw.length,1)) * 40);

  const optimal   = faultMeta.optimal_tool_sequence||[];
  const usedTools = calls.map(c=>(c.command||c.tool||'').toLowerCase());
  let toolMatches = 0;
  for (const opt of optimal) {
    const ol = opt.toLowerCase();
    if (usedTools.some(u => u===ol || u.includes(ol.replace('get_','').replace('_health','')))) toolMatches++;
  }
  scores.tool_sequence = Math.round((toolMatches / Math.max(optimal.length,1)) * 30);

  const fixKw = (faultMeta.fix_command||'').toLowerCase().split(/[\s,]+/).filter(w=>w.length>3);
  scores.fix_proposed = Math.round((fixKw.filter(kw=>text.includes(kw)).length / Math.max(fixKw.length,1)) * 20);

  const optCount = optimal.length+1, actualCount = calls.length;
  scores.efficiency = actualCount===0 ? 0 : actualCount<=optCount ? 10 : actualCount<=optCount*2 ? 7 : 4;

  scores.total = scores.root_cause + scores.tool_sequence + scores.fix_proposed + scores.efficiency;
  scores.grade = scores.total>=80 ? 'PASS' : scores.total>=50 ? 'PARTIAL' : 'FAIL';
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

app.post('/api/live/run', requireAuth, async (req, res) => {
  const { run_id, skill_content, fault_meta, model } = req.body;
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
  // Use vendor from fault metadata (set when fault was created)
  // Falls back to device-name heuristic for backward compatibility
  const faultVendor = fault_meta?.vendor || (
    /^dc1-|^campus/.test(fault_meta?.device||'') ? 'arista' : 'juniper'
  );
  const isArista = faultVendor === 'arista';
  const mcpBase  = isArista ? CEOS_MCP_URL : CRPD_MCP_URL;
  const vendor   = isArista ? 'Arista EOS' : 'Juniper JunOS/cRPD';

  const systemPrompt = `You are a senior network engineer working a live network ticket.
A fault has been injected into the lab. Use your skill and the diagnostic tools to troubleshoot it.

## Your Skill
${skill_content || 'Use systematic troubleshooting methodology.'}

## Lab Topology
Lab: ${CLAB_LAB_NAME}
Affected device: ${fault_meta?.device||'unknown'} (vendor: ${faultVendor})
Use list_nodes() to discover all available nodes in this topology.

## Diagnostic Tools — ${vendor} — MCP endpoint: ${mcpBase}

${isArista ? `**get_bgp_health(node)** — BGP sessions (all VRFs), neighbor detail for non-Established peers,
  peer-group password config, prefix counts. Call FIRST for any BGP/EVPN session fault.

**get_overlay_health(node)** — EVPN BGP routes by type (2/3/5), VXLAN VNI table, VTEP peers,
  MAC/IP table, VRF route-target config. Use for EVPN reachability or missing route faults.

**get_underlay_health(node)** — Interface status + errors, IP BGP underlay sessions, route table
  summary, ECMP/maximum-paths config. Check before overlay for suspected underlay issues.

**get_bfd_health(node)** — BFD sessions, timers, multiplier, protocol bindings. Use when
  BFD flapping is causing BGP or OSPF resets.

**get_hardware_health(node)** — CPU, memory, uptime. Use for resource exhaustion diagnosis.`
  : `**get_bgp_health(node)** — BGP sessions, neighbor detail, export policy config (CRITICAL — JunOS
  requires explicit export policy; missing = zero routes advertised even with Established sessions),
  advertised route sample, route table summary. Call FIRST for any Juniper BGP fault.

**get_ospf_health(node)** — Neighbor adjacency states, interface detail (timers, cost, passive flag,
  MTU), LSDB summary, OSPF-installed routes. Use for backbone OSPF faults.

**get_ldp_mpls_health(node)** — LDP session state, neighbor table, statistics (hello/auth drops),
  inet.3 MPLS label table, Linux kernel MPLS forwarding table. Use for LDP or LSP faults.

**get_evpn_health(node)** — EVPN database, BGP EVPN routes, VRF route-target config, routing
  instances. Use for DC2 EVPN faults — RT mismatch or missing Type-5 routes.

**get_l3vpn_health(node)** — VPN routing instances, VPNv4 BGP table, RD/RT config. Use for
  pe1/pe2 L3VPN faults.`}

**ping(node, destination, [source], [vrf/routing_instance])** — Confirm reachability.

**run_command(node, command)** — Escape hatch. Use only when composite tools don't cover it.

## How to troubleshoot
1. Read your skill — it tells you which tool to call first and what patterns to look for
2. Call the appropriate composite health tool for the affected device and domain
3. Interpret the output — identify the specific misconfiguration causing the fault
4. If needed, call one more targeted tool (ping or run_command) to confirm
5. State your root cause and propose the exact CLI fix (READ-ONLY — do NOT apply config)
6. Format findings using the Output template from your skill

**Efficiency matters**: a good engineer uses 2-4 tool calls. Let the symptom and your skill
guide which domain to investigate first. Calling every tool wastes time and shows poor methodology.`;

  const userPrompt = `Network ticket:
Device: ${fault_meta?.device||'unknown'} (${fault_meta?.mgmt_ip||''})
Symptom: "${fault_meta?.symptom||'degraded network operation'}"
Skill assigned: ${fault_meta?.skill||'general'}

Troubleshoot this fault. Call your diagnostic tools, identify the root cause, and propose a fix.`;

  const toolCalls = [];
  let llmResponse = '';

  // ── Tool executor: runs composite health tools via SSH→docker exec ──────────
  async function execTool(toolName, input) {
    const node = input.node || input.device || '';
    const LAB  = CLAB_LAB_NAME;
    const ctr  = `clab-${LAB}-${node}`;
    const nodeFaultVendor = fault_meta?.vendor || fault_meta?.platform
      || (/^dc1-|^campus/.test(node) ? 'arista' : 'juniper');
    const isAristaNode = nodeFaultVendor === 'arista' || nodeFaultVendor === 'ceos';
    const cli = isAristaNode ? 'Cli -p 15' : 'cli';

    if (toolName === 'list_nodes') {
      // Dynamically discover nodes from docker ps on the clab host
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
      } catch(e) {
        return JSON.stringify({ lab: LAB, error: e.message });
      }
    }

    if (toolName === 'ping') {
      const dest = input.destination || '';
      const cnt  = input.count || 5;
      const src  = input.source ? ` source ${input.source}` : '';
      const vrf  = input.vrf ? ` vrf ${input.vrf}` : (input.routing_instance ? ` routing-instance ${input.routing_instance}` : '');
      const cmd = isAristaNode
        ? `ping ${dest} repeat ${cnt}${src}${vrf}`
        : `ping ${dest} count ${cnt} rapid${src}${vrf}`;
      const fullCmd = isAristaNode ? cmd : cmd;
      const { stdout } = await sshExec(`docker exec ${ctr} ${cli} -c "${fullCmd.replace(/\n/g,'\\n')}"`);
      return JSON.stringify({ node, destination: dest, output: stdout.trim() });
    }

    if (toolName === 'run_command') {
      const cmd = input.command || '';
      const fullCmd = cmd;
      const { stdout } = await sshExec(`docker exec ${ctr} ${cli} -c "${fullCmd.replace(/\n/g,'\\n')}"`);
      return JSON.stringify({ node, command: cmd, output: stdout.trim() });
    }

    // Composite tool command sets
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

    const vendor = isAristaNode ? 'arista' : 'juniper';
    const cmds   = (CMDS[vendor] || {})[toolName] || [];
    if (!cmds.length) return JSON.stringify({ error: `Unknown tool: ${toolName} for vendor ${vendor}` });

    const results = {};
    for (const cmd of cmds) {
      const fullCmd = cmd;
      try {
        const { stdout } = await sshExec(`docker exec ${ctr} ${cli} -c "${fullCmd.replace(/\n/g,'\\n')}"`);
        results[cmd] = stdout.trim();
      } catch(e) {
        results[cmd] = `ERROR: ${e.message}`;
      }
    }
    return JSON.stringify({ node, tool: toolName, data: results }, null, 2);
  }

  // ── Anthropic tool definitions ─────────────────────────────────────────────
  const nodeParam = { type:'object', properties:{ node:{ type:'string', description:'Device name, e.g. dc1-leaf1b, pe1, rr1' }}, required:['node'] };
  const TOOL_DEFS = [
    { name:'get_bgp_health',      description:'BGP health: all session states, non-Established neighbor detail, peer-group password config, prefix counts. Call FIRST for any BGP/EVPN fault.', input_schema: nodeParam },
    { name:'get_overlay_health',  description:'EVPN/VXLAN overlay health: BGP EVPN routes by type (2/3/5), VNI table, VTEP peers, MAC/IP table, route-target config. Use for EVPN reachability faults.', input_schema: nodeParam },
    { name:'get_underlay_health', description:'Underlay health: interface status + errors, IP BGP sessions, route summary, ECMP config. Check before overlay for suspected underlay issues.', input_schema: nodeParam },
    { name:'get_bfd_health',      description:'BFD health: session states, timers, protocol bindings. Use when BFD flapping causes BGP/OSPF resets.', input_schema: nodeParam },
    { name:'get_hardware_health', description:'System health: CPU, memory, uptime.', input_schema: nodeParam },
    { name:'get_ospf_health',     description:'OSPF health: adjacency states, interface detail (timers, cost, passive flag, MTU), LSDB summary, routes. Use for backbone OSPF faults.', input_schema: nodeParam },
    { name:'get_ldp_mpls_health', description:'LDP/MPLS health: session state, neighbor table, auth drop stats, inet.3 table, kernel MPLS. Use for LDP or MPLS LSP faults.', input_schema: nodeParam },
    { name:'get_evpn_health',     description:'EVPN health: EVPN database, BGP EVPN routes, VRF route-target config. Use for DC2 EVPN faults.', input_schema: nodeParam },
    { name:'get_l3vpn_health',    description:'L3VPN health: VPN instances, VPNv4 BGP table, RD/RT config. Use for pe1/pe2 L3VPN faults.', input_schema: nodeParam },
    { name:'ping', description:'Ping from a node to test reachability.', input_schema:{ type:'object', properties:{ node:{type:'string'}, destination:{type:'string'}, count:{type:'number'}, source:{type:'string'}, vrf:{type:'string'}, routing_instance:{type:'string'} }, required:['node','destination'] }},
    { name:'run_command', description:'Run any show command on a node (escape hatch — prefer composite tools first).', input_schema:{ type:'object', properties:{ node:{type:'string'}, command:{type:'string'} }, required:['node','command'] }},
    { name:'list_nodes', description:'List all available lab nodes.', input_schema:{ type:'object', properties:{}, required:[] }},
  ];

  // ── Agentic loop ──────────────────────────────────────────────────────────
  const isOllama = model && !model.startsWith('claude');

  try {
    if (isOllama) {
      // Ollama: single-shot (no native tool use in most local models)
      const r = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer ollama'},
        body: JSON.stringify({ model, max_tokens:4096,
          messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}] })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message||`Ollama HTTP ${r.status}`);
      llmResponse = d.choices?.[0]?.message?.content||'';
      // Extract text tool mentions for scoring
      const TOOLS = ['get_bgp_health','get_overlay_health','get_underlay_health','get_bfd_health',
        'get_hardware_health','get_ospf_health','get_ldp_mpls_health','get_evpn_health','get_l3vpn_health','ping','run_command'];
      const seen = new Set();
      for (const t of TOOLS)
        for (const m of llmResponse.matchAll(new RegExp(t + '[\\s(]+(\\w[\\w-]+)', 'g'))) {
          const key = `${t}:${m[1]}`.toLowerCase();
          if (!seen.has(key)) { seen.add(key); toolCalls.push({ command:t, node:m[1], type:'text_extracted' }); }
        }
    } else {
      // Claude: real agentic tool-use loop
      const messages = [{ role:'user', content: userPrompt }];
      let iterations = 0;
      const MAX_ITER = 8;

      while (iterations < MAX_ITER) {
        iterations++;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({
            model: model || 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            system: systemPrompt,
            tools: TOOL_DEFS,
            messages,
          })
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
              toolCalls.push({ command:block.name, node:block.input.node||'', type:'mcp_composite', tool_use_id:block.id });
            } catch(e) {
              result = JSON.stringify({ error: e.message });
            }
            toolResults.push({ type:'tool_result', tool_use_id:block.id, content:result });
          }
          messages.push({ role:'user', content: toolResults });
          continue;
        }

        // Any other stop reason — extract text and bail
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
    const autoScore  = scoreResponse(llmResponse, toolCalls, fault_meta||{});
    db.prepare("UPDATE live_runs SET status=?,llm_response=?,tool_calls=?,auto_score=?,duration_ms=? WHERE id=?")
      .run('complete', llmResponse, JSON.stringify(toolCalls), JSON.stringify(autoScore), durationMs, run_id);
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

  const scoreBreakdown = `Total: ${autoScore.total}/100 (${autoScore.grade})
- Root Cause: ${autoScore.root_cause}/40  Tool Sequence: ${autoScore.tool_sequence}/30
- Fix Proposed: ${autoScore.fix_proposed}/20  Efficiency: ${autoScore.efficiency}/10`;

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

app.listen(PORT, () => console.log(`netops-runner backend on :${PORT}`));
