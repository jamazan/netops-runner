#!/bin/bash
echo "[INJECT] Setting wrong EVPN auth on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS password WRONG_PASSWORD
end
write memory" && echo "[INJECT] Done — dc1-leaf2a EVPN sessions will drop to Active"
