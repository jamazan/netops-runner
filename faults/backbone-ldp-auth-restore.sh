#!/bin/bash
echo "[RESTORE] Removing LDP auth key on p1 session to p5"
docker exec clab-multi-site-fabric-p1 cli -c "configure exclusive; delete protocols ldp session 10.255.0.5 authentication-key; commit; exit" && echo "[RESTORE] Done"