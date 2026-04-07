#!/bin/bash
echo "[INJECT] mlag-local-interface-down on dc1-leaf2b"
docker exec clab-multi-site-fabric-dc1-leaf2b Cli -c "enable
configure
interface Vlan4094
shutdown
write memory
end" && echo "[INJECT] Done — mlag-local-interface-down"
