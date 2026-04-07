#!/bin/bash
echo "[INJECT] Multi-Adjacency Drop — dc1-spine1 All Leaf Uplinks"
docker exec clab-multi-site-fabric-dc1-spine1 Cli -p 15 -c "enable
configure
interface Ethernet1
shutdown
interface Ethernet2
shutdown
interface Ethernet3
shutdown
interface Ethernet4
shutdown
end
write memory" && echo "[INJECT] Done — evpn-04-cp-cpu-spike-adjacency"
