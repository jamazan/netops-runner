#!/bin/bash
echo "[INJECT] noisy-multi-symptom-ospf-cascade on p1"
docker exec clab-multi-site-fabric-p1 cli -c "configure
set protocols ospf area 0.0.0.0 interface eth2 passive
commit
exit" && echo "[INJECT] Done — p1-p2 OSPF adj drops, LDP tears down, MPLS labels lost"
