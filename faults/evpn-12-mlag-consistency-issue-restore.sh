#!/bin/bash
echo "[RESTORE] MLAG Consistency Mismatch — DC1_L3_LEAF2 Port-Channel5"
docker exec clab-multi-site-fabric-dc1-leaf2b Cli -p 15 -c "enable
configure
interface Port-Channel5
switchport trunk allowed vlan add 21
end
write memory" && echo "[RESTORE] Done — evpn-12-mlag-consistency-issue"
