#!/bin/bash
echo "[INJECT] MLAG Peer-Link Degraded — DC1_L3_LEAF1 Port-Channel3"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
interface Ethernet3
shutdown
end
write memory" && echo "[INJECT] Done — evpn-11-peer-link-degradation"
