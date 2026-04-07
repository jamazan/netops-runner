#!/bin/bash
echo "[RESTORE] Orphan Port — Po24 on dc1-leaf1a Only"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
interface Port-Channel24
no mlag 24
no description
end
write memory" && echo "[RESTORE] Done — evpn-13-orphan-port-symptom"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
no interface Port-Channel24
end
write memory"
