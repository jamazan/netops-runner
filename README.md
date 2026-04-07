# NetOps Runner

An LLM evaluation platform for network engineering skills. Injects real faults into a live ContainerLab DC1 fabric, then asks Claude to diagnose using live device state via MCP tools. Auto-scores responses on trigger detection, skill chain discipline, output quality, and efficiency.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  NetOps Runner  (10.0.0.43)                     │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │   Frontend   │  │       Backend            │ │
│  │  (nginx:8080)│  │  (Node.js/Express:3001)  │ │
│  │  Vanilla JS  │  │  SQLite · SSH · Anthropic│ │
│  └──────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────┘
                          │ SSH (docker exec)
┌─────────────────────────────────────────────────┐
│  ContainerLab Host  (10.0.0.71)                 │
│  Lab: multi-site-fabric                         │
│  DC1: Arista cEOS 4.34.4M                       │
│  DC2: Juniper cRPD + WAN backbone + Campus      │
│                                                 │
│  faults/   — inject/restore scripts + JSON      │
│  skills/   — orchestrator SKILL.md files        │
└─────────────────────────────────────────────────┘
```

## Topology

| Domain | Vendor | Nodes | Protocols |
|--------|--------|-------|-----------|
| DC1 | Arista cEOS 4.34.4M | dc1-spine1/2, dc1-leaf1a/1b/2a/2b | eBGP underlay (AS65100/65101/65102), EVPN/VXLAN overlay |
| DC2 | Juniper cRPD | dc2-spine1/2, dc2-leaf1a/1b/2a/2b | eBGP underlay, L3-only EVPN/VXLAN |
| WAN/MPLS | Juniper cRPD | pe1, pe2, p1–p6, rr1 | OSPF, LDP, iBGP + RR, L3VPN |
| Campus | Arista cEOS | campus1/2-spine1/2, campus1/2-leaf1a/1b/2a/2b | eBGP |

### DC1 Reference (primary eval target)

```
dc1-spine1  Lo0=10.255.0.1  AS65100  (EVPN route-reflector)
dc1-spine2  Lo0=10.255.0.2  AS65100
dc1-leaf1a  Lo0=10.255.0.3  Lo1=10.255.1.3  AS65101  MLAG domain DC1_L3_LEAF1 (Po3 peer-link)
dc1-leaf1b  Lo0=10.255.0.4  Lo1=10.255.1.3  AS65101  MLAG domain DC1_L3_LEAF1
dc1-leaf2a  Lo0=10.255.0.5  Lo1=10.255.1.5  AS65102  MLAG domain DC1_L3_LEAF2 (Po3 peer-link)
dc1-leaf2b  Lo0=10.255.0.6  Lo1=10.255.1.5  AS65102  MLAG domain DC1_L3_LEAF2

VNIs: 10011→VLAN11, 10012→VLAN12, 10021→VLAN21, 10022→VLAN22
VRFs: VRF10 (L3VNI=10), VRF11 (L3VNI=11)
```

---

## EVPN NOC Eval — 20 DC1 Fault Cases

The primary evaluation mode. Each case injects a real fault into DC1 via `docker exec`, runs Claude with the `evpn-noc-triage` skill against live device state, and auto-scores the response.

### How it works

```
Click case in EVPN NOC tab
        │
        ▼
⚡ Inject fault  ──► backend SSH → docker exec on 10.0.0.71
        │             clab-multi-site-fabric-dc1-<node> Cli -p 15 -c "..."
        ▼
▶ Run Claude  ──► backend calls Anthropic API with evpn-noc-triage skill
        │         Claude issues tool calls against live DC1 state (MCP)
        ▼
Auto-score  ──► scoreResponse() grades trigger / skill chain / output / time
        │
        ▼
