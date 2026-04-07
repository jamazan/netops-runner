// ── NetOps Runner — Eval Framework ──────────────────────────────────────────
// Skill invocation panel, tool call trace, skills vs no-skills comparison
// Loaded as external script to avoid inline escaping issues

let evalMode = 'single';

function setEvalMode(mode) {
  evalMode = mode;
  document.getElementById('evalmode-single').classList.toggle('active', mode === 'single');
  document.getElementById('evalmode-compare').classList.toggle('active', mode === 'compare');
  document.getElementById('evalmode-hint').textContent = mode === 'single'
    ? 'Run Claude with your skill injected into the system prompt'
    : 'Run twice: WITH skill then WITHOUT — compare scores side by side';
}

function toggleSkillPreview(btn) {
  const prev = document.getElementById('skill-invoc-preview');
  const show = prev.style.display === 'none';
  prev.style.display = show ? 'block' : 'none';
  btn.textContent = show ? 'HIDE CONTENT ▴' : 'SHOW CONTENT ▾';
}

function renderSkillPanel(skillName, skillSource, skillContent) {
  const panel = document.getElementById('skill-invoc-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  document.getElementById('skill-invoc-name').textContent = skillName || 'unknown';
  const src = skillSource || 'unknown';
  const badge = document.getElementById('skill-invoc-badge');
  badge.textContent = src.toUpperCase();
  badge.className = 'skill-source-badge ' + src;
  const prev = document.getElementById('skill-invoc-preview');
  if (prev) {
    prev.textContent = skillContent
      ? skillContent.slice(0, 900) + (skillContent.length > 900 ? '\n...' : '')
      : '(no content)';
    prev.style.display = 'none';
  }
  const togBtn = panel.querySelector('.skill-toggle-btn');
  if (togBtn) togBtn.textContent = 'SHOW CONTENT ▾';
}

function renderToolTrace(toolCalls, optimalSequence) {
  const section = document.getElementById('tool-trace-section');
  const timeline = document.getElementById('tool-trace-timeline');
  const effLabel = document.getElementById('tool-trace-efficiency-label');
  if (!section) return;
  if (!toolCalls || !toolCalls.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const optimal = (optimalSequence || []).map(function(s) { return s.toLowerCase(); });
  let chips = '';
  toolCalls.forEach(function(tc, i) {
    const name = (tc.command || '').toLowerCase();
    const node = tc.node || '';
    const oi = optimal.indexOf(name);
    const goodPos = oi !== -1 && Math.abs(oi - i) <= 1;
    const cls = goodPos ? 'optimal' : oi !== -1 ? 'suboptimal' : 'extra';
    const icon = cls === 'optimal' ? '✓' : cls === 'suboptimal' ? '~' : '×';
    chips += '<span class="tool-chip ' + cls + '">'
      + '<span style="font-size:9px;opacity:0.6">' + (i + 1) + '</span> '
      + icon + ' ' + escHtml(name)
      + (node ? '(' + escHtml(node) + ')' : '')
      + '</span>';
    if (i < toolCalls.length - 1) chips += '<span class="tool-chip-arrow">→</span>';
  });
  timeline.innerHTML = chips;
  const extra = toolCalls.filter(function(tc, i) {
    const n = (tc.command || '').toLowerCase();
    const oi = optimal.indexOf(n);
    return oi === -1 || Math.abs(oi - i) > 1;
  }).length;
  if (effLabel) {
    effLabel.textContent = extra === 0
      ? '✓ Optimal path — ' + toolCalls.length + ' call' + (toolCalls.length !== 1 ? 's' : '')
      : extra + ' extra call' + (extra > 1 ? 's' : '') + ' beyond optimal path';
    effLabel.style.color = extra === 0 ? 'var(--green)' : extra <= 2 ? 'var(--yellow)' : 'var(--red)';
  }
}

function renderCompareResults(d1, d2) {
  const section = document.getElementById('compare-results-section');
  const grid = document.getElementById('compare-grid');
  const summary = document.getElementById('impact-summary');
  if (!section) return;
  section.style.display = 'block';

  const FIELDS = [
    { l: 'TOTAL',      k: 'total',         max: 100 },
    { l: 'ROOT CAUSE', k: 'root_cause',    max: 40  },
    { l: 'TOOL SEQ',   k: 'tool_sequence', max: 30  },
    { l: 'FIX',        k: 'fix_proposed',  max: 20  },
    { l: 'EFFICIENCY', k: 'efficiency',    max: 10  }
  ];

  function col(res, isSkill) {
    const s = res.auto_score || {};
    const other = isSkill ? (d2.auto_score || {}) : (d1.auto_score || {});
    const title = isSkill ? '⚡ WITH SKILL' : '○ WITHOUT SKILL';
    const tcls = isSkill ? 'with-skill' : 'no-skill';
    const gc = s.grade || 'FAIL';
    const pct = Math.round(((s.total || 0) / 100) * 100);

    const rows = FIELDS.map(function(fld) {
      const mine = s[fld.k] || 0;
      const theirs = other[fld.k] || 0;
      const d = mine - theirs;
      const vc = isSkill ? (d >= 0 ? 'better' : 'worse') : (d <= 0 ? 'better' : 'worse');
      const dc = d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero';
      const ds = d > 0 ? '+' + d : String(d);
      return '<div class="compare-score-row">'
        + '<span class="compare-score-label">' + fld.l + '</span>'
        + '<span class="compare-score-val ' + vc + '">' + mine + '/' + fld.max
        + ' <span class="compare-delta ' + dc + '">' + (d === 0 ? '=' : ds) + '</span>'
        + '</span></div>';
    }).join('');

    const raw = res.llm_response || '';
    const excerpt = escHtml(raw.slice(0, 300)) + (raw.length > 300 ? '...' : '');

    return '<div class="compare-col">'
      + '<div class="compare-col-title ' + tcls + '">' + title + '</div>'
      + '<div class="compare-grade ' + gc + '">' + gc + ' — ' + (s.total || 0) + '/100</div>'
      + '<div class="skill-impact-bar">'
      + '<div class="skill-impact-fill ' + tcls + '" style="width:' + pct + '%"></div></div>'
      + rows
      + '<div class="section-header" style="margin-top:8px;font-size:10px">▸ RESPONSE EXCERPT</div>'
      + '<div class="compare-response">' + excerpt + '</div>'
      + '</div>';
  }

  grid.innerHTML = col(d1, true) + col(d2, false);

  const s1total = d1.auto_score ? (d1.auto_score.total || 0) : 0;
  const s2total = d2.auto_score ? (d2.auto_score.total || 0) : 0;
  const delta = s1total - s2total;
  const sign = delta > 0 ? '+' : '';
  const color = delta > 5 ? 'var(--green)' : delta < -5 ? 'var(--red)' : 'var(--yellow)';
  const arrow = delta > 5 ? '↑' : delta < -5 ? '↓' : '↔';
  const msg = delta > 10  ? 'Significant improvement with skill'
            : delta > 0   ? 'Marginal improvement with skill'
            : delta === 0 ? 'No difference detected'
            : delta > -10 ? 'Slight regression — consider optimizing'
            :               'Skill hurting performance — review and optimize';

  if (summary) {
    summary.innerHTML = arrow + ' Skill impact: <span style="color:' + color
      + ';font-weight:700">' + sign + delta + ' pts</span> — ' + msg;
  }
}


// -- Eval Suite Functions ---
let suitePoller = null;

async function startSuite() {
  const btn = document.getElementById("suite-run-btn");
  const statusLbl = document.getElementById("suite-status-label");
  btn.disabled = true;
  btn.textContent = "Starting...";
  statusLbl.textContent = "";
  try {
    const r = await fetch(API + "/eval/suite/run", {
      method: "POST", headers: headers(), credentials: "include"
    });
    const d = await r.json();
    if (!r.ok) {
      statusLbl.textContent = "Error: " + (d.error || "Failed to start");
      btn.disabled = false; btn.textContent = "Run Full Suite"; return;
    }
    statusLbl.textContent = "Running " + d.total + " faults...";
    document.getElementById("suite-progress-wrap").style.display = "block";
    document.getElementById("suite-results-wrap").style.display = "none";
    document.getElementById("suite-export-btn").disabled = true;
    document.getElementById("suite-domain-summary").style.display = "none";
    pollSuiteStatus();
  } catch(e) {
    statusLbl.textContent = "Error: " + e.message;
    btn.disabled = false; btn.textContent = "Run Full Suite";
  }
}

function pollSuiteStatus() {
  if (suitePoller) clearInterval(suitePoller);
  suitePoller = setInterval(async () => {
    try {
      const r = await fetch(API + "/eval/suite/status", { headers: headers(), credentials: "include" });
      const d = await r.json();
      updateSuiteUI(d);
      if (!d.running) { clearInterval(suitePoller); suitePoller = null; }
    } catch {}
  }, 2500);
}

function updateSuiteUI(d) {
  const fill = document.getElementById("suite-progress-fill");
  const pct = d.total > 0 ? Math.round((d.progress / d.total) * 100) : 0;
  if (fill) fill.style.width = pct + "%";
  const pl = document.getElementById("suite-progress-label");
  const pc = document.getElementById("suite-progress-count");
  if (pl) pl.textContent = d.running ? "Running fault " + d.progress + "..." : "Suite complete";
  if (pc) pc.textContent = d.progress + " / " + d.total;
  const statusLbl = document.getElementById("suite-status-label");
  const btn = document.getElementById("suite-run-btn");
  if (!d.running) {
    if (btn) { btn.disabled = false; btn.textContent = "Run Full Suite"; }
    if (statusLbl && d.startedAt) {
      const elapsed = Math.round((Date.now() - d.startedAt) / 1000);
      statusLbl.textContent = "Completed in " + elapsed + "s";
    }
    document.getElementById("suite-export-btn").disabled = false;
  }
  if (d.results && d.results.length) renderSuiteResults(d.results);
}

function renderSuiteResults(results) {
  const tbody = document.getElementById("suite-results-body");
  if (!tbody) return;
  tbody.innerHTML = results.map(r => {
    const s = r.auto_score || {};
    const grade = s.grade || "--";
    const total = s.total != null ? s.total : "--";
    const dur = r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + "s" : "--";
    const skills = (r.skills_fired || []).join(", ") || "--";
    const reg = s.time_regression || "";
    const statusIcon = r.status === "error" ? "! " : r.status !== "complete" ? "... " : "";
    const gradeColor = grade === "PASS" ? "var(--green)" : grade === "FAIL" ? "var(--red)" : "var(--yellow)";
    function badge(pass) {
      if (pass === null || pass === undefined) return "<span style=color:var(--text-dim)>--</span>";
      return pass ? "<span style=color:var(--green);font-weight:700>pass</span>"
                  : "<span style=color:var(--red);font-weight:700>fail</span>";
    }
    return "<tr>"
      + "<td style=font-family:monospace;font-size:11px>" + statusIcon + escHtml(r.fault_id) + "</td>"
      + "<td>" + escHtml(r.fault_domain || "?") + "</td>"
      + "<td style=font-weight:700>" + total + "</td>"
      + "<td style=color:" + gradeColor + ";font-weight:700>" + grade + "</td>"
      + "<td style=text-align:center>" + badge(s.quality_pass) + "</td>"
      + "<td style=text-align:center>" + badge(s.time_pass) + "</td>"
      + "<td style=font-size:11px;color:var(--text-mid)>" + dur + "</td>"
      + "<td style=font-size:10px;color:var(--text-dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap title=" + escHtml(skills) + ">" + escHtml(skills) + "</td>"
      + "<td style=font-size:10px;color:var(--red)>" + escHtml(reg) + "</td>"
      + "</tr>";
  }).join("");
  document.getElementById("suite-results-wrap").style.display = "block";

  const byDomain = {};
  results.forEach(r => {
    const dom = r.fault_domain || "unknown";
    if (!byDomain[dom]) byDomain[dom] = { total: 0, passed: 0 };
    byDomain[dom].total++;
    if (r.auto_score && r.auto_score.quality_pass) byDomain[dom].passed++;
  });
  const domSummary = document.getElementById("suite-domain-summary");
  if (domSummary) {
    domSummary.innerHTML = Object.entries(byDomain).map(([domain, stat]) => {
      const pct = Math.round((stat.passed / stat.total) * 100);
      const col = pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--yellow)" : "var(--red)";
      return "<div style=background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px>"
        + "<div style=font-size:10px;color:var(--text-dim);text-transform:uppercase;margin-bottom:4px>" + escHtml(domain) + "</div>"
        + "<div style=font-size:24px;font-weight:700;color:" + col + ">" + pct + "%</div>"
        + "<div style=font-size:11px;color:var(--text-dim)>" + stat.passed + " / " + stat.total + " pass</div>"
        + "</div>";
    }).join("");
    domSummary.style.display = "grid";
  }
}

function exportSuiteCSV() {
  fetch(API + "/eval/suite/status", { headers: headers(), credentials: "include" })
    .then(r => r.json())
    .then(d => {
      if (!d.results || !d.results.length) return;
      const rows = [["fault_id","fault_domain","score","grade","quality_pass","time_pass","duration_ms","skills_fired","regression"]];
      d.results.forEach(r => {
        const s = r.auto_score || {};
        rows.push([
          r.fault_id, r.fault_domain || "", s.total || "", s.grade || "",
          s.quality_pass ? "1" : "0", s.time_pass ? "1" : "0",
          r.duration_ms || "", (r.skills_fired || []).join("|"), s.time_regression || ""
        ]);
      });
      const csv = rows.map(row => row.map(v => "'" + String(v).replace(/"/g, "''") + "'").join(",")).join("
");
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "netops-suite-" + new Date().toISOString().slice(0,10) + ".csv";
      a.click();
    });
}
