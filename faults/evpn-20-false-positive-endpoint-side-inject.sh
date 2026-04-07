#!/bin/bash
echo "[INJECT] False-Positive Endpoint — Fabric Healthy, Host Silent (OS Upgrade)"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
interface Ethernet9
shutdown
end
write memory" && echo "[INJECT] Done — evpn-20-false-positive-endpoint-side"
