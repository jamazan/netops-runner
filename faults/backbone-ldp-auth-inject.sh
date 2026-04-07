#!/bin/bash
echo "[INJECT] Adding wrong LDP auth key on p1 session to p5"
docker exec clab-multi-site-fabric-p1 cli -c "configure exclusive; set protocols ldp session 10.255.0.5 authentication-key WRONGKEY123; commit; exit" && echo "[INJECT] Done — p1 to p5 LDP session will drop on next hello"