#!/bin/bash
echo "[INJECT] Breaking EVPN RT export on dc1-leaf1b VLAN 11"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -c "enable
configure
router bgp 65101
vlan 11
route-target export 10011:99999
end
write memory" && echo "[INJECT] Done — VLAN 11 Type-2 routes will not be imported by peers"
