#!/bin/bash
echo "[RESTORE] Missing Type-5 Route — VRF11 redistribute removed on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
router bgp 65101
vrf VRF11
redistribute connected route-map RM-CONN-2-BGP-VRFS
end
write memory" && echo "[RESTORE] Done — evpn-08-missing-type5-route"
