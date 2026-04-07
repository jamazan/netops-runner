#!/bin/bash
echo "[RESTORE] Interface Flap and Route Loss — dc1-leaf2a Ethernet1"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
interface Ethernet1
no shutdown
end
write memory" && echo "[RESTORE] Done — evpn-03-interface-flap-route-loss"
