#!/bin/bash
echo "[INJECT] Removing BFD from EVPN-OVERLAY-PEERS on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
router bgp 65102
no neighbor EVPN-OVERLAY-PEERS bfd
end
write memory" && echo "[INJECT] Done — BFD sessions to spines will drop"
