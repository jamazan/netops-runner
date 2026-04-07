#!/bin/bash
echo "[INJECT] Tenant VRF Reachability — VRF11 L3VNI Removed on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
interface Vxlan1
no vxlan vrf VRF11 vni 11
end
write memory" && echo "[INJECT] Done — evpn-16-tenant-reachability-failure"
