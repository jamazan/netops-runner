# NetOps Runner

An LLM evaluation platform for network engineering skills. Injects real faults into a live ContainerLab multi-vendor topology, then asks Claude to diagnose using live device state via MCP tools. Auto-scores responses on root cause identification, tool sequence, fix proposal, and efficiency.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  NetOps Runner (10.0.0.43)                      │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │   Frontend   │  │       Backend            │ │
│  │  (nginx:8080)│  │  (Node.js/Express:3001)  │ │
│  │  Vanilla JS  │  │  SQLite · SSH · Anthropic│ │
│  └──────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────┘
                          │ SSH
┌─────────────────────────────────────────────────┐
│  ContainerLab Host (10.0.0.71)                  │
│  Multi-site fabric: DC1 (Arista cEOS) +         │
│  DC2 (Juniper cRPD) + WAN backbone (Juniper)    │
│  + Campus (Arista cEOS)                         │
│                                                 │
│  faults/   — inject/restore scripts + JSON      │
│  skills/   — orchestrator SKILL.md files        │
└─────────────────────────────────────────────────┘
```

## Topology

| Domain | Vendor | Nodes | Protocols |
|--------|--------|-------|-----------|
| DC1 | Arista cEOS | dc1-spine1/2, dc1-leaf1a/1b/2a/2b | eBGP underlay, EVPN/VXLAN overlay |
| DC2 | Juniper cRPD | dc2-spine1/2, dc2-leaf1a/1b/2a/2b | eBGP underlay, L3-only EVPN/VXLAN |
| WAN/MPLS | Juniper cRPD | pe1, pe2, p1-p6, rr1 | OSPF, LDP, iBGP + RR, L3VPN |
| Campus | Arista cEOS | campus1/2-spine1/2, campus1/2-leaf1a/1b/2a/2b | eBGP |

## Lab Tests — 30 Fault Scenarios

Tests are organized in three tiers of difficulty:

### Sub-skill (15) — Protocol-specific, single device
The LLM is given a specific protocol context and must diagnose a known failure layer.

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

### Workflow (6) — Multi-device, realistic NOC scenarios
Broader scope — may involve multiple devices or require cross-layer correlation.

| ID | Scope | Fault |
|----|-------|-------|
| bgp-leaf2a-active | dc1-leaf2a | EVPN sessions to both spines Active |
| wf-bgp-leaf2-flap | dc1-leaf2a/2b | EVPN auth broken on both leaf2 nodes |
| wf-evpn-type2-missing | dc1-leaf1a | MACs not advertised from VLAN 11 |
| wf-backbone-ospf-cost | pe1 | Suboptimal MPLS path via inflated metric |
| wf-ospf-p1-p2-flap | p1 | OSPF passive on p1→p2, LDP drops |
| wf-spine1-bgp-underlay | dc1-spine1 | All leaf underlay sessions drop |

### Orchestrator (9) — High-level symptom only, full triage required
Only a vague symptom is given. The LLM must use the orchestrator skill to identify the layer, dispatch to sub-skills, and find the root cause.

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

## Scoring

Each lab run is auto-scored by a second Claude call (Haiku) across 4 dimensions:

| Dimension | Points | Criteria |
|-----------|--------|---------|
| Root Cause | 40 | Keywords from `root_cause` field matched in response |
| Tool Sequence | 30 | Optimal tool sequence followed |
| Fix Proposed | 20 | Fix command mentioned in response |
| Efficiency | 10 | Tool call count vs optimal |

**PASS** ≥ 80 · **PARTIAL** ≥ 50 · **FAIL** < 50

Skill Tests use a separate Claude Haiku scorer that evaluates each pass criterion (required/bonus) and returns per-criterion verdicts with confidence rating.

## Fault File Format

Each fault requires three files:

```
faults/
  <id>.json          # Fault metadata + scoring hints
  <id>-inject.sh     # Breaks something in the topology
  <id>-restore.sh    # Restores to clean state
  skills/            # Orchestrator SKILL.md files (fetched by backend)
```

### JSON schema
```json
{
  "id": "arista-bgp-auth",
  "skill": "arista-bgp-troubleshooter",
  "title": "Human-readable title",
  "device": "dc1-leaf1b",
  "mgmt_ip": "100.68.0.14",
  "symptom": "What the LLM is told — vague for orchestrator tests",
  "root_cause": "Ground truth used for auto-scoring",
  "fix_command": "Exact CLI fix used for scoring",
  "optimal_tool_sequence": ["show bgp evpn summary", "..."]
}
```

## Deployment

### Prerequisites
- Docker + Docker Compose on the runner host
- ContainerLab topology running on the clab host
- Anthropic API key

### Runner setup
```bash
git clone <this-repo>
cd netops-runner

# Copy SSH key for clab host access
cp ~/.ssh/your_clab_key ssh/server
chmod 600 ssh/server

# Configure environment in docker-compose.yml:
#   ANTHROPIC_API_KEY, ADMIN_PASSWORD, CLAB_HOST, CLAB_USER, FAULT_DIR

docker compose up -d
```

### Fault library setup (on clab host)
```bash
# Copy faults directory to clab host
scp -r faults/ user@clab-host:/home/user/netclaw-faults/

# The FAULT_DIR env var in docker-compose.yml must point to this path
```

### First login
On first boot, an admin bootstrap token is printed to the backend logs:
```bash
docker logs netops-backend | grep -A3 "FIRST BOOT"
```

Use that token at `http://<runner-host>:8080` to create your admin account.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Anthropic API key for LLM runs |
| `ADMIN_PASSWORD` | `netops-admin-changeme` | Admin panel password |
| `PORT` | `3001` | Backend port |
| `DB_PATH` | `/app/data/netops.db` | SQLite database path |
| `CLAB_HOST` | `10.0.0.71` | ContainerLab host IP |
| `CLAB_USER` | `jamazan` | SSH user for clab host |
| `CLAB_KEY` | `/app/ssh/server` | SSH private key path (mounted) |
| `FAULT_DIR` | `/home/jamazan/netclaw-faults` | Fault scripts directory on clab host |
| `CORS_ORIGIN` | `http://localhost:8080` | Allowed CORS origins |

## Adding New Faults

1. Create `faults/<id>.json` with the schema above
2. Create `faults/<id>-inject.sh` — must exit 0 on success
3. Create `faults/<id>-restore.sh` — must restore topology to clean state
4. Copy all three files to `FAULT_DIR` on the clab host
5. The fault appears automatically in the Lab Tests tab on next page load

### Testing scripts
```bash
# On the clab host:
bash faults/<id>-inject.sh && sleep 3 && bash faults/<id>-restore.sh
```

## Tech Stack

- **Frontend**: Vanilla JS, IBM Plex Mono, served by nginx
- **Backend**: Node.js + Express, better-sqlite3, node-ssh
- **LLM**: Anthropic claude-sonnet-4-6 (runs), claude-haiku-4-5 (scores)
- **Auth**: Invite token system with session cookies
- **Topology**: ContainerLab multi-site fabric (Arista cEOS + Juniper cRPD)
