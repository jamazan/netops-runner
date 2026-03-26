#!/bin/bash
echo "[INJECT] Setting p1 eth2 (toward p2) as OSPF passive"
docker exec clab-multi-site-fabric-p1 cli -c "configure exclusive; set protocols ospf area 0.0.0.0 interface eth2 passive; commit; exit" && echo "[INJECT] Done — p1/p2 OSPF adjacency will drop"
