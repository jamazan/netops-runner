#!/bin/bash
echo "[INJECT] Orphan Port — Po24 on dc1-leaf1a Only"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
interface Port-Channel24
description srv-db-04 ORPHAN
switchport access vlan 11
mlag 24
end
write memory" && echo "[INJECT] Done — evpn-13-orphan-port-symptom"
