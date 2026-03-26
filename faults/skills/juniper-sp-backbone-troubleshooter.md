---
name: juniper-sp-backbone-troubleshooter
description: >
  Orchestrate troubleshooting for a Juniper SP/WAN backbone running OSPF,
  LDP, MPLS, and iBGP with Route Reflectors. Use when investigating OSPF
  adjacency failures, LDP session loss, MPLS forwarding breakage, PE-to-RR
  BGP failures, or L3VPN customer reachability. Dispatches to Juniper
  sub-skills based on node role (P, PE, RR, CE) and symptom category.
---

# Juniper SP Backbone Troubleshooter (Orchestrator)

## Overview

A Juniper SP backbone uses a layered protocol stack where each layer depends
on the one below it. **Always troubleshoot bottom-up**: physical → OSPF →
LDP/MPLS → BGP → L3VPN.

```
  CE1 ──── PE1 ──── P1 ──── P5 ──── RR1
                      \              /
                       P2 ─── P6 ──
                      /              \
  CE2 ──── PE2 ──── P3 ──── P6 ──── RR1
                      \
                       P4

  Protocol stack per node:
  P nodes  : OSPF + LDP + MPLS  (transit forwarding only)
  RR node  : OSPF + LDP + MPLS + iBGP RR  (no VRF)
  PE nodes : OSPF + LDP + MPLS + iBGP to RR + L3VPN VRF
  CE nodes : eBGP to PE  (customer edge)
```

## Topology Reference: Roles and Sub-Skills

| Node Role | Protocols in play | Sub-skills to invoke (in order) |
|---|---|---|
| P node | OSPF, LDP, MPLS (kernel) | `juniper-ospf-troubleshooter`, `juniper-ldp-troubleshooter` |
| RR node | OSPF, LDP, MPLS, iBGP RR | `juniper-ospf-troubleshooter`, `juniper-ldp-troubleshooter`, `juniper-bgp-troubleshooter` |
| PE node | OSPF, LDP, MPLS, iBGP to RR, L3VPN | `juniper-ospf-troubleshooter`, `juniper-ldp-troubleshooter`, `juniper-bgp-troubleshooter`, `juniper-l3vpn-troubleshooter` |
| CE node (cRPD) | eBGP to PE | `juniper-bgp-troubleshooter` |
| Any node | Physical / optics | `juniper-layer1-troubleshooter` |
| Any node | BFD | `juniper-bfd-troubleshooter` |
| Any node | RE CPU / protection | `juniper-copp-troubleshooter` |

---

## Protocol Dependency Stack

```
  L3VPN (CUSTOMER1 VRF)       ← breaks if BGP VPNv4 routes missing
      ↑ depends on
  iBGP (PE ↔ RR)              ← breaks if OSPF/LDP broken (next-hop unreachable)
      ↑ depends on
  LDP (label distribution)    ← breaks if OSPF breaks (transport address unreachable)
      ↑ depends on
  OSPF (IGP, transport)       ← breaks if physical link fails
      ↑ depends on
  Physical / Layer 1          ← always check first
```

**Rule**: if a higher layer is broken, always verify the layer below it first
before invoking the higher-layer sub-skill.

---

## Decision Tree: Sub-Skill Dispatch

### Symptom: L3VPN customer route missing / CE unreachable
1. `juniper-layer1-troubleshooter` — CE-facing interface on PE.
2. `juniper-bgp-troubleshooter` — PE-CE eBGP session (CUSTOMER1 VRF).
3. `juniper-bgp-troubleshooter` — PE-to-RR iBGP VPNv4 session.
4. `juniper-l3vpn-troubleshooter` — CUSTOMER1 routing-instance, RT import/export, VRF label.
5. Verify MPLS transport (LDP check below) between PE1 and PE2.

### Symptom: iBGP PE-to-RR session down
1. `juniper-ospf-troubleshooter` — verify OSPF is up end-to-end (loopback reachability).
2. MPLS kernel check (below) — verify LDP labels installed for PE loopback.
3. `juniper-bgp-troubleshooter` — session state, hold timer, policy.

### Symptom: LDP session down between two nodes
1. `juniper-layer1-troubleshooter` — physical link between the nodes.
2. `juniper-ospf-troubleshooter` — OSPF adjacency on the same link (LDP transport depends on it).
3. `juniper-ldp-troubleshooter` — transport address, session state, label bindings.

