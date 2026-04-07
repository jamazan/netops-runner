#!/bin/bash
echo "[INJECT] Remote MAC Not Learned — RT Import Broken VNI 10011 on dc1-leaf1a"
docker exec clab-multi-site-fabric-dc1-leaf1a Cli -p 15 -c "enable
configure
router bgp 65101
vlan 11
no route-target both 10011:10011
route-target export 10011:10011
route-target import 10011:77777
end
write memory" && echo "[INJECT] Done — evpn-14-host-not-learning-remote-mac"
