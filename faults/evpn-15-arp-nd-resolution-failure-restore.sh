#!/bin/bash
echo "[RESTORE] ARP Resolution Failure — Host Silent on dc1-leaf2b"
docker exec clab-multi-site-fabric-dc1-leaf2b Cli -p 15 -c "enable
configure
interface Ethernet8
no shutdown
end
write memory" && echo "[RESTORE] Done — evpn-15-arp-nd-resolution-failure"
