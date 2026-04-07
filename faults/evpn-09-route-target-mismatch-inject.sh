#!/bin/bash
echo "[INJECT] Route-Target Mismatch — VNI 10012 on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
router bgp 65102
vlan 12
no route-target both 10012:10012
route-target both 10012:88888
end
write memory" && echo "[INJECT] Done — evpn-09-route-target-mismatch"