↺ Restore  ──► restores DC1 to clean state
```

### Eval mode toggle

Each case detail panel has a **⚡ Live Run / ✎ Manual Grade** toggle:
- **Live Run** (default): Inject → Run Claude → auto-scored results
- **Manual Grade**: Paste skills invoked + RCA text → grade without injection

### Cases by domain

| # | Domain | Case | Fault injected |
|---|--------|------|----------------|
| 01 | Underlay | Underlay Neighbor Down | spine1 Et1 shutdown → leaf1a BGP Idle |
| 02 | Underlay | Remote VTEP Unreachable | leaf2a Et1+Et2 shutdown → VTEP 10.255.1.5 unreachable |
| 03 | Underlay | Interface Flap and Route Loss | leaf2a Et1 shutdown → route loss |
| 04 | Underlay | CP CPU Spike — Multi-Adjacency Drop | spine1 Et1–Et4 all shutdown |
| 05 | EVPN Overlay | EVPN BGP Session Down | leaf2a EVPN-OVERLAY-PEERS deactivated |
| 06 | EVPN Overlay | EVPN Route Withdrawal Flap | leaf1a vxlan vlan 11 vni 10011 removed |
| 07 | EVPN Overlay | Missing Type-2 Route (RT Mismatch) | leaf1a VNI 10011 RT → 10011:99999 |
| 08 | EVPN Overlay | Missing Type-5 Route (L3VPN) | leaf1a VRF VRF11 redistribute connected removed |
| 09 | EVPN Overlay | Route-Target Mismatch | leaf2a VNI 10012 RT → 10012:88888 |
| 10 | EVPN Overlay | VNI Not Active on Leaf | leaf1b vxlan vlan 22 vni 10022 removed |
| 11 | MLAG | Peer-Link Degradation | leaf1a Et3 (Po3 member) shutdown |
| 12 | MLAG | MLAG Consistency Mismatch | leaf2b Po5 VLAN 21 removed from trunk |
| 13 | MLAG | Orphan Port Symptom *(75% recall)* | leaf1a Po24 MLAG-ID 24 created without peer config |
| 14 | Endpoint | Host Not Learning Remote MAC | leaf1a VNI 10011 RT import → 10011:77777 |
| 15 | Endpoint | ARP Resolution Failure *(83% recall)* | leaf2b Et8 shutdown |
| 16 | Endpoint | Tenant VRF Reachability Failure | leaf2a vxlan vrf VRF11 vni 11 removed |
| 17 | Noisy/Evidence | Noisy Logs — Single Root Cause | spine2 Et3 shutdown → BGP notification storm |
| 18 | Noisy/Evidence | Stale NetBox Intent | leaf1b VNI 10012 RT → 10012:55555 |
| 19 | Noisy/Evidence | Multi-Symptom — One Root Cause | leaf2a Et1 shutdown (matches NOC-CR-982) |
| 20 | Noisy/Evidence | False-Positive Endpoint *(known failure)* | leaf1a Et9 shutdown (host OS upgrade) |

Cases marked *(known failure)* are benchmark regression tests — the model is expected to struggle.

### Scoring dimensions (EVPN NOC)

| Dimension | Points | What is graded |
|-----------|--------|----------------|
| Trigger | 35 | Correct fault domain identified, must-not-invoke skills absent |
| Skill Chain | 25 | Expected skills fired in correct order |
| Output Quality | 20 | RCA accuracy, device/interface named, remediation correct |
| Time | 10 | Completed within 120 seconds |
| Token efficiency | 10 | Tool call count vs optimal sequence |

**PASS** ≥ 70 · **PARTIAL** ≥ 45 · **FAIL** < 45

---

## Lab Tests — 30+ Legacy Fault Scenarios

Original fault library targeting all topology domains. Runs against the general diagnostic skill pipeline.

### Easy — Protocol-specific, single device

| ID | Device | Fault |
|----|--------|-------|
| arista-bgp-auth | dc1-leaf1b | EVPN BGP auth mismatch |
| arista-bgp-maxprefix | dc1-spine1 | Max-prefix exceeded toward leaf2a |
| arista-bfd-timers | dc1-leaf2a | BFD disabled on EVPN peer group |
| arista-evpn-redistribute | dc1-leaf1b | redistribute learned removed VLAN 11 |
| arista-evpn-rt | dc1-leaf1b | Wrong RT export on VLAN 11 |
| arista-isis-overload | dc1-spine2 | ECMP max-paths set to 1 |
| backbone-bgp-export | pe1 | BGP export policy removed ibgp-rr |
| backbone-ldp-auth | p1 | Wrong LDP auth key to p5 |
| backbone-ldp-session | pe1 | Targeted LDP session to p1 deleted |
| backbone-ospf-cost | pe1 | OSPF metric 1000 on eth1 toward p1 |
| backbone-ospf-passive | p5 | OSPF passive on eth1 toward rr1 |
| juniper-bgp-export | dc2-spine1 | BGP export policy removed LEAF-UNDERLAY |
| juniper-bgp-underlay | dc2-leaf1a | SPINE-UNDERLAY export policy removed |
| juniper-evpn-vrf-target | dc2-leaf1a | TENANT-A RT changed to wrong value |
| ospf-exstart-mtu | dc1-spine1 | Max-routes 1 toward dc1-leaf1a |

### Medium — Multi-device, realistic NOC scenarios

| ID | Scope | Fault |
|----|-------|-------|
| bgp-leaf2a-active | dc1-leaf2a | EVPN sessions to both spines Active |
| wf-bgp-leaf2-flap | dc1-leaf2a/2b | EVPN auth broken on both leaf2 nodes |
| wf-evpn-type2-missing | dc1-leaf1a | MACs not advertised from VLAN 11 |
| wf-backbone-ospf-cost | pe1 | Suboptimal MPLS path via inflated metric |
| wf-ospf-p1-p2-flap | p1 | OSPF passive on p1→p2, LDP drops |
| wf-spine1-bgp-underlay | dc1-spine1 | All leaf underlay sessions drop |

### Hard — Orchestrator skill, full triage required

| ID | Skill | Symptom |
|----|-------|---------|
| orch-l3ls-bgp-auth | arista-l3ls | Host reachability lost — DC1 leaf1b pod |
| orch-l3ls-evpn-redistribute | arista-l3ls | MAC learning failure — DC1 leaf1b VLAN 11 |
| orch-l3ls-ecmp | arista-l3ls | Asymmetric traffic — dc1-spine2 underutilized |
| orch-juniper-dc-bgp-export | juniper-dc-fabric | DC2 leaf reachability degraded from spine1 |
| orch-juniper-dc-evpn-rt | juniper-dc-fabric | DC2 TENANT-A prefix reachability lost |
| orch-sp-backbone-ospf-passive | juniper-sp-backbone | rr1 unreachable — iBGP sessions dropping |
| orch-sp-backbone-ldp | juniper-sp-backbone | MPLS forwarding degraded — p1 to pe1 |
| orch-wan-bgp-export | multivendor-wan | VPN routes not reaching rr1 from pe1 |
| orch-dci-evpn-rt | multivendor-dci | Cross-DC reachability lost — DC1 to DC2 |

### Legacy scoring

| Dimension | Points | Criteria |
|-----------|--------|---------|
| Root Cause | 40 | Keywords from `root_cause` field matched |
| Tool Sequence | 30 | Optimal tool sequence followed |
| Fix Proposed | 20 | Fix command mentioned in response |
| Efficiency | 10 | Tool call count vs optimal |

**PASS** ≥ 80 · **PARTIAL** ≥ 50 · **FAIL** < 50

---

## Fault File Format

### EVPN NOC faults (embedded in backend)

The 20 DC1 EVPN NOC fault definitions are embedded directly in `backend/server.js` as `EVPN_NOC_FAULTS`. Inject/restore commands run via SSH → `docker exec clab-multi-site-fabric-<node>` on the clab host. No external script files needed.

### Legacy faults (file-based)

Each legacy fault requires three files in `faults/`:

```
faults/
  <id>.json          # Fault metadata + scoring hints
  <id>-inject.sh     # Breaks something in the topology
  <id>-restore.sh    # Restores to clean state
  skills/            # Orchestrator SKILL.md files
    evpn-noc-triage.md
