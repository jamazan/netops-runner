#!/bin/bash
echo "[RESTORE] Multi-Adjacency Drop — dc1-spine1 All Leaf Uplinks"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -p 15 -c "enable
configure
interface Ethernet1
no shutdown
interface Ethernet2
no shutdown
interface Ethernet3
no shutdown
interface Ethernet4
no shutdown
end
write memory" && echo "[RESTORE] Done — evpn-04-cp-cpu-spike-adjacency"
