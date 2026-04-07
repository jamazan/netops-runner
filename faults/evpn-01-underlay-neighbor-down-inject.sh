#!/bin/bash
echo "[INJECT] Underlay BGP Neighbor Down — dc1-spine1 ↔ dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -p 15 -c "enable
configure
interface Ethernet1
shutdown
end
write memory" && echo "[INJECT] Done — evpn-01-underlay-neighbor-down"
