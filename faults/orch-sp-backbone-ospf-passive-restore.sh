#!/bin/bash
echo "[RESTORE] Removing passive from p5 eth1"
docker exec clab-multi-site-fabric-p5 cli -c "configure exclusive; delete protocols ospf area 0.0.0.0 interface eth1 passive; commit; exit" && echo "[RESTORE] Done"