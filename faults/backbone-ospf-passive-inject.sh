#!/bin/bash
echo "[INJECT] Setting p5 eth1 (toward rr1) as OSPF passive"
docker exec clab-multi-site-fabric-p5 cli -c "configure exclusive; set protocols ospf area 0.0.0.0 interface eth1 passive; commit; exit" && echo "[INJECT] Done — p5/rr1 OSPF adjacency will drop, rr1 loopback unreachable"