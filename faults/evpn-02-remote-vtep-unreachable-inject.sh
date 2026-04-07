#!/bin/bash
echo "[INJECT] Remote VTEP Unreachable — dc1-leaf2a/2b VTEP 10.255.1.5"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
interface Ethernet1
shutdown
interface Ethernet2
shutdown
end
write memory" && echo "[INJECT] Done — evpn-02-remote-vtep-unreachable"
