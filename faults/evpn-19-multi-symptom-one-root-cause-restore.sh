#!/bin/bash
echo "[RESTORE] Multi-Symptom Cascade — dc1-leaf2a Ethernet1 Maintenance"
docker exec clab-multi-site-fabric-dc1-leaf2a Cli -p 15 -c "enable
configure
interface Ethernet1
no shutdown
end
write memory" && echo "[RESTORE] Done — evpn-19-multi-symptom-one-root-cause"
