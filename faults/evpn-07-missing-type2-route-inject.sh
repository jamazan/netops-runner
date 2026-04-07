#!/bin/bash
echo "[INJECT] Missing Type-2 Route — RT Mismatch VNI 10011 on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
router bgp 65101
vlan 11
no route-target both 10011:10011
route-target both 10011:99999
end
write memory" && echo "[INJECT] Done — evpn-07-missing-type2-route"
