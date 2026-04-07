#!/bin/bash
echo "[INJECT] ARP Resolution Failure — Host Silent on dc1-leaf2b"
docker exec clab-multi-site-fabric-dc1-leaf2b Cli -p 15 -c "enable
configure
interface Ethernet8
shutdown
end
write memory" && echo "[INJECT] Done — evpn-15-arp-nd-resolution-failure"
