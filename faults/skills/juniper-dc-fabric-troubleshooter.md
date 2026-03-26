---
name: juniper-dc-fabric-troubleshooter
description: >
  Orchestrate troubleshooting for a Juniper DC spine-leaf fabric (cRPD or
  QFX). Use when investigating eBGP underlay failures, EVPN overlay session
  issues, VXLAN tunnel formation failures, L3VPN/VPRN reachability, or
  physical layer problems in a Juniper-native DC fabric. Dispatches to
  Juniper sub-skills based on node role and symptom.
---

# Juniper DC Fabric Troubleshooter (Orchestrator)

## Overview

A Juniper DC fabric follows the same spine-leaf principles as Arista L3LS
but uses JunOS (cRPD for containerized, QFX for hardware). BGP is used for
both underlay and EVPN overlay. EVPN/VXLAN is native JunOS.

```
  ┌───────────────────────────────────────────────────────┐
  │                    SPINES  (JunOS)                    │
  │  eBGP underlay, EVPN overlay RR, no VTEP             │
  │  AS 65200 (shared), router-ids 10.2.0.1/2            │
  └──────────┬────────────────────────────┬──────────────┘
             │ eBGP (underlay + overlay)  │
  ┌──────────▼────────────────────────────▼──────────────┐
  │                    LEAVES  (JunOS)                    │
  │  VTEP, EVPN routing-instance, eBGP to both spines    │
  │  AS 65201/65202, loopbacks 10.2.1.x                  │
  └──────────┬────────────────────────────┬──────────────┘
             │                            │
      Host-facing ports             PE uplinks (eth11)
```

## Topology Reference: Roles and Sub-Skills

| Node Role | Protocols in play | Sub-skills to invoke |
|---|---|---|
| Spine | eBGP underlay RR, EVPN overlay RR | `juniper-bgp-troubleshooter` |
| Leaf | eBGP underlay+overlay, EVPN, VXLAN | `juniper-bgp-troubleshooter`, `juniper-evpn-troubleshooter`, `juniper-vxlan-troubleshooter` |
| Leaf (PE-connected) | + eBGP to PE, L3VPN TENANT-A | `juniper-l3vpn-troubleshooter` |
| Any node | Physical / optics | `juniper-layer1-troubleshooter` |
| Any node | BFD-tracked sessions | `juniper-bfd-troubleshooter` |
| Any node | CPU / RE protection | `juniper-copp-troubleshooter` |
| Any node | Hardware faults | `juniper-hardware-troubleshooter` |

---

## Triage Workflow

### Step 1 — Identify symptom category
- **BGP session down (spine-leaf)?** → Layer 1 → BGP sub-skill.
- **EVPN routes missing?** → BGP session check → EVPN sub-skill.
- **VXLAN tunnel missing / host unreachable?** → BGP → EVPN → VXLAN sub-skills.
- **L3VPN / TENANT-A routes missing?** → BGP to PE → L3VPN sub-skill.
- **Physical link down?** → Layer 1 sub-skill first, always.

---

## Decision Tree: Sub-Skill Dispatch

### Symptom: Host unreachable across fabric
1. `juniper-layer1-troubleshooter` — host-facing port on the leaf.
2. `juniper-vxlan-troubleshooter` — VTEP table and VNI mapping on both source and destination leaf.
3. `juniper-evpn-troubleshooter` — Type-2/3 routes in `bgp.evpn.0`.
4. `juniper-bgp-troubleshooter` — eBGP underlay and EVPN overlay sessions.

### Symptom: BGP session down (leaf ↔ spine)
1. `juniper-layer1-troubleshooter` — physical link and IP connectivity.
2. `juniper-bfd-troubleshooter` — if BFD is enabled on the session.
3. `juniper-bgp-troubleshooter` — session state, policy, timer mismatch.

### Symptom: EVPN routes missing or not imported
1. `juniper-bgp-troubleshooter` — EVPN overlay session to both spines.
2. `juniper-evpn-troubleshooter` — RT/RD mismatch, vrf-target, instance binding.
3. `juniper-vxlan-troubleshooter` — VNI consistency across VTEPs.

