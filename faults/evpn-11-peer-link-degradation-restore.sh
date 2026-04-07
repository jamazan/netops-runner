#!/bin/bash
echo "[RESTORE] MLAG Peer-Link Degraded — DC1_L3_LEAF1 Port-Channel3"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
interface Ethernet3
no shutdown
end
write memory" && echo "[RESTORE] Done — evpn-11-peer-link-degradation"
