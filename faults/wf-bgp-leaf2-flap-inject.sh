#!/bin/bash
echo "[INJECT] Breaking EVPN BGP auth on dc1-leaf2a and dc1-leaf2b"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS password WRONG_PASSWORD
end
write memory" && docker exec clab-multi-site-fabric-dc1-leaf2b Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS password WRONG_PASSWORD
end
write memory" && echo "[INJECT] Done — EVPN sessions on leaf2a/2b will drop to Connect"
