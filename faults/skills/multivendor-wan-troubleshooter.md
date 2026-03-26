---
name: multivendor-wan-troubleshooter
description: >
  Orchestrate troubleshooting for a multi-vendor WAN/MPLS backbone where
  Arista EOS devices act as PE/CE nodes and Juniper JunOS devices act as
  P/PE/RR nodes. Use when investigating cross-vendor BGP session failures,
  L3VPN customer reachability issues, MPLS label forwarding gaps, or
  mismatched policies between vendors. Dispatches to both Arista and
  Juniper sub-skills based on the node role and vendor.
---

# Multi-Vendor WAN Troubleshooter (Orchestrator)

## Overview

In a multi-vendor WAN, the critical insight is that **protocol behavior
differs between vendors** even when running the same standard. The most
common failure modes are policy asymmetry (one vendor advertising,
the other not importing) and MPLS forwarding differences (cRPD kernel
MPLS vs EOS hardware MPLS pipeline).

```
  ┌──────────────────────────────────────────────────────────┐
  │          ARISTA CE/PE layer  (EOS)                       │
  │  DC1 leaves ──► pe1(arista) ──► [WAN backbone]          │
  └────────────────────────┬─────────────────────────────────┘
                           │ eBGP or iBGP
  ┌────────────────────────▼─────────────────────────────────┐
  │          JUNIPER P/PE/RR backbone  (JunOS / cRPD)        │
  │  p1─p2─p3─p4─p5─p6 (OSPF+LDP+MPLS)                    │
  │  rr1 (iBGP RR), pe1/pe2 (L3VPN)                        │
  └──────────────────────────────────────────────────────────┘
```

## Topology Reference: Roles and Sub-Skills

| Node | Vendor | Role | Sub-skills to invoke |
|---|---|---|---|
| DC1 leaves/border leaf | Arista EOS | CE or PE | `arista-bgp-troubleshooter`, `arista-l3vpn-troubleshooter` |
| pe1, pe2 | Juniper JunOS | PE | `juniper-bgp-troubleshooter`, `juniper-l3vpn-troubleshooter`, `juniper-ldp-troubleshooter` |
| p1–p6 | Juniper JunOS | P transit | `juniper-ospf-troubleshooter`, `juniper-ldp-troubleshooter` |
| rr1 | Juniper JunOS | iBGP RR | `juniper-bgp-troubleshooter` |
| CE (cRPD) | Juniper JunOS | CE | `juniper-bgp-troubleshooter` |
| CE (cEOS) | Arista EOS | CE | `arista-bgp-troubleshooter` |

---

## Cross-Vendor Failure Pattern Library

These are the most common failure modes that are NOT caught by single-vendor
sub-skills because they involve interaction between the two vendors:

### Pattern 1: BGP session between Arista CE and Juniper PE
**Symptom**: Session stays in Active/Idle.
**Check both sides**:
```
# Arista CE side:
show bgp neighbors <juniper-PE-IP>        # BGP state, last error
show bgp summary                          # EOS shows all sessions

# Juniper PE side:
show bgp neighbor <arista-CE-IP>          # JunOS session detail
show bgp summary instance <VRF>          # Per-VRF PE-CE session
```
**Common mismatch**: Arista uses 4-byte AS by default; JunOS requires
explicit `4byte-as` in some versions. Also check MD5 auth key mismatch.

### Pattern 2: Routes advertised by Arista not accepted by JunOS PE
**Symptom**: Arista CE shows routes sent; JunOS PE shows nothing received.
**Check**:
- Arista: `show bgp neighbors <IP> advertised-routes` — routes being sent.
- JunOS: `show bgp neighbor <IP> received-routes` — routes received.
- JunOS: Verify `export` policy exists on the PE-CE group — JunOS requires
  explicit export for VPNv4; Arista advertises by default.

### Pattern 3: MPLS label forwarding gap at Arista-Juniper boundary
**Symptom**: Traceroute shows MPLS labels on Juniper hops, then IP on Arista.
**Check**:
- On Juniper PE: `show route table mpls.0` — verify label for Arista destination.
- On Arista border: `show mpls forwarding-table` — verify label entry exists.
- Verify LDP session is Established between the two vendors if LDP is used.
- If SR-MPLS: verify SRGB ranges do not overlap between vendors.

### Pattern 4: RT/RD mismatch across vendors for L3VPN
**Symptom**: VPN routes present on one PE but not imported on the other.
**Check**:
- Arista PE: `show bgp vpn-ipv4 <prefix>` — RT attached to prefix.
- JunOS PE: `show route table bgp.l3vpn.0 <prefix>` — RT on received route.
- Arista import: `show vrf <n>` — `route-target import` value.
- JunOS import: `show routing-instances <n>` — `vrf-import` policy RT value.
- **They must match exactly** — even a minor difference (e.g., `65000:100` vs `65000:0100`) causes silent drop.

---

## Decision Tree: Sub-Skill Dispatch

### Symptom: CE cannot reach remote CE across WAN
1. Identify both CE vendors → select correct `arista-bgp-troubleshooter` or `juniper-bgp-troubleshooter`.
2. Verify CE-to-PE session on both sides (see Pattern 1 above).
3. `juniper-bgp-troubleshooter` — PE-to-RR VPNv4 advertisement.
4. `juniper-l3vpn-troubleshooter` — RT import/export on Juniper PE.
5. If Arista PE involved: `arista-l3vpn-troubleshooter` — RT import/export on Arista PE.
6. Verify MPLS transport end-to-end (see Pattern 3 above).

### Symptom: Juniper PE BGP to RR down
→ Invoke `juniper-sp-backbone-troubleshooter` for the Juniper backbone.
Bottom-up: OSPF → LDP → BGP.

### Symptom: Arista border leaf BGP to Juniper PE down
1. `arista-layer1-troubleshooter` — physical link between Arista and Juniper.
2. `arista-bgp-troubleshooter` — Arista-side BGP session detail.
3. `juniper-bgp-troubleshooter` — Juniper-side BGP session detail.

---

## Sub-Skill Reference Index

| Sub-skill | Vendor | When to invoke |
|---|---|---|
| `arista-bgp-troubleshooter` | Arista | CE-PE or border leaf BGP sessions |
| `arista-l3vpn-troubleshooter` | Arista | Arista PE/CE VRF routes, RT/RD |
| `arista-layer1-troubleshooter` | Arista | Physical links on Arista nodes |
| `juniper-bgp-troubleshooter` | Juniper | PE-CE, PE-RR, cross-vendor sessions |
| `juniper-l3vpn-troubleshooter` | Juniper | L3VPN VRF, RT/RD, VPN labels |
| `juniper-ldp-troubleshooter` | Juniper | LDP session, label bindings |
| `juniper-ospf-troubleshooter` | Juniper | Backbone OSPF adjacency |
| `juniper-layer1-troubleshooter` | Juniper | Physical links on Juniper nodes |
| `juniper-sp-backbone-troubleshooter` | Juniper | Full backbone orchestration |

## Resources
### references/
- `wan_topology_map.md`: End-to-end node map with vendor, role, IP, AS, VRF, and RT/RD values.
- `cross_vendor_policy_matrix.md`: RT/RD mapping table across all PE nodes.