### Symptom: L3VPN / TENANT-A reachability broken (PE-connected leaf)
1. `juniper-bgp-troubleshooter` — eBGP session from leaf eth11 to PE.
2. `juniper-l3vpn-troubleshooter` — TENANT-A routing-instance, VRF routes, RT.
3. `juniper-evpn-troubleshooter` — EVPN Type-5 IP prefix routes if used.

### Symptom: Protocols flapping / RE high CPU
1. `juniper-copp-troubleshooter` — RE firewall filter drops and PFE exception rate.
2. `juniper-bfd-troubleshooter` — aggressive BFD timers causing RE load.

---

## DC2 Fabric Addressing Reference (from your lab)

| Node | Mgmt IP | Loopback (router-id) | BGP AS | Role |
|---|---|---|---|---|
| dc2-spine1 | 100.68.0.21 | 10.2.0.1 | 65200 | Spine / EVPN RR |
| dc2-spine2 | 100.68.0.22 | 10.2.0.2 | 65200 | Spine / EVPN RR |
| dc2-leaf1a | 100.68.0.23 | 10.2.1.1 | 65201 | Leaf / VTEP / PE-connected |
| dc2-leaf1b | 100.68.0.24 | 10.2.1.2 | 65201 | Leaf / VTEP / PE-connected |
| dc2-leaf2a | 100.68.0.25 | 10.2.1.3 | 65202 | Leaf / VTEP |
| dc2-leaf2b | 100.68.0.26 | 10.2.1.4 | 65202 | Leaf / VTEP |

**BGP session counts to verify:**
- Spine: 8 total (4 underlay + 4 EVPN overlay leaf peers)
- Leaf: 5 total (2 underlay spines + 2 EVPN overlay spines + 1 PE eBGP on eth11)

**EVPN / VXLAN:**
- VRF: TENANT-A | VNI: 20010 | RD: `<leaf-loopback>:10`
- VXLAN: kernel-routed via cRPD (no Linux bridge FDB) — use `show route table TENANT-A.inet.0`

---

## JunOS DC Fabric Configuration Checklist

### Spine checklist:
- [ ] eBGP sessions to all 4 leaves Established (`show bgp summary`)
- [ ] EVPN overlay sessions to all 4 leaves Established
- [ ] `family evpn signaling` configured under LEAF-OVERLAY peer group
- [ ] `advertise-peer-as` and `as-override` configured under LEAF-UNDERLAY

### Leaf checklist:
- [ ] eBGP underlay to both spines Established
- [ ] EVPN overlay to both spines Established
- [ ] routing-instance TENANT-A present with correct RD, vrf-import, vrf-export
- [ ] EVPN ip-prefix-routes with `encapsulation vxlan` and correct VNI
- [ ] PE eBGP session on eth11 Established (if PE-connected)
- [ ] Loopback IP set in linux_net_config sh script and `ip addr` confirms it

## Sub-Skill Reference Index

| Sub-skill | When to invoke |
|---|---|
| `juniper-bgp-troubleshooter` | eBGP underlay or EVPN overlay session issues |
| `juniper-evpn-troubleshooter` | EVPN route advertisement, RT/RD mismatch, Type-2/3/5 missing |
| `juniper-vxlan-troubleshooter` | VTEP table, VNI mapping, BUM flooding |
| `juniper-l3vpn-troubleshooter` | TENANT-A VRF routes, PE-CE session, RT import/export |
| `juniper-layer1-troubleshooter` | Physical link, optics, interface errors |
| `juniper-bfd-troubleshooter` | BFD-triggered protocol flap |
| `juniper-copp-troubleshooter` | RE protection filter drops, high CPU |
| `juniper-hardware-troubleshooter` | FPC/PIC faults, ASIC drops, env alarms |

## Resources
### references/
- `dc_fabric_topology_map.md`: Node-to-IP-to-role mapping for this fabric.
