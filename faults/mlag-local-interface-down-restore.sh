#!/bin/bash
echo "[RESTORE] mlag-local-interface-down on dc1-leaf2b"
docker exec clab-multi-site-fabric-dc1-leaf2b Cli -c "enable
configure
interface Vlan4094
no shutdown
write memory
end" && echo "[RESTORE] Done — mlag-local-interface-down"