```

#### JSON schema
```json
{
  "id": "arista-bgp-auth",
  "skill": "arista-bgp-troubleshooter",
  "difficulty": "easy",
  "title": "Human-readable title",
  "device": "dc1-leaf1b",
  "symptom": "What the LLM is told",
  "root_cause": "Ground truth for auto-scoring",
  "fix_command": "Exact CLI fix used for scoring",
  "optimal_tool_sequence": ["show bgp evpn summary", "..."]
}
```

---

## Deployment

### Prerequisites
- Docker + Docker Compose on the runner host (10.0.0.43)
- ContainerLab `multi-site-fabric` topology running on clab host (10.0.0.71)
- SSH key at `ssh/server` (mounted read-only into the backend container)
- Anthropic API key

### Runner setup
```bash
git clone https://github.com/jamazan/netops-runner
cd netops-runner

# SSH key for clab host access
cp ~/.ssh/your_clab_key ssh/server
chmod 600 ssh/server

# Configure environment
cp .env.example .env
# Edit .env with your values

# Build and start
docker compose up -d
```

> **Important:** The frontend is baked into the nginx image at build time (`COPY index.html`).
> After any `frontend/index.html` change, rebuild — don't just restart:
> ```bash
> docker compose build frontend && docker compose up -d frontend
> ```

### First login
```bash
docker logs netops-backend | grep -A3 "FIRST BOOT"
```
Use the printed bootstrap token at `http://<runner-host>:8080` to create your admin account.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for LLM runs |
| `PORT` | Backend port (default: 3001) |
| `DB_PATH` | SQLite database path |
| `CLAB_HOST` | ContainerLab host IP (default: 10.0.0.71) |
| `CLAB_USER` | SSH user for clab host (default: jamazan) |
| `CLAB_KEY` | SSH private key path inside container (default: /app/ssh/server) |
| `CLAB_LAB_NAME` | ContainerLab lab name (default: multi-site-fabric) |
| `FAULT_DIR` | Legacy fault scripts directory on clab host |
| `CEOS_MCP_URL` | Arista cEOS MCP server URL (default: http://10.0.0.71:8085) |
| `CRPD_MCP_URL` | Juniper cRPD MCP server URL (default: http://10.0.0.71:8084) |
| `SKILLS_MCP_URL` | Skills MCP server URL (default: http://10.0.0.71:8083) |
| `CORS_ORIGIN` | Allowed CORS origins (comma-separated) |
| `SKILLS_REPO` | Git URL of the skills repository |
| `SKILLS_REPO_PATH` | Clone path on the clab host |
| `SKILLS_DIR` | Directory where skills are synced to |
| `SKILLS_REPO_TOKEN` | Personal access token for clone + push |
| `SKILLS_REPO_BRANCH` | Branch to sync (default: main) |

---

## Adding New EVPN NOC Cases

Edit `EVPN_NOC_FAULTS` in `backend/server.js` and `EVPN_NOC_CASES` in `frontend/index.html`:

```js
// backend/server.js — add to EVPN_NOC_FAULTS
'evpn-noc-21': {
  id: 'evpn-noc-21',
  title: 'Your case title',
  device: 'dc1-leaf1a',
  fault_domain: 'underlay',
  inject:  `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\n...\nend"`,
  restore: `${DOCKER}-dc1-leaf1a Cli -p 15 -c "configure\n...\nend"`,
  expected_skills: ['get-intent', 'get-fabric-state', 'diagnose-underlay', 'produce-rca'],
  must_not_invoke: ['evpn.check-control-plane', 'diagnose-mlag'],
},
```

Then add the corresponding entry to `EVPN_NOC_CASES` in `frontend/index.html` and add the key to `EVPN_NOC_LIVE_IDS`.

Rebuild the frontend image after any `index.html` changes:
```bash
docker compose build frontend && docker compose up -d frontend
```

## Adding New Legacy Faults

1. Create `faults/<id>.json` with the schema above
2. Create `faults/<id>-inject.sh` — must exit 0 on success
3. Create `faults/<id>-restore.sh` — must restore topology to clean state
4. Copy all three files to `FAULT_DIR` on the clab host
5. The fault appears automatically in the Lab Tests tab on next page load

```bash
# Test on the clab host:
bash faults/<id>-inject.sh && sleep 3 && bash faults/<id>-restore.sh
```

---

## Skills Optimizer

Uses failed lab runs to automatically improve the SKILL.md documents that guide Claude during diagnosis.

```
Run Lab Test
     │
     ▼
Score < PASS?
     │ yes
     ▼
◈ OPTIMIZE SKILL button appears
     │
     ▼
Claude Sonnet analyzes:
  - Current SKILL.md content
  - Fault scenario + ground truth
  - LLM response + score breakdown
     │
     ▼
Returns proposed changes + full improved SKILL.md
     │
     ▼
Diff modal shown to user
     │
     ├── ✓ APPLY PATCH ──► Writes to clab host → commits to skills repo → RE-RUN available
     └── ✕ DISCARD ──────► No changes made
```

---

## Skills Repository

Skill documents are versioned in an external git repo and synced to the clab host at runtime.

```
GitHub (konekti/agent-neo)
  .claude/skills/<n>/SKILL.md
         │  git pull (on sync)
         ▼
clab host: SKILLS_DIR/<n>/SKILL.md
         │  SSH fetch (per run)
         ▼
Backend injects into LLM system prompt
```

From the **Admin** panel → **Skills Repository**: view repo status, sync from remote, or trigger via API:
```bash
curl -X POST http://<runner-host>:8080/api/skills/sync \
  -H "X-Session-Id: <sid>"
```

---

## Tech Stack

- **Frontend**: Vanilla JS, IBM Plex Mono, nginx (image rebuilt on every `index.html` change)
- **Backend**: Node.js + Express, better-sqlite3, node-ssh
- **LLM**: Anthropic `claude-sonnet-4-6` (runs), `claude-haiku-4-5` (legacy scorer)
- **Auth**: Session cookies, role system (admin/user), password change on first login
- **Topology**: ContainerLab `multi-site-fabric` — Arista cEOS 4.34.4M + Juniper cRPD
