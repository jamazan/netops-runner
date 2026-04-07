#!/bin/bash
echo "[RESTORE] mlag-peer-link-shutdown on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -c "enable
configure
interface Port-Channel3
no shutdown
write memory
end" && echo "[RESTORE] Done — mlag-peer-link-shutdown"
