#!/bin/bash
echo "[INJECT] Interface Flap and Route Loss — dc1-leaf2a Ethernet1"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
interface Ethernet1
shutdown
end
write memory" && echo "[INJECT] Done — evpn-03-interface-flap-route-loss"
