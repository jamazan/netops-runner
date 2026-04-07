#!/bin/bash
echo "[RESTORE] EVPN BGP Session Down — dc1-leaf2a L2VPN EVPN AF"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
router bgp 65102
address-family evpn
neighbor EVPN-OVERLAY-PEERS activate
end
write memory" && echo "[RESTORE] Done — evpn-05-evpn-bgp-session-down"
