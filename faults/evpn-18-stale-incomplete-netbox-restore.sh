#!/bin/bash
echo "[RESTORE] Stale NetBox — RT Mismatch on Recently Provisioned dc1-leaf1b"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -p 15 -c "enable
configure
router bgp 65101
vlan 12
no route-target both 10012:55555
route-target both 10012:10012
end
write memory" && echo "[RESTORE] Done — evpn-18-stale-incomplete-netbox"
