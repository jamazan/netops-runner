---
name: multivendor-dc-interconnect-troubleshooter
description: >
  Orchestrate troubleshooting for a multi-vendor DC interconnect where an
  Arista DC1 fabric (cEOS, EVPN/VXLAN) connects to a Juniper DC2 fabric
  (cRPD, eBGP EVPN/VXLAN) via PE nodes running MPLS L3VPN. Use when
  investigating cross-DC host reachability, EVPN Type-5 route stitching,
  PE-to-leaf BGP session failures, or asymmetric routing between DC1 and DC2.
  Dispatches to Arista, Juniper, and multi-vendor sub-skills.
---

# Multi-Vendor DC Interconnect Troubleshooter (Orchestrator)

## Overview

DC1 (Arista, cEOS) and DC2 (Juniper, cRPD) are two independent EVPN/VXLAN
fabrics that are interconnected via PE nodes running MPLS L3VPN. Border
leaves in each DC connect via eBGP to their respective PE. EVPN Type-5
routes carry inter-DC IP prefixes.

```
  DC1 (Arista cEOS)              MPLS WAN              DC2 (Juniper cRPD)
  ─────────────────              ────────              ─────────────────
  dc1-spine1/2                                        dc2-spine1/2
       │ EVPN overlay                                      │ EVPN overlay
  dc1-leaf1a/b ──── eth11 ──► pe1 ◄────────────► pe2 ◄── eth11 ──── dc2-leaf1a/b
  (Arista VTEP)    eBGP    (Juniper)            (Juniper)  eBGP    (Juniper VTEP)

  Cross-DC path:
  DC1 host → dc1-leaf1a (VXLAN) → pe1 (L3VPN) → pe2 (L3VPN) → dc2-leaf1a (VXLAN) → DC2 host
```

## Topology Reference: Roles and Sub-Skills

| Node | Vendor | Role | Sub-skills to invoke |
|---|---|---|---|
| dc1-leaf1a/1b | Arista | Border leaf / VTEP | `arista-bgp-troubleshooter`, `arista-evpn-troubleshooter`, `arista-vxlan-troubleshooter` |
| dc1-spine1/2 | Arista | EVPN RR, eBGP underlay | `arista-bgp-troubleshooter` |
| pe1, pe2 | Juniper | PE, L3VPN, iBGP to RR | `juniper-bgp-troubleshooter`, `juniper-l3vpn-troubleshooter` |
| dc2-leaf1a/1b | Juniper | Border leaf / VTEP | `juniper-bgp-troubleshooter`, `juniper-evpn-troubleshooter`, `juniper-vxlan-troubleshooter` |
| dc2-spine1/2 | Juniper | EVPN RR, eBGP underlay | `juniper-bgp-troubleshooter` |

---

## Cross-DC Failure Pattern Library

### Pattern 1: DC1 host cannot reach DC2 host

Traffic path has 5 distinct segments — each can fail independently:
```
[DC1 fabric] → [DC1 border leaf → PE1 eBGP] → [MPLS WAN: PE1→PE2] → [PE2 → DC2 border leaf eBGP] → [DC2 fabric]
```

**Isolate the segment:**
1. Can DC1 host reach its default gateway (local EVPN/VXLAN)? → `arista-vxlan-troubleshooter`
2. Does DC1 border leaf have EVPN Type-5 route for DC2 prefix? → `arista-evpn-troubleshooter`
3. Is DC1 border leaf eBGP to pe1 Established? → `arista-bgp-troubleshooter`
4. Does pe1 have VPN route for DC2 prefix? → `juniper-l3vpn-troubleshooter`
5. Is pe1-to-pe2 MPLS transport working? → `juniper-sp-backbone-troubleshooter`
6. Does pe2 have VPN route for DC1 prefix? → `juniper-l3vpn-troubleshooter`
7. Is pe2 eBGP to dc2-leaf1a Established? → `juniper-bgp-troubleshooter`
8. Does DC2 border leaf have EVPN Type-5 route for DC1 prefix? → `juniper-evpn-troubleshooter`
9. Can DC2 host be reached via local VXLAN? → `juniper-vxlan-troubleshooter`

### Pattern 2: EVPN Type-5 routes not crossing DC boundary

EVPN Type-5 (IP prefix) routes must be redistributed into the L3VPN on
the border leaf / PE connection. This is the most common cross-DC failure.

**Arista side (dc1-leaf1a → pe1):**
```
# Check Type-5 routes being advertised by Arista border leaf:
show bgp evpn route-type ip-prefix

# Check PE1 received those routes as VPNv4:
# (run on pe1 via SSH)
cli -c 'show route table bgp.l3vpn.0'
cli -c 'show bgp neighbor <dc1-leaf-IP> received-routes'
```

