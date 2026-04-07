#!/bin/bash
echo "[INJECT] EVPN Route Withdrawal Flap — VNI 10011 on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
interface Vxlan1
no vxlan vlan 11 vni 10011
end
write memory" && echo "[INJECT] Done — evpn-06-evpn-route-withdrawal-flap"