### Symptom: OSPF adjacency not forming
1. `juniper-layer1-troubleshooter` — physical link, optics, IP connectivity.
2. `juniper-bfd-troubleshooter` — if BFD enabled, verify session.
3. `juniper-ospf-troubleshooter` — timer, area, MTU, auth mismatch.

### Symptom: MPLS traffic not forwarding (traceroute shows IP hops instead of MPLS)
1. MPLS kernel check (below) — `ip -M route` on cRPD nodes.
2. `juniper-ldp-troubleshooter` — label bindings for the destination prefix.
3. `juniper-ospf-troubleshooter` — verify destination loopback is in OSPF.

### Symptom: Protocols flapping / high RE CPU
1. `juniper-copp-troubleshooter` — RE firewall filter drops.
2. `juniper-bfd-troubleshooter` — check BFD timer aggressiveness.

---

## cRPD-Specific: MPLS Kernel Check

On cRPD, MPLS forwarding is in the **Linux kernel**, not the Junos FIB.
Always verify both layers:

```bash
# Linux kernel MPLS table (should have label entries after LDP converges)
ip -M route show

# Junos mpls.0 table (Junos view of kernel MPLS)
cli -c 'show route table mpls.0'

# Verify LDP transport addresses are reachable
cli -c 'show ldp session'
cli -c 'show ldp neighbor'

# Verify kernel sysctl MPLS is enabled (set in linux_net_config sh scripts)
sysctl net.mpls.conf.lo.input
sysctl net.mpls.conf.eth1.input
```

---

## SP Backbone Addressing Reference (from your lab)

| Node | Mgmt IP | Loopback (router-id) | Role |
|---|---|---|---|
| p1 | 100.68.0.111 | 10.255.0.1 | P node |
| p2 | 100.68.0.112 | 10.255.0.2 | P node |
| p3 | 100.68.0.113 | 10.255.0.13 | P node |
| p4 | 100.68.0.114 | 10.255.0.14 | P node |
| p5 | 100.68.0.115 | 10.255.0.5 | P node (4 OSPF/LDP links) |
| p6 | 100.68.0.116 | 10.255.0.6 | P node (4 OSPF/LDP links) |
| rr1 | 100.68.0.101 | 10.255.2.1 | Route Reflector |
| pe1 | 100.68.0.121 | 10.255.1.1 | PE node |
| pe2 | 100.68.0.122 | 10.255.1.2 | PE node |

**OSPF neighbor minimums:** p1/p2/p3/p4=2, p5/p6=4, rr1=2, pe1/pe2=2
**LDP neighbor minimums:** same as OSPF
**BGP:** pe1→rr1 (1 session), pe2→rr1 (1 session), rr1 reflects to both PEs

---

## SP Backbone Configuration Checklist

### P node checklist:
- [ ] OSPF adjacencies Full on all expected interfaces
- [ ] LDP neighbors Operational on all expected interfaces
- [ ] `ip -M route show` returns label entries (cRPD)
- [ ] `sysctl net.mpls.conf.<intf>.input = 1` on all MPLS interfaces

### RR checklist:
- [ ] OSPF Full to both P5 and P6
- [ ] LDP Operational to both P5 and P6
- [ ] iBGP Established to pe1 and pe2 (`show bgp summary`)
- [ ] `family inet-vpn unicast` negotiated with both PEs

### PE checklist:
- [ ] OSPF Full to both connected P nodes
- [ ] LDP Operational to both connected P nodes
- [ ] iBGP Established to RR with VPNv4 routes exchanged
- [ ] CUSTOMER1 routing-instance exists with correct `vrf-table-label`
- [ ] PE-CE eBGP session Established in CUSTOMER1 instance

## Sub-Skill Reference Index

| Sub-skill | When to invoke |
|---|---|
| `juniper-layer1-troubleshooter` | Physical link, optics, interface errors — always first |
| `juniper-ospf-troubleshooter` | OSPF adjacency missing, routes missing — second |
| `juniper-ldp-troubleshooter` | LDP session down, label bindings missing — third |
| `juniper-bgp-troubleshooter` | iBGP PE-RR session, PE-CE eBGP session |
| `juniper-l3vpn-troubleshooter` | CUSTOMER1 VRF routes, RT/RD, VPN label |
| `juniper-bfd-troubleshooter` | BFD-triggered flap on any session |
| `juniper-copp-troubleshooter` | RE CPU overload, firewall filter drops |
| `juniper-hardware-troubleshooter` | FPC/PIC faults, chassis alarms |

## Resources
### references/
- `sp_backbone_topology_map.md`: Node-to-IP-to-role mapping and link adjacency matrix.
