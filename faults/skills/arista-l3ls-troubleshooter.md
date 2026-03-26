---
name: arista-l3ls-troubleshooter
description: >
  Orchestrate troubleshooting for an Arista Layer 3 Leaf-Spine (L3LS) fabric.
  Use when a symptom is reported anywhere in the fabric — reachability failure,
  BGP session down, VXLAN/EVPN blackhole, MLAG split-brain, uplink failure —
  and you need to systematically isolate which layer and which node type is
  the root cause. This skill dispatches to the appropriate sub-skills based on
  the topology role of the affected device and the nature of the symptom.
---

# Arista L3LS Fabric Troubleshooter (Orchestrator)

## Overview

An Arista L3LS fabric has a well-defined layered structure. Each layer has a
distinct role and a distinct set of failure modes. This skill acts as the
**first-stop triage layer**: it identifies which layer and protocol is involved,
then dispatches to the correct sub-skill for deep-dive investigation.

```
  ┌─────────────────────────────────────────────────────┐
  │                    SPINES                           │
  │   (eBGP underlay RR, EVPN overlay RR, no VTEP)    │
  └──────────────┬──────────────────────┬──────────────┘
                 │ eBGP underlay        │ eBGP EVPN overlay
  ┌──────────────▼──────────────────────▼──────────────┐
  │                    LEAVES                           │
  │  (VTEP, MLAG pairs, eBGP to spines, EVPN Type-2/3/5)│
  └──────────────┬──────────────────────┬──────────────┘
                 │ L2 / L3              │
        Host / CE attached          DCI / Border Leaf
```

## Topology Reference: Roles and Sub-Skills

| Node Role    | Protocols in play              | Sub-skills to invoke                          |
|--------------|-------------------------------|-----------------------------------------------|
| Spine        | eBGP underlay, EVPN overlay RR | `arista-bgp-troubleshooter`                  |
| Leaf         | eBGP underlay, EVPN, VXLAN, MLAG | `arista-bgp-troubleshooter`, `arista-evpn-troubleshooter`, `arista-vxlan-troubleshooter` |
| Border Leaf  | eBGP underlay, EVPN Type-5, L3VPN | `arista-bgp-troubleshooter`, `arista-evpn-troubleshooter`, `arista-l3vpn-troubleshooter` |
| Any node     | Physical/optics                | `arista-layer1-troubleshooter`               |
| Any node     | BFD-tracked sessions down      | `arista-bfd-troubleshooter`                  |
| Any node     | CPU high / protocol flap       | `arista-copp-troubleshooter`                 |
| Any node     | ASIC drops / ECC / env alarms  | `arista-hardware-troubleshooter`             |

## Triage Workflow

### Step 1 — Identify the symptom category

Ask or determine:
- **Is a host/VM unreachable?** → Start at Layer 1, then work up.
- **Is a BGP session down?** → Go to BGP sub-skill for the affected peer pair.
- **Is EVPN/VXLAN broken** (MACs not learned, VTEP missing)? → EVPN + VXLAN sub-skills.
- **Is MLAG down or degraded?** → MLAG section below before invoking sub-skills.
- **Is this a hardware/optics issue?** → Layer 1 and Hardware sub-skills first.
- **Are protocols flapping repeatedly?** → CoPP sub-skill (CPU rate-limiting).

### Step 2 — Identify the node role

Run `show hostname` and `show version` on the affected device, then consult
`references/l3ls_topology_map.md` (your fabric-specific IP/role mapping) to
confirm whether the node is a spine, leaf, border leaf, or host-facing leaf.

### Step 3 — Dispatch to the correct sub-skill chain

Use the decision tree below. Sub-skills are listed in the recommended
**invocation order** — invoke each one in sequence, stopping when the root
cause is found.

---

## Decision Tree: Sub-Skill Dispatch

### Symptom: End-host unreachable
1. `arista-layer1-troubleshooter` — verify the host-facing port is up and error-free.
2. `arista-vxlan-troubleshooter` — verify the VTEP is learning MACs and VXLAN tunnels exist.
3. `arista-evpn-troubleshooter` — verify BGP EVPN Type-2/3 routes are present and imported.
4. `arista-bgp-troubleshooter` — verify eBGP underlay and EVPN overlay sessions are up.

### Symptom: BGP session down (leaf-to-spine or spine-to-spine)
1. `arista-layer1-troubleshooter` — rule out physical/optics problem on the uplink.
2. `arista-bfd-troubleshooter` — if BFD is enabled, verify BFD session state first.
3. `arista-bgp-troubleshooter` — diagnose session state, hold-timer, MD5, policy.

### Symptom: EVPN routes missing or not imported
1. `arista-bgp-troubleshooter` — verify EVPN overlay session is Established.
2. `arista-evpn-troubleshooter` — verify route-type advertisement and RT import/export.
3. `arista-vxlan-troubleshooter` — verify VNI mapping and VTEP table.

