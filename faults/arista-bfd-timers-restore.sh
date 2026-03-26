#!/bin/bash
echo "[RESTORE] Re-enabling BFD on EVPN-OVERLAY-PEERS on dc1-leaf2a"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -c "enable
configure
router bgp 65102
neighbor EVPN-OVERLAY-PEERS bfd
end
write memory" && echo "[RESTORE] Done"
