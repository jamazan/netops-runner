#!/bin/bash
echo "[INJECT] VNI Not Active — VNI 10022 removed from dc1-leaf1b"
docker exec clab-multi-site-fabric-dc1-leaf1b Cli -p 15 -c "enable
configure
interface Vxlan1
no vxlan vlan 22 vni 10022
end
write memory" && echo "[INJECT] Done — evpn-10-vni-not-active-on-leaf"