**Juniper side (pe2 → dc2-leaf1a):**
```
# Check VPN route on pe2:
cli -c 'show route table bgp.l3vpn.0 <DC1-prefix>'

# Check DC2 leaf received it as EVPN Type-5:
cli -c 'show route table bgp.evpn.0' | grep type-5
```

### Pattern 3: RT/RD mismatch between Arista and Juniper

DC1 (Arista) and DC2 (Juniper) must use matching RT values for routes
to be imported across the DC boundary via the PE nodes.

**Key check:**
- Arista border leaf VRF RT export value must match Juniper PE VRF import RT.
- Juniper PE VRF RT export value must match Arista border leaf VRF import RT.

```
# Arista: show vrf <n> → route-target import/export
# Juniper PE: show routing-instances CUSTOMER1 → vrf-import/vrf-export policy
```

---

## Decision Tree: Sub-Skill Dispatch

### DC1 intra-fabric issues (before the border leaf)
→ Invoke `arista-l3ls-troubleshooter` for full DC1 fabric triage.

### DC2 intra-fabric issues (before the border leaf)
→ Invoke `juniper-dc-fabric-troubleshooter` for full DC2 fabric triage.

### WAN/PE issues (between pe1 and pe2)
→ Invoke `juniper-sp-backbone-troubleshooter` for backbone + L3VPN.

### Cross-DC border leaf to PE session
1. `arista-layer1-troubleshooter` or `juniper-layer1-troubleshooter` — physical link.
2. `arista-bgp-troubleshooter` (DC1 side) and `juniper-bgp-troubleshooter` (PE side).
3. Check Pattern 2 (EVPN Type-5 redistribution) and Pattern 3 (RT/RD).

---

## Cross-DC Addressing Reference (from your lab)

| Node | Vendor | Mgmt IP | Loopback | Role |
|---|---|---|---|---|
| dc1-leaf1a | Arista | 100.68.0.13 | 10.255.0.3 | DC1 border leaf |
| dc1-leaf1b | Arista | 100.68.0.14 | 10.255.0.4 | DC1 border leaf |
| pe1 | Juniper | 100.68.0.121 | 10.255.1.1 | PE / L3VPN |
| pe2 | Juniper | 100.68.0.122 | 10.255.1.2 | PE / L3VPN |
| dc2-leaf1a | Juniper | 100.68.0.23 | 10.2.1.1 | DC2 border leaf |
| dc2-leaf1b | Juniper | 100.68.0.24 | 10.2.1.2 | DC2 border leaf |

**Link addressing:**
- dc1-leaf1a eth11 → pe1 eth3: `10.0.2.2/31` / `10.0.2.3/31`
- dc1-leaf1b eth11 → pe1 eth4: `10.0.2.4/31` / `10.0.2.5/31`
- dc2-leaf1a eth11 → pe2 eth3: `10.0.2.2/31` / `10.0.2.3/31`
- dc2-leaf1b eth11 → pe2 eth4: `10.0.2.4/31` / `10.0.2.5/31`

## Sub-Skill Reference Index

| Sub-skill | Vendor | When to invoke |
|---|---|---|
| `arista-l3ls-troubleshooter` | Arista | Full DC1 fabric triage |
| `arista-bgp-troubleshooter` | Arista | DC1 border leaf eBGP to PE |
| `arista-evpn-troubleshooter` | Arista | DC1 EVPN Type-5 route advertisement |
| `arista-vxlan-troubleshooter` | Arista | DC1 VTEP, VNI, MAC learning |
| `arista-l3vpn-troubleshooter` | Arista | DC1 VRF RT/RD if Arista PE |
| `juniper-dc-fabric-troubleshooter` | Juniper | Full DC2 fabric triage |
| `juniper-bgp-troubleshooter` | Juniper | DC2 border leaf eBGP, PE-CE |
| `juniper-evpn-troubleshooter` | Juniper | DC2 EVPN Type-5 routes |
| `juniper-vxlan-troubleshooter` | Juniper | DC2 VTEP, TENANT-A VRF |
| `juniper-l3vpn-troubleshooter` | Juniper | PE VPN routes, RT/RD |
| `juniper-sp-backbone-troubleshooter` | Juniper | MPLS WAN pe1↔pe2 transport |
| `multivendor-wan-troubleshooter` | Both | Cross-vendor policy and MPLS |

## Resources
### references/
- `dc_interconnect_topology_map.md`: Full end-to-end topology with IPs, ASNs, VRF names, RT/RD values.
- `cross_dc_rt_matrix.md`: RT import/export matrix showing which values must match across Arista and Juniper.
