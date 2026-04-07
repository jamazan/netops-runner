#!/bin/bash
echo "[RESTORE] Fixing EVPN RT export on dc1-leaf1b VLAN 11"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -c "enable
configure
router bgp 65101
vlan 11
no route-target export 10011:99999
route-target export 10011:10011
end
write memory" && echo "[RESTORE] Done"
