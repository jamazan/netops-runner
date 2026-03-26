#!/bin/bash
echo "[INJECT] Setting OSPF cost 1000 on pe1 eth1 (toward p1)"
docker exec clab-multi-site-fabric-pe1 cli -c "configure exclusive; set protocols ospf area 0.0.0.0 interface eth1 metric 1000; commit; exit" && echo "[INJECT] Done — pe1 will prefer eth2 path, causing suboptimal routing"