### Symptom: VXLAN tunnel not forming / remote VTEP missing
1. `arista-bgp-troubleshooter` — verify underlay eBGP sessions (spine-to-leaf).
2. `arista-evpn-troubleshooter` — verify EVPN Type-3 (IMET) routes are present.
3. `arista-vxlan-troubleshooter` — verify source Loopback1 is advertised and reachable.

### Symptom: Inter-VRF / L3VPN reachability broken (border leaf)
1. `arista-bgp-troubleshooter` — verify eBGP sessions and route advertisement.
2. `arista-evpn-troubleshooter` — verify EVPN Type-5 IP prefix routes.
3. `arista-l3vpn-troubleshooter` — verify VRF RD/RT, PE-CE sessions, LFIB.

### Symptom: MLAG degraded or split-brain
→ See MLAG section below. Do not invoke BGP or EVPN sub-skills until MLAG is stable.

### Symptom: Protocols flapping repeatedly on a healthy-looking fabric
1. `arista-copp-troubleshooter` — check CPU queue drops and rate-limit policy.
2. `arista-hardware-troubleshooter` — check ASIC drop counters and ECC errors.
3. `arista-bfd-troubleshooter` — if BFD is involved, verify timer aggressiveness.

### Symptom: Interface errors, CRC, optics alarm, link down
1. `arista-layer1-troubleshooter` — this is always the first sub-skill to invoke.

---

## MLAG-Specific Triage (Leaf Pairs)

MLAG issues must be resolved before diagnosing EVPN/VXLAN, because a
split-brain MLAG causes duplicate VTEP traffic and inconsistent MAC tables
that will look like EVPN bugs.

### MLAG health commands (run on both peers):
```
show mlag                          # Domain state: active/inactive
show mlag detail                   # Peer-link status, config sync, dual-primary
show mlag interfaces               # Per-port-channel MLAG state
show interfaces port-channel <n>   # Peer-link Port-Channel status
show bgp evpn summary              # EVPN overlay must be Established before MLAG is stable
```

### MLAG failure modes in L3LS:

| Symptom | Likely cause | Action |
|---|---|---|
| MLAG state: inactive | Peer-link down | Check `arista-layer1-troubleshooter` on peer-link interfaces |
| MLAG state: inactive | MLAG keepalive (BGP or dedicated) lost | Check BGP keepalive session or dedicated keepalive link |
| dual-primary | Both peers think they're primary | Reload the secondary peer |
| MLAG interfaces: errDisabled | Peer-link came back after split-brain | Manually re-enable after verifying config sync |
| Anycast VTEP missing | Shared Loopback IP not advertised | Verify `vxlan virtual-router encapsulation mac-address mlag-system-id` and shared Loopback config |

---

## L3LS-Specific Configuration Checklist

Use this to verify the baseline before diving into sub-skills.

### Spine checklist:
- [ ] eBGP sessions to all leaves are Established (`show bgp summary`)
- [ ] EVPN overlay sessions to all leaves are Established (`show bgp evpn summary`)
- [ ] No VTEP configured on spines (spines are pure route-reflectors)
- [ ] `service routing protocols model multi-agent` is set
- [ ] Spine loopback (Loopback0) is advertised in eBGP

### Leaf checklist:
- [ ] eBGP underlay sessions to both spines are Established
- [ ] EVPN overlay sessions to both spines are Established
- [ ] `interface Vxlan1` is Up with correct source-interface (Loopback1)
- [ ] MLAG domain is active and peer-link is Up (if MLAG pair)
- [ ] Anycast VTEP Loopback1 is shared between MLAG peers with same IP
- [ ] VNI-to-VLAN mappings are consistent with all peers
- [ ] L3VNI per VRF is configured and matches all VTEPs in the fabric

---

## Sub-Skill Reference Index

| Sub-skill | Folder | When to invoke |
|---|---|---|
| `arista-bgp-troubleshooter` | `arista-bgp-troubleshooter/` | Any BGP session issue (underlay or EVPN overlay) |
| `arista-evpn-troubleshooter` | `arista-evpn-troubleshooter/` | EVPN route advertisement, Type-2/3/5 issues, RT/RD mismatch |
| `arista-vxlan-troubleshooter` | `arista-vxlan-troubleshooter/` | VTEP missing, VNI mapping, MAC learning, BUM flooding |
| `arista-l3vpn-troubleshooter` | `arista-l3vpn-troubleshooter/` | Inter-VRF routing, EVPN Type-5 at border leaf |
| `arista-layer1-troubleshooter` | `arista-layer1-troubleshooter/` | Physical link, optics, CRC, err-disabled |
| `arista-bfd-troubleshooter` | `arista-bfd-troubleshooter/` | BFD-triggered protocol flap |
| `arista-copp-troubleshooter` | `arista-copp-troubleshooter/` | CPU queue drops, protocol flapping under load |
| `arista-hardware-troubleshooter` | `arista-hardware-troubleshooter/` | ASIC drops, ECC errors, TCAM exhaustion, env alarms |

## Resources
### references/
- `l3ls_topology_map.md`: Your fabric-specific node-to-IP-to-role mapping (fill this in per deployment).
- `l3ls_design_guide.md`: L3LS design principles, address plan conventions, and AVD variable reference.
